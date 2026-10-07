const fetch = require("node-fetch");

// ------------------------------------------------------------------
// Wind provider chain: WU PWS (keyed) → Weathercloud (keyless,
// unofficial endpoints) → Open-Meteo model fallback.
// Suggest-only data for the session wind dial; sessions freeze the
// chosen value. 10-min server cache (quota + politeness).
// ------------------------------------------------------------------

const MS_TO_KN = 1.94384;
const MPH_TO_KN = 0.868976;
const MAX_DIST_KM = 15;
const WC_MAX_AGE_MIN = 15;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const UA = "IndietroTutta-backend/1.0 (+https://indietrotutta.onrender.com)";

const cache = new Map(); // "lat,lon" (rounded) -> { at, data }

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

const round1 = n => (typeof n === "number" && isFinite(n) ? Math.round(n * 10) / 10 : null);

async function fetchJson(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        timeout: FETCH_TIMEOUT_MS,
        headers: { "User-Agent": UA, ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split("?")[0]}`);
    return res.json();
}

// --- 1. Weather Underground PWS (needs WU_API_KEY) ----------------
async function wuWind(lat, lon) {
    const key = process.env.WU_API_KEY;
    if (!key) return null;
    const near = await fetchJson(
        `https://api.weather.com/v3/location/near?geocode=${lat},${lon}&product=pws&format=json&apiKey=${encodeURIComponent(key)}`
    );
    const loc = near && near.location;
    if (!loc || !Array.isArray(loc.stationIdentifier)) return null;
    const n = Math.min(3, loc.stationIdentifier.length);
    for (let i = 0; i < n; i++) {
        const id = loc.stationIdentifier[i];
        const slat = Number(loc.latitude && loc.latitude[i]);
        const slon = Number(loc.longitude && loc.longitude[i]);
        if (!isFinite(slat) || !isFinite(slon)) continue;
        if (haversineKm(lat, lon, slat, slon) > MAX_DIST_KM) continue;
        try {
            const obs = await fetchJson(
                `https://api.weather.com/v2/pws/observations/current?stationId=${encodeURIComponent(id)}&format=json&units=e&apiKey=${encodeURIComponent(key)}`
            );
            const o = obs && obs.observations && obs.observations[0];
            if (!o || typeof o.winddir !== "number") continue;
            if (o.qcStatus !== undefined && o.qcStatus !== null && o.qcStatus !== 1) continue;
            const imp = o.imperial || {};
            const ageMin = (Date.now() - new Date(o.obsTimeUtc).getTime()) / 60000;
            return {
                dir: Math.round(o.winddir) % 360,
                speedKn: round1(imp.windSpeed * MPH_TO_KN),
                gustKn: imp.windGust != null ? round1(imp.windGust * MPH_TO_KN) : null,
                source: `pws:WU:${o.stationID || id}`,
                stationId: String(o.stationID || id),
                distKm: round1(haversineKm(lat, lon, slat, slon)),
                ageMin: round1(ageMin),
                at: new Date().toISOString(),
            };
        } catch {
            continue; // try next station
        }
    }
    return null;
}

// --- 2. Weathercloud (unofficial app endpoints, keyless) ------------
const WC = "https://app.weathercloud.net";
const wcHeaders = { "X-Requested-With": "XMLHttpRequest" };

async function wcWind(lat, lon) {
    const list = await fetchJson(
        `${WC}/page/coordinates/latitude/${lat}/longitude/${lon}/distance/${MAX_DIST_KM}`,
        { headers: wcHeaders }
    );
    const raw = Array.isArray(list) ? list : (list && Array.isArray(list.devices) ? list.devices : []);
    const arr = raw
        // no status field on this endpoint — update (seconds since last
        // report) is the online check; accept devices + METARs
        .filter(s => s && (s.type === "device" || s.type === "metar") && s.code)
        .map(s => ({
            code: s.code,
            metar: s.type === "metar",
            slat: Number(s.latitude),
            slon: Number(s.longitude),
            updateSec: Number(s.update),
            dist: haversineKm(lat, lon, Number(s.latitude), Number(s.longitude)),
        }))
        .filter(s => isFinite(s.dist) && s.dist <= MAX_DIST_KM && !(s.updateSec > WC_MAX_AGE_MIN * 60))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3);
    for (const s of arr) {
        try {
            const v = await fetchJson(`${WC}/${s.metar ? "metar" : "device"}/values?code=${encodeURIComponent(s.code)}`, {
                headers: wcHeaders,
            });
            if (!v || typeof v.epoch !== "number") continue;
            const ageMin = Math.max(0, (Date.now() / 1000 - v.epoch) / 60);
            if (ageMin > WC_MAX_AGE_MIN) continue;
            const dir = v.wdiravg != null ? v.wdiravg : v.wdir;
            const spd = v.wspdavg != null ? v.wspdavg : v.wspd;
            if (typeof dir !== "number" || typeof spd !== "number") continue;
            return {
                dir: Math.round(dir) % 360,
                speedKn: round1(spd * MS_TO_KN),
                gustKn: v.wspdhi != null ? round1(v.wspdhi * MS_TO_KN) : null,
                source: s.metar ? `metar:WC:${s.code}` : `pws:WC:${s.code}`,
                stationId: String(s.code),
                distKm: round1(s.dist),
                ageMin: round1(ageMin),
                at: new Date().toISOString(),
            };
        } catch {
            continue; // try next station
        }
    }
    return null;
}

// --- 3. Open-Meteo model fallback (keyless) --------------------------
async function modelWind(lat, lon) {
    const j = await fetchJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms`
    );
    const c = j && j.current;
    if (!c || typeof c.wind_direction_10m !== "number" || typeof c.wind_speed_10m !== "number") {
        throw new Error("model gave no wind");
    }
    return {
        dir: Math.round(c.wind_direction_10m) % 360,
        speedKn: round1(c.wind_speed_10m * MS_TO_KN),
        gustKn: typeof c.wind_gusts_10m === "number" ? round1(c.wind_gusts_10m * MS_TO_KN) : null,
        source: "model:open-meteo",
        stationId: null,
        distKm: null,
        ageMin: 0,
        at: new Date().toISOString(),
    };
}

// --- Public: chained lookup with cache --------------------------------
async function getWind(lat, lon) {
    const key = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.data, cached: true };

    const wu = await wuWind(lat, lon).catch(() => null);
    if (wu) {
        cache.set(key, { at: Date.now(), data: wu });
        return wu;
    }
    const wc = await wcWind(lat, lon).catch(() => null);
    if (wc) {
        cache.set(key, { at: Date.now(), data: wc });
        return wc;
    }
    const model = await modelWind(lat, lon); // throws → 502
    cache.set(key, { at: Date.now(), data: model });
    return model;
}

module.exports = { getWind };

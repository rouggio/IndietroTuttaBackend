const express = require("express");

const {
    getPointCount,
    getLatestPoint
} = require("../store/gpsStore");

const {
    upsertDevice
} = require("../store/deviceStore");

const {
    getActiveSessionForDevice
} = require("../store/sessionStore");

const {
    getWind
} = require("../store/wind");

const router = express.Router();

// --------------------------------------------------
// Venue wind piggyback
// --------------------------------------------------

// The boat's last stored position feeds the same provider chain as
// GET /wind (10-min cache there) so the device compass shows wind even
// with no session assigned. Stale-while-revalidate per device: heartbeats
// always answer instantly with the cached value; the chain is re-run
// only when the value is older than 10 min, the boat drifted >2 km from
// the cached position, or nothing was cached yet (first poll may wait).
const WIND_TTL_MS = 10 * 60 * 1000;
const WIND_MOVE_KM = 2;
const windCache = new Map();    // deviceId -> { at, lat, lon, wind }
const windInflight = new Map(); // deviceId -> Promise<wind|null>

function distKm(lat1, lon1, lat2, lon2) {
    const dLa = ((lat2 - lat1) * Math.PI) / 180;
    const dLo = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLa / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function venueWind(deviceId) {
    try {
        const p = await getLatestPoint(deviceId);
        const lat = p ? Number(p.lat) : NaN;
        const lon = p ? Number(p.lon) : NaN;
        if (!isFinite(lat) || !isFinite(lon)) return null;

        const c = windCache.get(deviceId);
        if (c && Date.now() - c.at < WIND_TTL_MS && distKm(c.lat, c.lon, lat, lon) < WIND_MOVE_KM) {
            return c.wind;
        }

        if (windInflight.has(deviceId)) {
            return c ? c.wind : await windInflight.get(deviceId);
        }
        const job = (async () => {
            const w = await getWind(lat, lon);
            const wind = w && isFinite(w.dir)
                ? { dir: ((Math.round(w.dir) % 360) + 360) % 360, speed: Math.max(0, Math.round(w.speedKn || 0)) }
                : null;
            windCache.set(deviceId, { at: Date.now(), lat, lon, wind });
            return wind;
        })().catch(() => null);
        windInflight.set(deviceId, job);
        job.finally(() => windInflight.delete(deviceId));
        return c ? c.wind : await job;
    } catch {
        return null;
    }
}

// --------------------------------------------------
// GET /health
// --------------------------------------------------

// GET /health doubles as heartbeat: every poll re-registers the device
// so the backend learns the username within ~30s even without GPS.
// Also updates lastSeen for live/idle status.
router.get("/health", async (req, res) => {
    const deviceId = req.header("DeviceId");
    const username = req.header("Username");
    const firmware = req.header("Firmware-Version");

    if (deviceId) {
        await upsertDevice(deviceId, { username, firmware, ip: req.ip });
    }

    // NOTE: no storedPoints here — COUNT(*) per heartbeat cost a full
    // extra Turso round trip on the hottest endpoint (5s live poll).

    // Race push: assigned session (geometry + start) rides the heartbeat.
    // Null when the device has no scheduled/live session.
    let session = null;
    try {
        session = await getActiveSessionForDevice(deviceId);
    } catch (e) {
        session = null;
    }

    // Venue wind rides too (null when the boat has no stored position or
    // every provider failed). Device gives the session wind priority.
    const wind = deviceId ? await venueWind(deviceId) : null;

    res.json({
        status: "ok",
        deviceId: deviceId || null,
        heartbeat: !!deviceId,
        serverTime: new Date().toISOString(),
        session,
        wind,
    });
});

// POST /health alias for devices that prefer POST as heartbeat
router.post("/health", async (req, res) => {
    const deviceId = req.header("DeviceId") || req.body?.deviceId;
    const username = req.header("Username") || req.body?.username;
    const firmware = req.header("Firmware-Version") || req.body?.firmware || req.body?.fw;
    if (deviceId) await upsertDevice(deviceId, { username, firmware, ip: req.ip });
    const count = await getPointCount();
    res.json({ status: "ok", storedPoints: count, deviceId: deviceId || null, heartbeat: !!deviceId, serverTime: new Date().toISOString() });
});

module.exports = router;
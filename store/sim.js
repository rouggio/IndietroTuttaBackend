const { getSession } = require("./sessionStore");

// ------------------------------------------------------------------
// Scripted sim runs (in-memory test rig — lost on restart, by design).
// Compiles a 1Hz position script off a session's RESOLVED geometry:
// hold behind the line → cross at the gun → marks in order (gate pairs
// collapse to a near-buoy crossing; single marks aim off-center on the
// required side — rounding means passing on one side, no laps) → finish.
// Legs sail long single-tack boards; delivery is wall-clock stateless:
// idx = elapsed seconds since start.
// ------------------------------------------------------------------

const KN_TO_MS = 0.514444;
const DEG_M = 111320;

const runs = new Map(); // runId -> run
let runSeq = 1;
const MAX_RUNS = 20;

// Boards for a leg: upwind legs tack, downwind legs gybe (exactly one long
// tack); reaches and short hops sail direct. Boards sit ~45° off the wind,
// northbound/southbound legs opening on opposite sides so beats and runs
// separate. Legs ENDING at a gate crossing sail straight: a gate approach
// is a precision run, and boards swinging ±h would clip buoy circles from
// off-sides, scoring the pass on board geometry instead of the cross.
// Returns [a, ...mids, b].
function tackPoints(a, b, windDir, legIdx, straight) {
    const L = distM(a, b);
    if (L < 60 || straight) return [a, b];
    let off = Math.abs(bearing(a, b) - windDir) % 360;
    if (off > 180) off = 360 - off;
    const up = off < 60, down = off > 120;
    if (!up && !down) return [a, b];
    const T = (up ? 45 : 40) * Math.PI / 180;
    // Minimal tacks, kept long: exactly one per beating/running leg.
    // Northbound and southbound legs open on opposite sides so beats and
    // runs separate instead of painting over each other.
    const n = 1;
    const h = (L / (2 * (n + 1))) * Math.tan(T);
    const rb = bearing(a, b) * Math.PI / 180;
    const ux = Math.sin(rb), uy = Math.cos(rb); // along-track (E,N)
    const nx = Math.cos(rb), ny = -Math.sin(rb); // right of course (E,N)
    const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    let side = rb * 180 / Math.PI < 180 ? 1 : -1;
    const pts = [a];
    for (let k = 1; k <= n; k++) {
        const f = k / (n + 1);
        const E = f * L * ux + side * h * nx;
        const N = f * L * uy + side * h * ny;
        pts.push({
            lat: a.lat + N / DEG_M,
            lon: a.lon + E / (DEG_M * cosLat),
        });
        side = -side;
    }
    pts.push(b);
    return pts;
}

// Deterministic LCG so replays are identical.
function lcg(seed) {
    let s = (seed >>> 0) || 1;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
function gauss(rng) {
    const u = Math.max(rng(), 1e-9), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function distM(a, b) {
    const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const dx = (b.lon - a.lon) * DEG_M * cosLat;
    const dy = (b.lat - a.lat) * DEG_M;
    return Math.hypot(dx, dy);
}
function bearing(a, b) {
    const r = Math.PI / 180;
    const dLon = (b.lon - a.lon) * r;
    const y = Math.sin(dLon) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) -
        Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(dLon);
    return ((Math.atan2(y, x) / r) + 360) % 360;
}
function destPt(p, brgDeg, dM) {
    const r = brgDeg * Math.PI / 180;
    const dLat = (dM * Math.cos(r)) / DEG_M;
    const dLon = (dM * Math.sin(r)) / (DEG_M * Math.cos(p.lat * Math.PI / 180));
    return { lat: p.lat + dLat, lon: p.lon + dLon };
}
function segCenter(seg) {
    return { lat: (seg.latA + seg.latB) / 2, lon: (seg.lonA + seg.lonB) / 2 };
}
function effectiveFinish(session) {
    if (session.finishLine && session.finishLine.sameAs === "start") return session.startLine;
    return session.finishLine;
}

// Ordered waypoints the script sails through.
function scriptWaypoints(session) {
    const gates = {};
    session.marks.forEach(m => {
        if (m.type === "gate" && m.gate) {
            (gates[m.gate] = gates[m.gate] || []).push(m);
        }
    });
    // Walk marks in order, collapsing gate pairs to pair centers.
    const ordered = [];
    const seenGate = new Set();
    if (session.startLine) ordered.push({ ...segCenter(session.startLine), kind: "line" });
    session.marks.forEach(m => {
        if (m.type === "gate" && m.gate) {
            if (seenGate.has(m.gate)) return;
            seenGate.add(m.gate);
            const pair = (gates[m.gate] || []);
            if (pair.length === 2) {
                // Cross the gate line near the first buoy (a real rounding,
                // not a center drive-through): 30% across, but never more
                // than ~18m off the buoy, so wide gates still enter the
                // circle and the device scores the pass. The buoy is kept
                // so the script can loop it (see gateLoop).
                const wdt = Math.max(1, distM(pair[0], pair[1]));
                const f = Math.min(0.3, 18 / wdt);
                ordered.push({
                    lat: pair[0].lat + (pair[1].lat - pair[0].lat) * f,
                    lon: pair[0].lon + (pair[1].lon - pair[0].lon) * f,
                    kind: "gate",
                    buoy: { lat: pair[0].lat, lon: pair[0].lon, r: pair[0].r || 30 },
                });
            } else {
                pair.forEach(q => ordered.push({ lat: q.lat, lon: q.lon, kind: "gate" }));
            }
        } else {
            ordered.push({ lat: m.lat, lon: m.lon, kind: m.type, r: m.r, side: m.side });
        }
    });
    const fin = effectiveFinish(session);
    if (fin && session.startLine && fin === session.startLine) {
        // shared finish: line center already at both ends — append once
        ordered.push({ ...segCenter(session.startLine), kind: "finish" });
    } else if (fin) {
        ordered.push({ ...segCenter(fin), kind: "finish" });
    }
    return ordered;
}

function compileScript(session, { speedKn = 8, startInSec = 60, nowMs = Date.now() } = {}) {
    const v = Math.max(1, Math.min(15, Number(speedKn) || 8)) * KN_TO_MS; // m/s
    const wps = scriptWaypoints(session);
    if (wps.length < 2) throw Object.assign(new Error("session has no sailable route"), { status: 400 });

    // Gun: session startTime when sensibly future, else soon.
    let gunMs = nowMs + Math.max(30, (Number(startInSec) || 60)) * 1000;
    if (session.startTime) {
        const st = new Date(session.startTime).getTime();
        if (!isNaN(st) && st > nowMs + 15000) gunMs = st;
    }
    const startMs = nowMs;
    // Pre-start: hold 100m behind the line (opposite the first leg), then
    // approach to cross ~3s after the gun.
    const line = wps[0];
    const firstLegBrg = bearing(line, wps[1]);
    const hold = destPt(line, (firstLegBrg + 180) % 360, 100);
    const approachDist = distM(hold, line);
    const approachT = approachDist / v;
    const crossAt = (gunMs + 3000 - startMs) / 1000; // seconds, script time
    const departAt = Math.max(2, crossAt - approachT);

    const rng = lcg(Math.floor(nowMs / 1000) + wps.length * 7919);
    const samples = [];
    // Roundings included: marks aim off-center (side-honored), arcs turn
    // around each buoy until heading to the next (spec §rounding).
    const route = expandRoundings(offsetRoundings(wps));
    const pushLeg = (a, b, t0) => {
        const L = distM(a, b);
        const dur = Math.max(1, L / v);
        const brg = bearing(a, b);
        const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
        const steps = Math.ceil(dur);
        for (let i = 0; i <= steps; i++) {
            const t = t0 + (i / Math.max(1, steps)) * dur;
            const f = i / Math.max(1, steps);
            const baseLat = a.lat + (b.lat - a.lat) * f;
            const baseLon = a.lon + (b.lon - a.lon) * f;
            // gentle GPS-level wander (±1.5m) + speed breathing ±15%.
            // (Bigger jitter made 1Hz tracks look drunk: steps are ~2.6m.)
            const nx = gauss(rng) * 1.5, ny = gauss(rng) * 1.5;
            samples.push({
                t: Math.round(t),
                lat: baseLat + (ny / DEG_M),
                lon: baseLon + (nx / (DEG_M * cosLat)),
                speed: Math.max(0.5, v / KN_TO_MS * (1 + 0.15 * Math.sin(t / 20) + gauss(rng) * 0.03)),
                course: ((brg + gauss(rng) * 1) % 360 + 360) % 360,
            });
        }
        return t0 + dur;
    };

    // Hold phase (1Hz jitter around the hold point).
    for (let t = 0; t < departAt; t++) {
        samples.push({
            t,
            lat: hold.lat + gauss(rng) * 1 / DEG_M,
            lon: hold.lon + gauss(rng) * 1 / (DEG_M * Math.cos(hold.lat * Math.PI / 180)),
            speed: 0.4 + Math.abs(gauss(rng)) * 0.2,
            course: (firstLegBrg + gauss(rng) * 3 + 360) % 360,
        });
    }
    // Boards: the hold→line approach stays direct (timed gun cross);
    // course legs tack/gybe, except gate approaches which run straight in.
    const sailed = [route[0]];
    for (let i = 0; i + 1 < route.length; i++) {
        const boards = tackPoints(route[i], route[i + 1], session.windDir || 0, i, route[i + 1].kind === "gate");
        for (let k = 1; k < boards.length; k++) sailed.push(boards[k]);
    }
    let t = departAt;
    t = pushLeg(hold, line, t);
    for (let i = 0; i + 1 < sailed.length; i++) t = pushLeg(sailed[i], sailed[i + 1], t);

    // Deduplicate to one sample per whole second (legs overlap on joints).
    const bySec = new Map();
    for (const s of samples) if (!bySec.has(s.t)) bySec.set(s.t, s);
    const flat = [...bySec.values()].sort((a, b) => a.t - b.t);
    return { samples: flat, gunSec: Math.round((gunMs - startMs) / 1000), durationSec: flat.length ? flat[flat.length - 1].t : 0 };
}

// Rounding clearance: aim single marks off-center (0.7r) so the track
// passes the buoy on the required side instead of spearing it — still
// inside the circle, so the device scores the pass. Honors the side
// (P: mark stays left → aim right of course; S: mirror); free sides
// alternate. Rounding means passing on one side — no laps.
function offsetRoundings(wps) {
    return wps.map((w, i) => {
        if (w.kind !== "mark" || i === 0) return w;
        const prev = wps[i - 1];
        const brg = bearing(prev, w) * Math.PI / 180;
        const nx = Math.cos(brg), ny = -Math.sin(brg); // right of course
        const r = w.r || 30;
        const c = r * 0.7;
        const s = w.side === "P" ? 1 : w.side === "S" ? -1 : i % 2 === 0 ? 1 : -1;
        const cosLat = Math.cos(w.lat * Math.PI / 180);
        return {
            ...w,
            cx: w.lat, cy: w.lon, // true center (arcs need it)
            lat: w.lat + ((s * c * ny) / DEG_M),
            lon: w.lon + ((s * c * nx) / (DEG_M * cosLat)),
        };
    });
}

// Rounding arc: turn around the buoy from the entry angle until heading
// to the next waypoint — in ONE steady rotational direction (never
// S-curves, never full circles). Sense is the mark's directive (P
// counter-clockwise = mark stays left, S clockwise); free (G) marks take
// the sense that continues the approach heading (no kink turning in).
// The arc ends where its exit tangent already points at the next waypoint,
// so the buoy falls behind and the track flows on.
function roundLoop(entry, buoy, prevWp, nextWp, side) {
    const R = (buoy.r || 30) + 20;
    const D = Math.PI / 180;
    const norm = x => ((x % 360) + 360) % 360;
    const kink = (from, to) => Math.abs(norm(to - from + 180) - 180);
    const a0 = bearing(buoy, entry);
    const hA = bearing(prevWp, entry);
    const hE = bearing(entry, nextWp); // exit leg compass bearing
    let sweep; // +CW, -CCW, degrees, always < 360
    if (side === "S") {
        sweep = norm(hE - 90 - a0);
    } else if (side === "P") {
        sweep = -norm(a0 - (hE + 90));
    } else if (kink(hA, a0 + 90) <= kink(hA, a0 - 90)) {
        sweep = norm(hE - 90 - a0);
    } else {
        sweep = -norm(a0 - (hE + 90));
    }
    const a0r = a0 * D, swr = sweep * D;
    const N = Math.max(2, Math.round(Math.abs(sweep) / 30));
    const cosLat = Math.cos(buoy.lat * Math.PI / 180);
    const pts = [];
    for (let k = 1; k <= N; k++) {
        const a = a0r + (swr * k) / N;
        pts.push({
            lat: buoy.lat + (R * Math.cos(a)) / DEG_M,
            lon: buoy.lon + (R * Math.sin(a)) / (DEG_M * cosLat),
        });
    }
    return pts;
}

// Splice rounding arcs at every mark and gate crossing (pass-bys get a
// small bend, turnarounds a wide one — same rule). Arcs need the legs on
// both sides (approach sets the entry, next sets the exit tangent), so the
// previous waypoint rides along.
function expandRoundings(wps) {
    const out = [];
    for (let i = 0; i < wps.length; i++) {
        const w = wps[i];
        out.push(w);
        if (i + 1 >= wps.length) continue;
        const prev = i > 0 ? wps[i - 1] : w;
        const gate = w.kind === "gate" && w.buoy;
        const single = w.kind === "mark" && w.cx !== undefined;
        if (!gate && !single) continue;
        const buoy = gate ? w.buoy : { lat: w.cx, lon: w.cy, r: w.r };
        for (const p of roundLoop(w, buoy, prev, wps[i + 1], gate ? "G" : w.side)) {
            out.push({ ...p, kind: gate ? "gate-loop" : "mark-loop" });
        }
    }
    return out;
}

async function createRun({ sessionId, deviceId, speedKn, startInSec }) {
    const session = await getSession(sessionId);
    if (!session) throw Object.assign(new Error("session not found"), { status: 404 });
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        throw Object.assign(new Error("deviceId required"), { status: 400 });
    }
    const nowMs = Date.now();
    const { samples, gunSec, durationSec } = compileScript(session, { speedKn, startInSec, nowMs });
    if (runs.size >= MAX_RUNS) {
        const oldest = [...runs.keys()][0];
        runs.delete(oldest);
    }
    const id = `sim-${Date.now().toString(36)}-${(runSeq++).toString(36)}`;
    const run = {
        id, deviceId: deviceId.trim(), sessionId: session.id,
        createdMs: nowMs, startMs: nowMs, gunMs: nowMs + gunSec * 1000,
        speedKn: Math.max(1, Math.min(15, Number(speedKn) || 5)),
        samples, gunSec, durationSec,
        echoes: [], // device-reported receipts {t,lat,lon,speed,course,at}
    };
    runs.set(id, run);
    return runMeta(run, nowMs);
}

function runMeta(run, nowMs = Date.now()) {
    const elapsed = Math.max(0, Math.floor((nowMs - run.startMs) / 1000));
    const echoes = run.echoes || [];
    const lastEcho = echoes.length ? echoes[echoes.length - 1] : null;
    let lastDevM = null;
    if (lastEcho && run.samples.length) {
        let best = run.samples[0], bd = Infinity;
        for (const s of run.samples) {
            const d = Math.abs(s.t - lastEcho.t);
            if (d < bd) { bd = d; best = s; }
        }
        lastDevM = Math.round(distM(best, lastEcho));
    }
    return {
        id: run.id, deviceId: run.deviceId, sessionId: run.sessionId,
        createdMs: run.createdMs, startMs: run.startMs, gunMs: run.gunMs,
        speedKn: run.speedKn, samples: run.samples.length,
        gunSec: run.gunSec, durationSec: run.durationSec,
        elapsedSec: elapsed,
        done: elapsed >= run.durationSec,
        echoCount: echoes.length,
        lastEchoT: lastEcho ? lastEcho.t : null,
        lastDevM,
    };
}

function pruneRuns(nowMs = Date.now()) {
    for (const [id, r] of runs) {
        if (nowMs - r.startMs > (r.durationSec + 600) * 1000) runs.delete(id);
    }
}

function getRun(id) {
    return runs.get(id) || null;
}

function listRuns(sessionId) {
    pruneRuns();
    return [...runs.values()]
        .filter(r => !sessionId || String(r.sessionId) === String(sessionId))
        .sort((a, b) => b.createdMs - a.createdMs)
        .map(r => runMeta(r));
}

function deleteRun(id) {
    return runs.delete(id);
}

// Device-reported receipt of a scripted fix (pipeline proof, never a track).
// Kept last-300 per run; deviation measured against the script at echo time.
function echoSample(runId, e) {
    const run = runs.get(runId);
    if (!run) return null;
    const echo = {
        t: Math.round(Number(e.t) || 0),
        lat: Number(e.lat), lon: Number(e.lon),
        speed: Number(e.speed) || 0, course: Number(e.course) || 0,
        at: Date.now(),
    };
    if (!isFinite(echo.lat) || !isFinite(echo.lon)) return null;
    run.echoes.push(echo);
    if (run.echoes.length > 300) run.echoes.splice(0, run.echoes.length - 300);
    return runMeta(run);
}

// Wall-clock stateless delivery: sample = elapsed seconds since start.
function nextSample(run, nowMs = Date.now()) {
    const idx = Math.floor((nowMs - run.startMs) / 1000);
    if (idx < 0) return { ...(run.samples[0] || {}), t: 0, remaining: run.durationSec, done: false };
    if (idx >= run.samples.length) {
        const last = run.samples[run.samples.length - 1] || {};
        return { ...last, t: run.durationSec, remaining: 0, done: true };
    }
    const s = run.samples[idx];
    return { ...s, remaining: Math.max(0, run.durationSec - s.t), done: false };
}

function activeRunForDevice(deviceId, nowMs = Date.now()) {
    pruneRuns(nowMs);
    let best = null;
    for (const r of runs.values()) {
        if (r.deviceId !== deviceId) continue;
        const elapsed = (nowMs - r.startMs) / 1000;
        if (elapsed > r.durationSec + 600) continue;
        if (!best || r.createdMs > best.createdMs) best = r;
    }
    return best;
}

module.exports = {
    createRun, getRun, listRuns, deleteRun, echoSample, nextSample, activeRunForDevice, runMeta,
    compileScript, // exported for unit checks
    wanderSample, wanderAnchorFor, setPushedAnchor,
};

// ------------------------------------------------------------------
// Server-driven wander: mock GPS with no scripted run. Per-device
// random-walk state (6kn ± 2, ±15° helm) that advances on every poll,
// so the committee can later steer it. The walk is NEVER session- or
// track-bound (it's not in a race):
// - pushed viewport anchor fresh → walk around it (500m steer-home leash);
// - no pushed anchor → totally random walk from the last position
//   (no leash, no box, no recentering);
// - no walk state yet and no anchor → null (caller 404s, device holds).
// In-memory like the runs (lost on restart, by design).
// ------------------------------------------------------------------

const WANDER_KN = 6;
const WANDER_LEASH_M = 500;
const WANDER_RESEED_M = 750; // pushed anchor jumped further → fresh walk
const WANDER_MIN_KN = 4; // wander speed breathes between 4 and 13kn
const WANDER_MAX_KN = 13;
const wanders = new Map(); // deviceId -> { aLat,aLon,lat,lon,head,spd,t,free }

async function wanderAnchorFor(deviceId) {
    // Map center pushed by the frontend (viewport = intent). Refreshing
    // the page re-pushes the current center. Null when the browser is
    // gone — the walk then goes free (see wanderSample).
    if (!deviceId) return null;
    return pushedAnchor();
}

// Frontend-pushed viewport anchor (global: the map has one center).
// Fresh 5 min; the page re-pushes on load, on pan (debounced) and
// every minute as keep-alive.
let pushed = null; // { lat, lon, at }
const PUSHED_TTL_MS = 5 * 60 * 1000;

function setPushedAnchor(lat, lon) {
    pushed = { lat, lon, at: Date.now() };
    return pushed;
}

function pushedAnchor() {
    if (!pushed) return null;
    if (Date.now() - pushed.at > PUSHED_TTL_MS) { pushed = null; return null; }
    return { lat: pushed.lat, lon: pushed.lon };
}

function wanderSample(deviceId, anchor, nowMs = Date.now()) {
    let s = wanders.get(deviceId);
    if (!s) {
        // Nothing to walk from: seed at the pushed anchor, else null
        // (caller 404s, device holds) until the browser pushes one.
        if (!anchor) return null;
        s = {
            aLat: anchor.lat, aLon: anchor.lon,
            lat: anchor.lat, lon: anchor.lon,
            head: Math.random() * 360, spd: WANDER_KN, t: nowMs,
            free: false,
        };
        wanders.set(deviceId, s);
    } else if (anchor && distM(s, anchor) > WANDER_RESEED_M) {
        // Viewport jumped far: fresh walk at the new center.
        s.aLat = anchor.lat; s.aLon = anchor.lon;
        s.lat = anchor.lat; s.lon = anchor.lon;
        s.head = Math.random() * 360; s.spd = WANDER_KN; s.t = nowMs;
        s.free = false;
    }
    if (anchor) {
        // Anchored mode: adopt the pushed center, steer home past the leash.
        s.aLat = anchor.lat; s.aLon = anchor.lon;
        s.free = false;
    } else {
        // Browser gone: totally random walk from the last position —
        // heading and speed keep breathing, nothing recenters or clamps.
        s.free = true;
    }
    const dt = Math.min(Math.max((nowMs - s.t) / 1000, 0), 30);
    s.t = nowMs;
    const cosLat = Math.cos((s.lat * Math.PI) / 180);
    if (!s.free) {
        const dx = (s.lon - s.aLon) * DEG_M * cosLat;
        const dy = (s.lat - s.aLat) * DEG_M;
        if (dx * dx + dy * dy > WANDER_LEASH_M * WANDER_LEASH_M) {
            s.head = bearing(s, { lat: s.aLat, lon: s.aLon });
        } else {
            s.head = (s.head + (Math.random() * 30 - 15) + 360) % 360;
        }
    } else {
        s.head = (s.head + (Math.random() * 30 - 15) + 360) % 360;
    }
    // Speed breathes: smooth random walk around 6kn, clamped to 4..8.
    s.spd = Math.min(WANDER_MAX_KN, Math.max(WANDER_MIN_KN,
        (s.spd ?? WANDER_KN) + (Math.random() - 0.5)));
    const step = s.spd * KN_TO_MS * dt;
    const hr = (s.head * Math.PI) / 180;
    s.lat += (step * Math.cos(hr)) / DEG_M;
    s.lon += (step * Math.sin(hr)) / (DEG_M * cosLat);
    return {
        deviceId,
        wander: true,
        free: s.free,
        serverTime: new Date(nowMs).toISOString(),
        lat: +s.lat.toFixed(7),
        lon: +s.lon.toFixed(7),
        speed: +s.spd.toFixed(1),
        course: Math.round(s.head),
        anchor: { lat: +s.aLat.toFixed(7), lon: +s.aLon.toFixed(7) },
    };
}

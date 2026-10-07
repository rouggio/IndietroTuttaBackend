const { getSession } = require("./sessionStore");

// ------------------------------------------------------------------
// Scripted sim runs (in-memory test rig — lost on restart, by design).
// Compiles a 1Hz position script off a session's RESOLVED geometry:
// hold behind the line → cross at the gun → mark centers in order
// (gate pairs collapse to pair centers) → finish center.
// Delivery is wall-clock stateless: idx = elapsed seconds since start.
// ------------------------------------------------------------------

const KN_TO_MS = 0.514444;
const DEG_M = 111320;

const runs = new Map(); // runId -> run
let runSeq = 1;
const MAX_RUNS = 20;

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
                ordered.push({
                    lat: (pair[0].lat + pair[1].lat) / 2,
                    lon: (pair[0].lon + pair[1].lon) / 2,
                    kind: "gate",
                });
            } else {
                pair.forEach(q => ordered.push({ lat: q.lat, lon: q.lon, kind: "gate" }));
            }
        } else {
            ordered.push({ lat: m.lat, lon: m.lon, kind: m.type });
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

function compileScript(session, { speedKn = 5, startInSec = 60, nowMs = Date.now() } = {}) {
    const v = Math.max(1, Math.min(15, Number(speedKn) || 5)) * KN_TO_MS; // m/s
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
            // cross-track wobble ±8m + speed breathing ±15%
            const nx = gauss(rng) * 8, ny = gauss(rng) * 8;
            samples.push({
                t: Math.round(t),
                lat: baseLat + (ny / DEG_M),
                lon: baseLon + (nx / (DEG_M * cosLat)),
                speed: Math.max(0.5, v / KN_TO_MS * (1 + 0.15 * Math.sin(t / 20) + gauss(rng) * 0.03)),
                course: ((brg + gauss(rng) * 3) % 360 + 360) % 360,
            });
        }
        return t0 + dur;
    };

    // Hold phase (1Hz jitter around the hold point).
    for (let t = 0; t < departAt; t++) {
        samples.push({
            t,
            lat: hold.lat + gauss(rng) * 3 / DEG_M,
            lon: hold.lon + gauss(rng) * 3 / (DEG_M * Math.cos(hold.lat * Math.PI / 180)),
            speed: 0.4 + Math.abs(gauss(rng)) * 0.2,
            course: (firstLegBrg + gauss(rng) * 10 + 360) % 360,
        });
    }
    let t = departAt;
    t = pushLeg(hold, line, t);
    for (let i = 0; i + 1 < wps.length; i++) t = pushLeg(wps[i], wps[i + 1], t);

    // Deduplicate to one sample per whole second (legs overlap on joints).
    const bySec = new Map();
    for (const s of samples) if (!bySec.has(s.t)) bySec.set(s.t, s);
    const flat = [...bySec.values()].sort((a, b) => a.t - b.t);
    return { samples: flat, gunSec: Math.round((gunMs - startMs) / 1000), durationSec: flat.length ? flat[flat.length - 1].t : 0 };
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
    };
    runs.set(id, run);
    return runMeta(run, nowMs);
}

function runMeta(run, nowMs = Date.now()) {
    const elapsed = Math.max(0, Math.floor((nowMs - run.startMs) / 1000));
    return {
        id: run.id, deviceId: run.deviceId, sessionId: run.sessionId,
        createdMs: run.createdMs, startMs: run.startMs, gunMs: run.gunMs,
        speedKn: run.speedKn, samples: run.samples.length,
        gunSec: run.gunSec, durationSec: run.durationSec,
        elapsedSec: elapsed,
        done: elapsed >= run.durationSec,
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
    createRun, getRun, listRuns, deleteRun, nextSample, activeRunForDevice, runMeta,
    compileScript, // exported for unit checks
};

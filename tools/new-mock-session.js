// Create a mock practice session the way the DEVICE does.
//
// Why this exists: creating a session with origin = the boat's current GPS
// puts the START LINE exactly under the boat. That is not how a start is
// laid out, and it made the boat sit inside the OCS band (CROSS_RANGE_M,
// 150m) for the whole wait, so a metre of jitter read as a crossing and the
// mock race kept starting OCS.
//
// The device's practice setup already does this properly: the line sits
// `distM` metres UPWIND of the boat, with distM the remembered prefDist
// (10/20/30m, default 30). This mirrors that exactly — the origin (where
// the line is placed) is the boat's position shifted DOWNWIND by distM, so
// the boat begins distM behind the line and approaches it on the gun.
//
// SCALE: 0.3 by default. A full-size windward-leeward is a 7-minute mock
// race and most of that is the boat sailing legs nobody is testing. A scaled
// course shortens every leg, so the same race is over in ~3 minutes. It does
// NOT shrink the pass distance: `roundingM` is real metres and the generator
// widens the shape radius to compensate (store/sim.js), because the radius
// exists so the device's 1Hz sampling can see a traverse at all.
//
// Usage:
//   node tools/new-mock-session.js [distMetres] [gunSeconds] [courseId] [windDir] [scale]
// Defaults: 30m, 70s, course 34 (Windward-Leeward), wind 45°, scale 0.3.
//
// windDir is a session-level choice, NOT a course property: courses are
// wind-frame shapes (+y = upwind) with no direction of their own, so it has
// to be supplied.
//
// Reads the boat's live position from the backend (mock boats never reach
// Turso, so it falls back to the sim-live ephemeral slot via /gps/latest).
const BASE = process.env.BACKEND || "http://localhost:3000";
const DEVICE = process.env.DEVICE_ID || "08:D1:F9:C8:4D:24";

const distM = Number(process.argv[2]) || 30;
const gunSec = Number(process.argv[3]) || 70;
const courseId = Number(process.argv[4]) || 34;
const windDirArg = Number(process.argv[5]);
// 0.3 by default: a full-size mock race is ~7 minutes and most of it is
// legs nobody is testing. Pass 1 to sail the course at real size.
const scale = Number(process.argv[6]) || 0.3;

const R = 111320;
const rad = (d) => (d * Math.PI) / 180;

async function json(path) {
    const r = await fetch(`${BASE}${path}`);
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.json();
}

(async () => {
    // Latest known fix for the boat. SIM-LIVE FIRST, deliberately: a mock
    // boat's uploads go to the ephemeral slot and never reach Turso, so
    // /gps/latest answers with whatever was last stored from the REAL
    // device days ago — anchoring the line to that would put the start
    // kilometres away from where the boat actually is.
    let lat, lon;
    try {
        // /gps/sim-live answers with an ARRAY of fixes (oldest first).
        const sim = await json(`/gps/sim-live?deviceId=${encodeURIComponent(DEVICE)}`);
        const p = Array.isArray(sim) ? sim[sim.length - 1] : sim;
        if (p && typeof p.lat === "number") { lat = p.lat; lon = p.lon; }
    } catch {}
    if (typeof lat !== "number") {
        try {
            const p = await json(`/gps/latest?deviceId=${encodeURIComponent(DEVICE)}`);
            if (p && typeof p.lat === "number") { lat = p.lat; lon = p.lon; }
        } catch {}
    }
    if (typeof lat !== "number") throw new Error("no position known for " + DEVICE);

    // Wind direction sets the course frame (+y is upwind), so the leg off
    // the line runs toward windDir; "behind the line" is the opposite.
    const wd = Number.isFinite(windDirArg) && windDirArg > 0 ? windDirArg : 45;

    const dn = (Math.sin(rad((wd + 180) % 360)) * distM) / R;
    const de = (Math.cos(rad((wd + 180) % 360)) * distM) / (R * Math.cos(rad(lat)));
    const originLat = lat + dn;
    const originLon = lon + de;

    const startTime = new Date(Date.now() + gunSec * 1000).toISOString();
    const today = new Date().toISOString().slice(0, 10);

    const body = {
        courseId,
        date: today,
        mode: "practice",
        name: `MOCK ${distM}m ${new Date().toISOString().slice(11, 19)}`,
        originLat: +originLat.toFixed(6),
        originLon: +originLon.toFixed(6),
        windDir: wd,
        scale,
        startTime,
        boats: [{ deviceId: DEVICE }],
    };

    const res = await fetch(`${BASE}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const s = await res.json();
    if (!res.ok) throw new Error(`POST /sessions -> ${res.status} ${JSON.stringify(s)}`);

    console.log(`session ${s.id}  gun ${startTime}  line ${distM}m upwind of boat  scale ${scale}`);
    console.log(`  boat   ${lat.toFixed(6)},${lon.toFixed(6)}`);
    console.log(`  origin ${originLat.toFixed(6)},${originLon.toFixed(6)} (line here)`);
    const runs = await json(`/sim/runs?sessionId=${s.id}`);
    if (runs.length) {
        console.log(`  run ${runs[0].id} ${runs[0].speedKn}kn ${runs[0].durationSec}s` +
                    ` pass ${runs[0].roundingM}m off (real)`);
    }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
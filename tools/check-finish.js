// Offline check of the scripted finish, with no device involved.
//
// Question: does the scripted boat actually CROSS the finish line, or does
// it sail to the line's centre and stop there? The device scores a finish
// as a side flip inside CROSS_RANGE_M (150m); a boat that parks ON the line
// never reaches the far side, so the flip is noise and the run can only end
// via the "past line, no clean cross" escape hatch.
//
// Usage: node tools/check-finish.js [sessionId]
//
// It recompiles a REAL session fetched from the backend. Reconstructing the
// session from a course is a trap: the course stores marks in course units,
// and guessing at the conversion yields a script with one NaN sample and a
// confident, completely wrong verdict.
const { compileScript } = require("../store/sim.js");

const sessionId = Number(process.argv[2]) || 62;

(async () => {
    const session = await (await fetch(`http://localhost:3000/sessions/${sessionId}`)).json();
    if (session.error) { console.log("no session:", session.error); return; }

    const run = compileScript(session, { speedKn: 28, startInSec: 60, nowMs: Date.now() });
    const s = run.samples;
    console.log(`session ${session.id} "${session.name}"  marks=${session.marks.length}  ` +
                `samples=${s.length}  dur=${run.durationSec}s  gunSec=${run.gunSec}`);

    const fin = session.finishLine && session.finishLine.sameAs === "start"
        ? session.startLine : session.finishLine;
    if (!fin) { console.log("no finish line — nothing to check"); return; }
    // Resolved sessions carry latA/lonA + latB/lonB (ax/ay/bx/by are still the
    // raw course units). Use the resolved pair or the maths is in the wrong
    // coordinate system entirely.
    const A = { lat: fin.latA, lon: fin.lonA };
    const B = { lat: fin.latB, lon: fin.lonB };

    const M = 111320;
    const distToSeg = (p, a, b) => {
        // equirectangular metres
        const k = Math.cos((p.lat * Math.PI) / 180);
        const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
        const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
        const L2 = bx * bx + by * by;
        let t = L2 ? (px * bx + py * by) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const dx = px - bx * t, dy = py - by * t;
        return Math.hypot(dx, dy);
    };
    const sideOf = (p, a, b) => {
        const k = Math.cos((p.lat * Math.PI) / 180);
        const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
        const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
        const cr = bx * py - by * px;
        return cr > 2 ? 1 : cr < -2 ? -1 : 0;
    };

    console.log("\nlast 24 samples (t, dist-to-finish-line m, side):");
    for (const p of s.slice(-24)) {
        console.log(`  t=${String(p.t).padStart(4)}  d=${distToSeg(p, A, B).toFixed(1).padStart(7)}m  side=${sideOf(p, A, B)}`);
    }
    const dists = s.slice(-24).map((p) => distToSeg(p, A, B));
    const sides = new Set(s.slice(-24).map((p) => sideOf(p, A, B)));
    console.log(`\nmin dist over last 24s: ${Math.min(...dists).toFixed(1)}m`);
    console.log(`sides seen in last 24s: ${[...sides].join(",")}  (need BOTH +1 and -1 to score a crossing)`);
    console.log(sides.has(1) && sides.has(-1)
        ? "VERDICT: the script does cross the finish line."
        : "VERDICT: the script never reaches the far side of the finish line.");
})();
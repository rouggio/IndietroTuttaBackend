// Check a scripted run against the rules the DEVICE scores by, offline.
//
// The device awards a mark when the boat is inside its circle, a gate when it
// is inside EITHER buoy's circle, and the finish on a side flip across the
// line while inside CROSS_RANGE_M (150m). A script that misses any of those
// produces a race that looks fine in the generator and fails on the instrument,
// and the only way to find that out otherwise is to sail it and read the
// serial.
//
// Usage: node tools/check-route.js [sessionId]
//
// It fetches a REAL session and recompiles it. Reconstructing a session from a
// course is a trap: courses store marks in course units, and a guessed
// conversion yields a script of one NaN sample and a confident wrong verdict.
const { compileScript } = require("../store/sim.js");

const CROSS_RANGE_M = 150;
const sessionId = Number(process.argv[2]) || 62;

const M = 111320;
const rad = (d) => (d * Math.PI) / 180;
const distM = (p, q) => {
    const k = Math.cos((((p.lat + q.lat) / 2) * Math.PI) / 180);
    return Math.hypot((p.lon - q.lon) * M * k, (p.lat - q.lat) * M);
};
// Side of the INFINITE line through a,b — matches the device's segSide().
const sideOf = (p, a, b) => {
    const k = Math.cos((p.lat * Math.PI) / 180);
    const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
    const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
    const cr = bx * py - by * px;
    return cr > 2 ? 1 : cr < -2 ? -1 : 0;
};
const distToSeg = (p, a, b) => {
    const k = Math.cos((p.lat * Math.PI) / 180);
    const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
    const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
    const L2 = bx * bx + by * by;
    let t = L2 ? (px * bx + py * by) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - bx * t, py - by * t);
};

(async () => {
    const res = await fetch(`http://localhost:3000/sessions/${sessionId}`);
    const session = await res.json();
    if (session.error) { console.log("no session:", session.error); return; }

    const run = compileScript(session, { speedKn: 28, startInSec: 60, nowMs: Date.now() });
    const s = run.samples;
    console.log(`session ${session.id} "${session.name}"  marks=${session.marks.length}  ` +
                `samples=${s.length}  dur=${run.durationSec}s  gunSec=${run.gunSec}\n`);

    // --- marks and gates -------------------------------------------------
    const gates = {};
    session.marks.forEach((m) => {
        if (m.type === "gate" && m.gate) (gates[m.gate] = gates[m.gate] || []).push(m);
    });
    const scored = [];
    session.marks.forEach((m, i) => {
        if (m.type === "gate" && m.gate) {
            const pair = gates[m.gate] || [];
            // The device enters a gate on EITHER buoy, so that is the bar.
            let best = Infinity, which = null;
            for (const q of pair) {
                for (const p of s) {
                    const d = distM(p, q);
                    if (d < best) { best = d; which = q; }
                }
            }
            scored.push({ label: `gate ${m.gate} (${pair.length} buoys)`, ok: best < (which.r || 30), best });
        } else {
            let best = Infinity;
            for (const p of s) { const d = distM(p, m); if (d < best) best = d; }
            scored.push({ label: `mark ${i + 1}`, ok: best < (m.r || 30), best });
        }
    });
    let fails = 0;
    for (const c of scored) {
        if (!c.ok) fails++;
        console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.label.padEnd(22)} closest approach ${c.best.toFixed(1)}m`);
    }

    // --- finish line -----------------------------------------------------
    const fin = session.finishLine && session.finishLine.sameAs === "start"
        ? session.startLine : session.finishLine;
    if (!fin) {
        console.log("\n  --   no finish line on this course");
    } else {
        const A = { lat: fin.latA, lon: fin.lonA };
        const B = { lat: fin.latB, lon: fin.lonB };
        const sides = new Set(s.map((p) => sideOf(p, A, B)));
        // The crossing must be sustained: the device needs a side flip while
        // inside the band, so a flip on the final sample is not enough.
        let sustained = false;
        for (let i = 1; i < s.length; i++) {
            if (sideOf(s[i], A, B) !== sideOf(s[i - 1], A, B) &&
                distToSeg(s[i], A, B) < CROSS_RANGE_M) {
                let after = 0;
                for (let j = i + 1; j < s.length; j++) {
                    if (sideOf(s[j], A, B) === sideOf(s[i], A, B) &&
                        distToSeg(s[j], A, B) < CROSS_RANGE_M) after++;
                }
                if (after >= 3) { sustained = true; break; }
            }
        }
        if (!sustained) fails++;
        console.log(`  ${sustained ? "ok  " : "FAIL"} finish line            ` +
                    `sides seen ${[...sides].sort().join(",")}, ` +
                    `crossing ${sustained ? "sustained inside the band" : "not sustained"}`);
        const minD = Math.min(...s.map((p) => distToSeg(p, A, B)));
        console.log(`       closest approach to the line: ${minD.toFixed(1)}m`);
    }

    console.log(`\n${fails ? fails + " PROBLEM(S)" : "route scores cleanly against the device rules"}`);
    process.exit(fails ? 1 : 0);
})();
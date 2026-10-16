// Check a scripted run against the rules the DEVICE scores by, offline.
//
// The device scores a single mark when the bearing excursion wraps past
// ~150° with the mark held on the required side (side arms at ~135°), and
// switches on the 90° triangle to the next target; a gate when the track
// threads the pair and the bearing out no longer intersects it; the finish
// on a sustained side flip across the line. A script that misses any of
// those produces a race that looks fine in the generator and fails on the
// instrument, and the only way to find that out otherwise is to sail it
// and read the serial.
//
// Usage: node tools/check-route.js [sessionId]
//
// It fetches a REAL session and recompiles it. Reconstructing a session from a
// course is a trap: courses store marks in course units, and a guessed
// conversion yields a script of one NaN sample and a confident wrong verdict.
const { compileScript } = require("../store/sim.js");

const CROSS_RANGE_M = 150;
const PASS_EXC = 150, SIDE_ARM = 135, TRI_SW = 90, DEAD = 20;
const sessionId = Number(process.argv[2]) || 62;

const M = 111320;
const rad = (d) => (d * Math.PI) / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const distM = (p, q) => {
    const k = Math.cos((((p.lat + q.lat) / 2) * Math.PI) / 180);
    return Math.hypot((p.lon - q.lon) * M * k, (p.lat - q.lat) * M);
};
const courseTo = (a, b) => {
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(b.lat * Math.PI / 180);
    const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) -
        Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos(dLon);
    return norm360(Math.atan2(y, x) / (Math.PI / 180));
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
const triAngle = (p, A, B) => {
    let d = Math.abs(courseTo(p, A) - courseTo(p, B)) % 360;
    return d > 180 ? 360 - d : d;
};
const segXing = (a, b, c, d) => {
    const k = Math.cos((a.lat * Math.PI) / 180);
    const X = (p) => [(p.lon) * M * k, p.lat * M];
    const [ax, ay] = X(a), [bx, by] = X(b), [cx, cy] = X(c), [dx, dy] = X(d);
    const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
};

(async () => {
    const res = await fetch(`http://localhost:3000/sessions/${sessionId}`);
    const session = await res.json();
    if (session.error) { console.log("no session:", session.error); return; }

    const run = compileScript(session, { speedKn: 28, startInSec: 60, nowMs: Date.now() });
    const s = run.samples;
    console.log(`session ${session.id} "${session.name}"  marks=${session.marks.length}  ` +
                `samples=${s.length}  dur=${run.durationSec}s  gunSec=${run.gunSec}\n`);

    const marks = session.marks || [];
    const gates = {};
    marks.forEach((m) => {
        if (m.type === "gate" && m.gate) (gates[m.gate] = gates[m.gate] || []).push(m);
    });
    const sib = (i) => {
        const m = marks[i];
        if (!m || m.type !== "gate" || !m.gate) return -1;
        return marks.findIndex((q, k) => k !== i && q.type === "gate" && q.gate === m.gate);
    };
    const pairEnd = (i) => {
        const m = marks[i];
        if (!m || m.type !== "gate" || !m.gate) return i;
        let end = i;
        marks.forEach((q, k) => { if (q.type === "gate" && q.gate === m.gate && k > end) end = k; });
        return end;
    };
    const tgtPt = (i) => {
        const m = marks[i], j = sib(i);
        if (j >= 0) return { lat: (m.lat + marks[j].lat) / 2, lon: (m.lon + marks[j].lon) / 2 };
        return { lat: m.lat, lon: m.lon };
    };
    const finSeg = () => {
        const f = session.finishLine;
        if (!f) return null;
        if (f.sameAs === "start") return session.startLine;
        return ("latA" in f) ? f : null;
    };
    const nextPt = (i) => {
        const ni = pairEnd(i) + 1;
        if (ni < marks.length) return tgtPt(ni);
        const f = finSeg();
        if (f) return { lat: (f.latA + f.latB) / 2, lon: (f.lonA + f.lonB) / 2 };
        return null;
    };

    let fails = 0;
    let prog = 0;
    // Skip start pins the way the device does.
    while (prog < marks.length && (marks[prog].type === "start" || marks[prog].type === "none")) prog++;

    // Per-leg engine mirror over the script samples.
    const leg = { init: false, mn: 0, mx: 0, sm: null, dema: -1, mind: -1, armed: false, tri: false, thr: false, prev: null };
    const legReset = () => { leg.init = false; leg.mn = leg.mx = 0; leg.sm = null; leg.dema = leg.mind = -1; leg.armed = leg.tri = leg.thr = false; leg.prev = null; };
    const unwrapNear = (ref, a) => {
        let d = a - ref;
        while (d < -180) d += 360;
        while (d > 180) d -= 360;
        return ref + d;
    };
    const done = [];
    for (const p of s) {
        if (prog >= marks.length) break;
        const m = marks[prog];
        const isGate = m.type === "gate" && sib(prog) >= 0;
        const T = tgtPt(prog);
        const N = nextPt(prog);
        const tri = N ? triAngle(p, T, N) : 180;
        if (isGate) {
            const j = sib(prog);
            const A = marks[prog], B = marks[j];
            if (leg.prev && !leg.thr && segXing(leg.prev, p, A, B)) { leg.thr = true; done.push(`threaded gate ${m.gate}`); }
            const clears = N ? !segXing(p, N, A, B) : true;
            if (tri > TRI_SW) leg.tri = true; else leg.tri = false;
            if (leg.thr && clears && leg.tri && N) { done.push(`PASS mark ${prog + 1} (gate)`); prog = pairEnd(prog) + 1; legReset(); }
        } else {
            const raw = norm360(courseTo(p, T));
            if (!leg.init) { leg.sm = raw; leg.mn = leg.mx = raw; leg.init = true; }
            else {
                const u = unwrapNear(leg.sm, raw);
                leg.sm = 0.6 * leg.sm + 0.4 * u;
                if (leg.sm < leg.mn) leg.mn = leg.sm;
                if (leg.sm > leg.mx) leg.mx = leg.sm;
            }
            const exc = leg.mx - leg.mn;
            const rd = distM(p, T);
            leg.dema = leg.dema < 0 ? rd : 0.5 * leg.dema + 0.5 * rd;
            if (leg.mind < 0 || leg.dema < leg.mind) leg.mind = leg.dema;
            if (!leg.armed && exc >= SIDE_ARM) leg.armed = true;
            if (leg.armed && (m.side === "P" || m.side === "S") && p.course != null) {
                const rel = norm360(raw - p.course);
                const dead = rel < DEAD || rel > 360 - DEAD || (rel > 160 && rel < 200);
                if (!dead) {
                    const sailed = rel > 180 ? "P" : "S";
                    if (sailed !== m.side) { done.push(`WRONG at mark ${prog + 1} (${m.side}!${sailed})`); fails++; legReset(); leg.prev = p; continue; }
                }
            }
            if (tri > TRI_SW) {
                if (leg.tri) {
                    if (exc >= PASS_EXC) { done.push(`PASS mark ${prog + 1} (exc=${exc.toFixed(0)} tri=${tri.toFixed(0)})`); prog++; legReset(); }
                } else leg.tri = true;
            } else {
                leg.tri = false;
                if (leg.mind > 0 && leg.dema > 2 * leg.mind && tri < 60) { legReset(); leg.prev = p; continue; }
            }
        }
        leg.prev = p;
    }
    const scoredMarks = (() => {
        // A gate pair is ONE target (two buoys, one pass).
        const seen = new Set();
        let n = 0;
        marks.forEach((m) => {
            if (m.type === "start" || m.type === "none") return;
            if (m.type === "gate" && m.gate) {
                if (seen.has(m.gate)) return;
                seen.add(m.gate);
            }
            n++;
        });
        return n;
    })();
    const passes = done.filter((d) => d.startsWith("PASS")).length;
    for (const d of done) console.log(`  ${d.startsWith("WRONG") ? "FAIL" : "ok  "} ${d}`);
    if (passes !== scoredMarks) { fails++; console.log(`  FAIL only ${passes}/${scoredMarks} marks scored`); }

    // --- start + finish line crosses --------------------------------------
    const line = session.startLine;
    if (line) {
        const A = { lat: line.latA, lon: line.lonA }, B = { lat: line.latB, lon: line.lonB };
        let cross = -1;
        for (let i = 1; i < s.length; i++) {
            if (sideOf(s[i], A, B) !== sideOf(s[i - 1], A, B) && distToSeg(s[i], A, B) < CROSS_RANGE_M) { cross = s[i].t; break; }
        }
        const ok = cross >= run.gunSec && cross <= run.gunSec + 30;
        if (!ok) fails++;
        console.log(`  ${ok ? "ok  " : "FAIL"} start cross at t=${cross}s (gun ${run.gunSec}s)`);
    }
    const fin = finSeg();
    if (!fin) {
        console.log("\n  --   no finish line on this course");
    } else {
        const A = { lat: fin.latA, lon: fin.lonA }, B = { lat: fin.latB, lon: fin.lonB };
        let sustained = false;
        for (let i = 1; i < s.length; i++) {
            if (sideOf(s[i], A, B) !== sideOf(s[i - 1], A, B) && distToSeg(s[i], A, B) < CROSS_RANGE_M) {
                let after = 0;
                for (let j = i + 1; j < s.length; j++) {
                    if (sideOf(s[j], A, B) === sideOf(s[i], A, B) && distToSeg(s[j], A, B) < CROSS_RANGE_M) after++;
                }
                if (after >= 3) { sustained = true; break; }
            }
        }
        if (!sustained) fails++;
        console.log(`  ${sustained ? "ok  " : "FAIL"} finish line crossing sustained inside the band`);
    }

    console.log(`\n${fails ? fails + " PROBLEM(S)" : "route scores cleanly against the device rules"}`);
    process.exit(fails ? 1 : 0);
})();

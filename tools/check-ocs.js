// Replay a scripted approach through the DEVICE's OCS predicate.
//
// The start was fixed by placing the line upwind of the boat, so the mock race
// no longer starts OCS. That is only half the story: the fix could equally
// have made OCS UNDETECTABLE, which is worse than the bug it replaced — the
// instrument would wave a jumping boat through. Nothing in a green mock race
// can tell those two outcomes apart, so check the predicate directly.
//
// Two cases over the SAME real samples:
//   1. as sailed        → must NOT raise OCS
//   2. shifted 20s early→ the boat jumped the line, MUST raise OCS
//
// The predicate below is transcribed from race_run.cpp (startSegSide / the
// `now < gun` arm of raceRunUpdate). If that code changes, change this too —
// it is the whole point of the file to be a copy that can be run.
const { compileScript } = require("../store/sim.js");

const OCS_SETTLE_M = 60;      // race_run.cpp
const CROSS_RANGE_M = 150;    // race_run.cpp
const GUN_LEAD = 20;          // seconds early for the "jumped the start" case

const M = 111320;
const rad = (d) => (d * Math.PI) / 180;
const distToSeg = (p, a, b) => {
    const k = Math.cos((p.lat * Math.PI) / 180);
    const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
    const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
    const L2 = bx * bx + by * by;
    let t = L2 ? (px * bx + py * by) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - bx * t, py - by * t);
};
const sideOf = (p, a, b) => {
    const k = Math.cos((p.lat * Math.PI) / 180);
    const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
    const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
    const cr = bx * py - by * px;
    return cr > 2 ? 1 : cr < -2 ? -1 : 0;
};

// Verbatim from race_run.cpp's `now < gun` arm.
function replay(samples, gunSec, a, b) {
    let approachSide = 0, sawApproach = false, ocs = false, ocsAt = null;
    for (const s of samples) {
        if (s.t >= gunSec) continue;                 // pre-gun passes only
        const side = sideOf(s, a, b);
        const dist = distToSeg(s, a, b);
        const near = dist >= 0 && dist < CROSS_RANGE_M;
        if (dist >= OCS_SETTLE_M) {
            approachSide = side;
            sawApproach = true;
        } else if (near && sawApproach && side !== 0 && side !== approachSide) {
            if (!ocs) { ocs = true; ocsAt = s.t; }
        }
    }
    return { ocs, ocsAt, approachSide, sawApproach };
}

(async () => {
    const id = Number(process.argv[2]);
    const res = await fetch(`http://localhost:3000/sessions/${id}`);
    const session = await res.json();
    if (session.error) { console.log("no session:", session.error); return; }

    const run = compileScript(session, { speedKn: 28, startInSec: 60, nowMs: Date.now() });
    const a = { lat: session.startLine.latA, lon: session.startLine.lonA };
    const b = { lat: session.startLine.latB, lon: session.startLine.lonB };

    let fails = 0;

    // Case 1 — the run as compiled and sailed.
    const honest = replay(run.samples, run.gunSec, a, b);
    const ok1 = !honest.ocs;
    if (!ok1) fails++;
    console.log(`  ${ok1 ? "ok  " : "FAIL"} as sailed        ` +
        `approachSide=${honest.approachSide} sawApproach=${honest.sawApproach} ` +
        `ocs=${honest.ocs}${honest.ocsAt !== null ? ` at t=${honest.ocsAt}` : ""}`);

    // Case 2 — the same track sailed EARLIER, so the boat is already past the
    // line when the gun fires: a jumping start.
    //
    // Move the samples, not the gun. Moving the gun earlier instead just
    // closes the pre-gun window before the boat ever reaches the line, so the
    // crossing is never evaluated and the detector looks broken when it is
    // fine. The track crosses at gunSec+8, so shifting by -(GUN_LEAD+8) lands
    // the crossing exactly GUN_LEAD seconds before the gun.
    const shift = -(GUN_LEAD + 8);
    const jumped = replay(run.samples.map((s) => ({ ...s, t: s.t + shift })), run.gunSec, a, b);
    const ok2 = jumped.ocs;
    if (!ok2) fails++;
    console.log(`  ${ok2 ? "ok  " : "FAIL"} ${GUN_LEAD}s early     ` +
        `approachSide=${jumped.approachSide} sawApproach=${jumped.sawApproach} ` +
        `ocs=${jumped.ocs}${jumped.ocsAt !== null ? ` at t=${jumped.ocsAt}` : ""}` +
        `  (track shifted ${shift}s, so it crosses ${GUN_LEAD}s before the gun)`);

    console.log(fails
        ? `\n${fails} PROBLEM(S): the OCS detector no longer matches the behaviour we want.`
        : `\nOCS still discriminates: silent on a proper approach, raised on a jump.`);
    process.exit(fails ? 1 : 0);
})();
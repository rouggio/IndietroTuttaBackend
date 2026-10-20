const crypto = require("crypto");

// ------------------------------------------------------------------
// Sim route compiled on the course SHAPE (todo 32).
//
// A course is a shape in wind-frame metres (x = east, y = upwind) and a
// session only places it: rotate by the wind, scale, translate onto the
// origin. The scripted route is a property of the SHAPE, so it is
// compiled once per shape, kept on the course row, and a session just
// rotates/scales/moves it. Nothing here reads the clock, the boat or the
// gun: those belong to the sampler in store/sim.js.
//
// Waypoint order is the order the boat sails: start line centre, marks
// (a gate pair collapses to a crossing point near its first buoy), the
// finish centre. `kind` mirrors the course entry type.
// ------------------------------------------------------------------

const DEG_M = 111320;
// 30 m, doubled from the 15 m the generator started with. The mock boat is
// not trying to be a good sailor: a big, lazy rounding is sampled by more
// fixes (and survives a coarser one) than a tight 15 m arc that only two or
// three samples describe. The device scores the exit traverse, so the radius
// only has to survive sampling, not look pretty.
const DEFAULT_ROUNDING_M = 30;

// The rounding offset is part of the shape (see compileShapeRoute), so it is
// expressed in SHAPE metres and gets scaled with the rest of the course. That
// is right for the shape, and wrong for the sampler: the pass distance exists
// for the DEVICE's sake (it has to be described by enough 1Hz fixes), and at
// scale 0.3 a 30m rounding would put the boat 9m off the buoy — one or two
// samples on the arc, the regime that made a rounding a coin toss. So
// `roundingM` means REAL metres everywhere else in the code and is converted
// here, once, at the boundary where the shape is compiled.
const ROUND_MIN = 5;
const ROUND_MAX = 200;
function clampRounding(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return DEFAULT_ROUNDING_M;
    return Math.max(ROUND_MIN, Math.min(ROUND_MAX, n));
}

// Real metres -> the shape radius that lands that far off the buoy once the
// session scales the course. scale 1 is the identity.
function shapeRoundingFor(realM, scale) {
    const s = Number(scale) > 0 ? Number(scale) : 1;
    return clampRounding(clampRounding(realM) / s);
}

// ---------------------------------------------------------------- shape

// Shape of a COURSE row: already wind-frame offsets.
function shapeOfCourse(course) {
    if (!course) return null;
    return {
        marks: (course.marks || []).map(m => ({ ...m })),
        startLine: course.startLine ? { ...course.startLine } : null,
        finishLine: course.finishLine && typeof course.finishLine === "object"
            ? { ...course.finishLine }
            : (course.finishLine === "start" ? { sameAs: "start" } : null),
    };
}

// Shape of a SESSION: the mark offsets are the frozen `courseSnapshot`
// (never scaled, never rotated); the lines are recovered by inverting the
// resolution, which is exact (the same formula the device uses).
function shapeOfSession(session) {
    if (!session) return null;
    const inst = {
        originLat: session.originLat, originLon: session.originLon,
        windDir: session.windDir, scale: session.scale === undefined ? 1 : session.scale,
    };
    let windFrameSegment = null;
    try {
        ({ windFrameSegment } = require("./sessionStore"));
    } catch {
        windFrameSegment = null;
    }
    // Marks: the frozen snapshot IS the shape. If a legacy row has none,
    // invert the resolved marks (windFrameSegment on a zero-length segment
    // gives the shape offset of a single point) rather than emit NaN.
    let marks;
    if (Array.isArray(session.courseSnapshot) && session.courseSnapshot.length) {
        marks = session.courseSnapshot.map(m => ({ ...m }));
    } else if (windFrameSegment && Array.isArray(session.marks)) {
        marks = session.marks.map(m => {
            const p = windFrameSegment({ latA: m.lat, lonA: m.lon, latB: m.lat, lonB: m.lon }, inst);
            return { ...m, x: p.ax, y: p.ay };
        });
    } else {
        marks = (session.marks || []).map(m => ({ ...m }));
    }
    let startLine = null, finishLine = null;
    if (windFrameSegment) {
        startLine = session.startLine ? windFrameSegment(session.startLine, inst) : null;
        if (session.finishLine && session.finishLine.sameAs === "start") {
            finishLine = { sameAs: "start" };
        } else if (session.finishLine) {
            finishLine = windFrameSegment(session.finishLine, inst);
        }
    }
    return { marks, startLine, finishLine };
}

// Stable identity of a shape (+ rounding radius): identical shapes share
// one compiled route, an edited course gets a new one. Values are rounded
// to a millimetre so float noise from the inverse transform cannot fork
// the key. `version` is the COMPILER version: the key must change when the
// way `compileShapeRoute` draws a rounding changes, or a row compiled by
// the old code keeps being served (it happened twice: the corner-cutting
// route, then the inside-only arcs). The shape alone is the invalidation for
// edits; this is the invalidation for code.
const COMPILE_VERSION = 3;
function shapeKey(shape, roundingM = DEFAULT_ROUNDING_M) {
    if (!shape) return null;
    const num = v => (typeof v === "number" && isFinite(v) ? Math.round(v * 1000) / 1000 : null);
    const seg = s => (!s || s.sameAs || !isFinite(s.ax) ? null : [num(s.ax), num(s.ay), num(s.bx), num(s.by)]);
    const payload = JSON.stringify({
        v: COMPILE_VERSION,
        m: (shape.marks || []).map(m => [num(m.x), num(m.y), num(m.r), m.side || null, m.type || null, m.gate || null]),
        s: seg(shape.startLine),
        f: shape.finishLine && shape.finishLine.sameAs ? "start" : seg(shape.finishLine),
        r: clampRounding(roundingM),
    });
    return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 12);
}

// ------------------------------------------------------------- compile

// Ordered waypoints of the shape, WITHOUT the rounding offset. Same rule
// as the resolved version used to apply: a gate pair becomes one crossing
// point 30% across, never more than 18 m off the first buoy (so a wide
// gate is still threaded close to a mark).
function shapeWaypoints(shape) {
    const marks = (shape && shape.marks) || [];
    const gates = {};
    marks.forEach(m => {
        if (m.type === "gate" && m.gate) (gates[m.gate] = gates[m.gate] || []).push(m);
    });
    const out = [];
    const seenGate = new Set();
    const sl = shape && shape.startLine;
    if (sl) out.push({ x: (sl.ax + sl.bx) / 2, y: (sl.ay + sl.by) / 2, kind: "line" });
    marks.forEach((m, i) => {
        if (m.type === "gate" && m.gate) {
            if (seenGate.has(m.gate)) return;
            seenGate.add(m.gate);
            const pair = gates[m.gate] || [];
            if (pair.length === 2) {
                const wdt = Math.max(1, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y));
                const f = Math.min(0.3, 18 / wdt);
                out.push({
                    x: pair[0].x + (pair[1].x - pair[0].x) * f,
                    y: pair[0].y + (pair[1].y - pair[0].y) * f,
                    kind: "gate", ref: i,
                    gx0: pair[0].x, gy0: pair[0].y, gx1: pair[1].x, gy1: pair[1].y,
                });
            } else {
                pair.forEach((q, k) => out.push({ x: q.x, y: q.y, kind: "gate", ref: i + k }));
            }
        } else {
            out.push({ x: m.x, y: m.y, kind: m.type, r: m.r, side: m.side, ref: i });
        }
    });
    const fin = shape && shape.finishLine && shape.finishLine.sameAs === "start"
        ? shape.startLine : (shape && shape.finishLine);
    if (fin) out.push({ x: (fin.ax + fin.bx) / 2, y: (fin.ay + fin.by) / 2, kind: "finish" });
    return out;
}

const unit2 = (dx, dy) => { const L = Math.hypot(dx, dy) || 1; return { x: dx / L, y: dy / L }; };
// The two normals of a heading: `leftOf` points to port (CCW), `rightOf`
// to starboard.
const leftOf = h => ({ x: -h.y, y: h.x });
const rightOf = h => ({ x: h.y, y: -h.x });

// The pass at one mark. Which of two shapes it is is decided by the course
// itself, not by a distance:
//
//   * the buoy is on the INSIDE of the turn (the course turns toward the
//     required side — always true at a windward mark, which sends the boat
//     straight back downwind): the boat sails AROUND the buoy. It runs the
//     leg in, follows a circle of radius `roundM` about the buoy from the
//     incoming heading to the outgoing one (which is what puts the buoy
//     "abeam and then clear astern"), and leaves on the next leg.
//   * otherwise (the course turns AWAY from the required side, or carries
//     straight on): the boat still sails around the buoy on the required
//     side — CCW for `P`, CW for `S` — spanning whatever angle the course
//     turns that way, even past 180°. A fly-by that merely cuts the corner
//     never crosses the mark's exit traverse, so under the traverse rule it
//     would never score: the rounding is what makes the exit cross on the
//     right side. Only a near-straight carry-on (a degree or two) keeps the
//     plain offset pass, which crosses cleanly on its own.
//
// Either way the buoy is left on the required side at `roundM`.
const mod360 = x => (((x % 360) + 360) % 360);

// Inclusive segment intersection (a touch counts): the gate event is
// cutting the segment, however the route meets it.
function segInt(a, b, c, d) {
    const rx = b.x - a.x, ry = b.y - a.y;
    const sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
}

function arcPoints(B, E, span, ccw, roundM, ref) {
    const pts = [];
    const steps = Math.max(2, Math.ceil(span / 10));
    const a0 = Math.atan2(E.x - B.x, E.y - B.y);
    for (let k = 1; k < steps; k++) {
        const a = a0 + (ccw ? -1 : 1) * ((span * k / steps) * Math.PI) / 180;
        pts.push({ kind: "arc", of: ref, x: B.x + roundM * Math.sin(a), y: B.y + roundM * Math.cos(a) });
    }
    return pts;
}

// A gate the course comes back through (|turn| >= 90°) is rounded CCW
// around its first buoy — the leeward-mark rounding, not a thread-and-U-turn
// south of the gate. A gate the course threads (small turn) keeps the plain
// crossing point. The loop is kept only if it still cuts the gate segment:
// the event (cutting it) must survive the look.
function loopGate(w, prev, next, roundM, out) {
    if (w.gx0 === undefined) return false;
    const G = { x: w.x, y: w.y };
    const hIn = unit2(G.x - prev.x, G.y - prev.y);
    const hOut = unit2(next.x - G.x, next.y - G.y);
    const turnDeg = (Math.atan2(hIn.x * hOut.y - hIn.y * hOut.x, hIn.x * hOut.x + hIn.y * hOut.y) * 180) / Math.PI;
    if (Math.abs(turnDeg) < 90) return false;
    const B = { x: w.gx0, y: w.gy0 };
    const bIn = unit2(B.x - prev.x, B.y - prev.y);
    const bOut = unit2(next.x - B.x, next.y - B.y);
    const bt = (Math.atan2(bIn.x * bOut.y - bIn.y * bOut.x, bIn.x * bOut.x + bIn.y * bOut.y) * 180) / Math.PI;
    const ccw = Math.abs(bt) > 179 ? true : bt >= 0; // deterministic at a reversal: CCW
    const rotCCW = mod360(bt);
    const span = ccw ? rotCCW : mod360(360 - rotCCW);
    if (!(span > 1 && span < 359)) return false;
    const nIn = ccw ? leftOf(bIn) : rightOf(bIn);
    const nOut = ccw ? leftOf(bOut) : rightOf(bOut);
    const E = { x: B.x - roundM * nIn.x, y: B.y - roundM * nIn.y };
    const X = { x: B.x - roundM * nOut.x, y: B.y - roundM * nOut.y };
    const body = [{ ...E }, ...arcPoints(B, E, span, ccw, roundM, w.ref), { ...X }];
    const s0 = { x: w.gx0, y: w.gy0 }, s1 = { x: w.gx1, y: w.gy1 };
    let hit = false;
    for (let k = 0; !hit && k + 1 < body.length; k++) hit = segInt(body[k], body[k + 1], s0, s1);
    if (!hit) hit = segInt(prev, E, s0, s1) || segInt(X, next, s0, s1);
    if (!hit) return false;
    out.push({ ...w, cx: B.x, cy: B.y, x: E.x, y: E.y });
    body.slice(1).forEach(p => out.push({ kind: "arc", of: w.ref, x: p.x, y: p.y }));
    return true;
}

function roundMarks(wps, roundM) {
    const out = [];
    for (let i = 0; i < wps.length; i++) {
        const w = wps[i];
        if (w.kind !== "mark" && w.kind !== "gate") { out.push(w); continue; }
        const next = wps[i + 1];
        const prev = wps[i - 1];
        if (!prev || !next) { out.push(w); continue; }
        if (w.kind === "gate") {
            if (!loopGate(w, prev, next, roundM, out)) out.push(w);
            continue;
        }
        const centre = { x: w.x, y: w.y };
        const hIn = unit2(centre.x - prev.x, centre.y - prev.y);
        const hOut = unit2(next.x - centre.x, next.y - centre.y);
        const dot = hIn.x * hOut.x + hIn.y * hOut.y;
        const cr = hIn.x * hOut.y - hIn.y * hOut.x; // > 0 = the course turns to port
        const turnDeg = (Math.atan2(cr, dot) * 180) / Math.PI;
        const declared = w.side === "P" || w.side === "S";
        const side = declared ? w.side : (turnDeg >= 0 ? "P" : "S");
        // How far the course turns the REQUIRED way (port/CCW for `P`,
        // starboard/CW for `S`). A mark that sends the boat back the way it
        // came turns ~180° whichever way you read it, so the raw sign of the
        // cross product — float noise at exactly 180° — must not decide: the
        // required side does.
        const rot = side === "P" ? mod360(turnDeg) : mod360(-turnDeg);
        const nIn = side === "P" ? leftOf(hIn) : rightOf(hIn); // boat → buoy
        const doArc = declared ? (rot > 2 && rot < 358) : (rot > 1 && rot <= 180);
        if (doArc) {
            const nOut = side === "P" ? leftOf(hOut) : rightOf(hOut);
            const E = { x: centre.x - roundM * nIn.x, y: centre.y - roundM * nIn.y };
            const X = { x: centre.x - roundM * nOut.x, y: centre.y - roundM * nOut.y };
            out.push({ ...w, cx: centre.x, cy: centre.y, x: E.x, y: E.y });
            arcPoints(centre, E, rot, side === "P", roundM, w.ref)
                .forEach(p => out.push(p));
            out.push({ kind: "arc", of: w.ref, x: X.x, y: X.y });
        } else {
            const r = side === "P" ? rightOf(hIn) : leftOf(hIn);
            out.push({ ...w, cx: centre.x, cy: centre.y, x: centre.x + roundM * r.x, y: centre.y + roundM * r.y });
        }
    }
    return out;
}

function compileShapeRoute(shape, roundingM = DEFAULT_ROUNDING_M) {
    const R = clampRounding(roundingM);
    return roundMarks(shapeWaypoints(shape), R);
}

// ------------------------------------------------------------- resolve

// Shape → real water: rotate by the wind, scale, translate. The exact
// inverse of nothing — this IS the formula the device and the session use
// (see resolveMarks in sessionStore).
function resolveRoute(wps, inst) {
    const t = ((inst.windDir || 0) * Math.PI) / 180;
    const scale = inst.scale === undefined ? 1 : inst.scale;
    const cosLat = Math.cos(((inst.originLat || 0) * Math.PI) / 180);
    const ct = Math.cos(t), st = Math.sin(t);
    return wps.map(w => {
        const x = w.x * scale, y = w.y * scale;
        const E = x * ct + y * st;
        const N = -x * st + y * ct;
        return { ...w, lat: inst.originLat + N / DEG_M, lon: inst.originLon + E / (DEG_M * cosLat) };
    });
}

// --------------------------------------------------------------- cache

// The compiled route lives on the course row (`courses.simRoute`), keyed by
// the shape: a cache hit is the whole point of todo 32; a miss compiles,
// and is stored ONLY when the session sails the course's current shape —
// sessions are frozen copies, so a session on an edited course must never
// overwrite the course's entry.
async function routeForShape(shape, courseId, roundingM) {
    const R = clampRounding(roundingM);
    const key = shapeKey(shape, R);
    if (courseId === null || courseId === undefined) return { key, roundingM: R, wps: compileShapeRoute(shape, R), cached: false };
    try {
        const { getSimRoute, putSimRoute, getCourse } = require("./courseStore");
        const stored = await getSimRoute(courseId);
        if (stored && stored.key === key && Array.isArray(stored.wps)) {
            return { key, roundingM: R, wps: stored.wps, cached: true };
        }
        const wps = compileShapeRoute(shape, R);
        const course = await getCourse(courseId);
        if (course && shapeKey(shapeOfCourse(course), R) === key) {
            // Fire-and-forget: a failed cache write must never stop a boat.
            Promise.resolve().then(() => putSimRoute(courseId, { key, roundingM: R, wps })).catch(() => {});
        }
        return { key, roundingM: R, wps, cached: false };
    } catch {
        return { key, roundingM: R, wps: compileShapeRoute(shape, R), cached: false };
    }
}

async function routeForSession(session, roundingM = DEFAULT_ROUNDING_M) {
    return routeForShape(shapeOfSession(session), session && session.courseId, roundingM);
}

async function routeForCourse(course, roundingM = DEFAULT_ROUNDING_M) {
    return routeForShape(shapeOfCourse(course), course && course.id, roundingM);
}

// -------------------------------------------------------------- analysis
// How the compiled route actually passes each buoy, in SHAPE units — the
// offline proof of the device rule (see the spec: the pass fires when the
// boat cuts the mark's traverse heading toward the next mark, on the
// declared side; gates score by cutting the segment between the buoys).
// Same maths the figures use (tools/draw-routes.js) and the read-out the
// course editor draws (POST /courses/sim-route).
//
// Per single mark the row carries the two traverse axes (entry: A→B,
// exit: B→C), the exit crossing on the way to C (if any), which side of
// the axis it is on (right of the axis facing C = the boat passes right
// of the buoy = P, CCW), and whether the entry traverse was cut arriving
// (the approach latch). `dist` is only informative: there is no minimum
// distance anywhere in the rule.
const sub2 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len2 = v => Math.hypot(v.x, v.y);
const dot2 = (a, b) => a.x * b.x + a.y * b.y;
const unitV = (dx, dy) => { const L = Math.hypot(dx, dy) || 1; return { x: dx / L, y: dy / L }; };

function closestOnSeg(a, b, p) {
    const d = sub2(b, a);
    const L2 = dot2(d, d);
    if (L2 < 1e-9) return { dist: len2(sub2(p, a)), point: { ...a }, cross: 0 };
    let t = dot2(sub2(p, a), d) / L2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + d.x * t, y: a.y + d.y * t };
    return {
        dist: len2(sub2(p, q)),
        point: q,
        cross: d.x * (p.y - a.y) - d.y * (p.x - a.x), // > 0 = buoy to port
    };
}

function closestApproach(poly, p) {
    let best = null;
    for (let i = 0; i + 1 < poly.length; i++) {
        const c = closestOnSeg(poly[i], poly[i + 1], p);
        if (!best || c.dist < best.dist) best = c;
    }
    return best;
}

// A point every ~2 m: a crossing is measured along the route, not only at
// its vertices.
function densify(poly, stepM = 2) {
    const dense = [poly[0]];
    const at = [0];
    for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const n = Math.max(1, Math.round(len2(sub2(b, a)) / stepM));
        for (let k = 1; k <= n; k++) {
            dense.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
        }
        at.push(dense.length - 1);
    }
    return { dense, at };
}

// Crossings of the directed line through B (axis u) inside a dense window,
// in sailing order. A touch (a dense point exactly on the line — the arc
// tangent points sit on it) does not break the tracking: only nonzero
// signs latch, so a touch reads as the crossing it is.
function lineCrossings(dense, B, u, j0, j1, wantAlong) {
    const s = p => (p.x - B.x) * u.x + (p.y - B.y) * u.y;
    const out = [];
    let prevSign = 0;
    for (let j = Math.max(1, j0); j <= Math.min(dense.length - 1, j1); j++) {
        const v = s(dense[j]);
        const sign = v === 0 ? 0 : (v > 0 ? 1 : -1);
        if (sign !== 0) {
            if (prevSign !== 0 && sign !== prevSign) {
                const along = (dense[j].x - dense[j - 1].x) * u.x + (dense[j].y - dense[j - 1].y) * u.y > 0;
                if (along === wantAlong) {
                    const a0 = Math.abs(s(dense[j - 1]));
                    const t = a0 / ((a0 + Math.abs(v)) || 1);
                    out.push({ x: dense[j - 1].x + (dense[j].x - dense[j - 1].x) * t, y: dense[j - 1].y + (dense[j].y - dense[j - 1].y) * t, j });
                }
            }
            prevSign = sign;
        }
    }
    return out;
}

// Right of the axis facing its direction: the boat crosses there when it
// passes right of the buoy (P, CCW); left means S (CW).
function sideOfAxis(p, B, u) {
    return ((p.x - B.x) * u.y + (p.y - B.y) * -u.x) > 0 ? "P" : "S";
}

// Compass bearing from p to B in the shape frame (+y = upwind = "north").
function bearingTo(p, B) {
    return ((Math.atan2(B.x - p.x, B.y - p.y) * 180) / Math.PI + 360) % 360;
}
function wrap180(d) {
    let x = ((d + 180) % 360 + 360) % 360 - 180;
    return x;
}
// Accumulated swing of the bearing "boat -> B" along the route, in degrees:
// negative = CCW (the boat is going round B to port, P), positive = CW (S).
// Accumulated STEP BY STEP, not as a difference of the endpoints: a 180-degree
// giro starts and ends on the same bearing line but is not a zero swing, and a
// full 360 wraps to zero on a simple difference.
function sweepBetween(poly, B, jFrom, jTo) {
    let acc = 0;
    for (let j = Math.max(1, jFrom) + 1; j <= jTo; j++) {
        acc += wrap180(bearingTo(poly[j], B) - bearingTo(poly[j - 1], B));
    }
    return acc;
}
// The engine needs 3 consecutive swings of > 2 degrees on 1 Hz fixes, so a
// "giro" there is at least ~6 degrees of sweep. Same floor here: below it the
// boat is not going round, it is going back.
const GIRO_MIN_DEG = 6;

function analyzeRoute(shape, wps) {
    const poly = (wps || []).map(w => ({ x: w.x, y: w.y }));
    if (poly.length < 2) return [];
    const { dense, at } = densify(poly);
    const skel = shapeWaypoints(shape);
    const rows = [];
    (wps || []).forEach((w, i) => {
        if (w.kind !== "mark" && w.kind !== "gate") return;
        // The rule reads A→B→C from the skeleton (the compiled neighbours
        // are arc points, not course nodes).
        const si = skel.findIndex(q => q.kind === w.kind && q.ref === w.ref);
        const prevN = si > 0 ? skel[si - 1] : null;
        const nextN = si >= 0 && si + 1 < skel.length ? skel[si + 1] : null;
        let last = i;
        while (last + 1 < (wps || []).length && wps[last + 1].kind === "arc") last++;
        const j0 = at[Math.max(0, i - 1)];
        const j1 = Math.min(dense.length - 1, at[Math.min(at.length - 1, last)] + 8);
        const ca = closestApproach(dense, { x: w.cx !== undefined ? w.cx : w.x, y: w.cy !== undefined ? w.cy : w.y });
        if (w.kind === "gate") {
            const gname = shape && shape.marks && shape.marks[w.ref] ? shape.marks[w.ref].gate : null;
            const pair = ((shape && shape.marks) || []).filter(m => m.gate && gname && m.gate === gname);
            let hit = null;
            if (pair.length === 2) {
                for (let j = Math.max(1, j0); j <= j1 && !hit; j++) {
                    if (segInt(dense[j - 1], dense[j], pair[0], pair[1])) {
                        hit = { x: (dense[j - 1].x + dense[j].x) / 2, y: (dense[j - 1].y + dense[j].y) / 2 };
                    }
                }
            }
            rows.push({
                label: "porta",
                wi: i, // index into `wps` (waypoint this pass belongs to)
                index: w.ref,
                kind: "gate",
                required: null,
                passed: null,
                crossSide: null,
                crossed: !!hit,
                entryCrossed: false,
                ok: !!hit,
                scored: !!hit,
                dist: ca.dist,
                point: hit || ca.point,
                entryPoint: null,
                centre: { x: w.cx !== undefined ? w.cx : w.x, y: w.cy !== undefined ? w.cy : w.y },
                trav: null,
                entry: null,
            });
            return;
        }
        const B = { x: w.cx !== undefined ? w.cx : w.x, y: w.cy !== undefined ? w.cy : w.y };
        const uIn = prevN ? unitV(B.x - prevN.x, B.y - prevN.y) : null;
        const uOut = nextN ? unitV(nextN.x - B.x, nextN.y - B.y) : null;
        const exits = uOut ? lineCrossings(dense, B, uOut, j0, j1, true) : [];
        const entries = uIn ? lineCrossings(dense, B, uIn, j0, j1, true) : [];
        // Crossings back toward A: a giro wider than 180 degrees produces one
        // by construction (the traverses are unbounded lines, SPEC 2), so the
        // engine only loses the arrival when there was NO swing in the
        // declared direction before it (SPEC 3.2: a return, not a wide giro).
        const backs = uIn ? lineCrossings(dense, B, uIn, j0, j1, false) : [];
        const cross = exits.length ? exits[exits.length - 1] : null;
        const crossSide = cross && uOut ? sideOfAxis(cross, B, uOut) : null;
        const firstEntry = entries.length ? entries[0] : null;
        let entryLost = null;
        if (firstEntry && uIn) {
            for (const bk of backs) {
                if (bk.j <= firstEntry.j) continue;
                // Sign of the swing of "boat -> B" between the arrival and this
                // crossing: falling = CCW (P), rising = CW (S).
                const sw = sweepBetween(dense, B, firstEntry.j, bk.j);
                const dirOk = w.side === "S" ? sw > GIRO_MIN_DEG : sw < -GIRO_MIN_DEG;
                if (!dirOk) { entryLost = bk; break; }
            }
        }
        const ok = !!cross && (!w.side || crossSide === w.side) && !entryLost;
        rows.push({
            label: "B" + (w.ref + 1),
            wi: i, // index into `wps` (waypoint this pass belongs to)
            index: w.ref,
            kind: "mark",
            required: w.side || null,
            passed: crossSide,
            crossSide,
            crossed: !!cross,
            entryCrossed: entries.length > 0,
            entryLost: !!entryLost,
            ok,
            scored: ok,
            dist: ca.dist,
            point: cross ? { x: cross.x, y: cross.y } : ca.point,
            entryPoint: entries.length ? { x: entries[0].x, y: entries[0].y } : null,
            centre: B,
            trav: uOut ? { ux: uOut.x, uy: uOut.y } : null,
            entry: uIn ? { ux: uIn.x, uy: uIn.y } : null,
        });
    });
    return rows;
}

module.exports = {
    DEFAULT_ROUNDING_M,
    clampRounding,
    shapeRoundingFor,
    shapeOfCourse,
    shapeOfSession,
    shapeKey,
    shapeWaypoints,
    compileShapeRoute,
    resolveRoute,
    analyzeRoute,
    routeForShape,
    routeForSession,
    routeForCourse,
};

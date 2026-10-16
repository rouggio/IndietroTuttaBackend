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
const DEFAULT_ROUNDING_M = 15;
const ROUND_MIN = 5;
const ROUND_MAX = 100;

// The rounding offset is part of the shape (see compileShapeRoute), so at
// scale 1 the boat passes `roundingM` metres off the buoy — the same 15 m
// the generator has always used. A session scaled by `s` scales the pass
// distance with it, which is the point: a scaled course stays a scaled
// course. Distances that exist for the DEVICE's sake (the 200 m finish
// overrun, the 300 m pre-start hold) are NOT here — they are metres in
// real water and stay in store/sim.js.
function clampRounding(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return DEFAULT_ROUNDING_M;
    return Math.max(ROUND_MIN, Math.min(ROUND_MAX, n));
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
// the key. `version` is not part of it — the shape IS the invalidation.
function shapeKey(shape, roundingM = DEFAULT_ROUNDING_M) {
    if (!shape) return null;
    const num = v => (typeof v === "number" && isFinite(v) ? Math.round(v * 1000) / 1000 : null);
    const seg = s => (!s || s.sameAs || !isFinite(s.ax) ? null : [num(s.ax), num(s.ay), num(s.bx), num(s.by)]);
    const payload = JSON.stringify({
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

// Offsets every single mark to the required side of its leg: the pass IS
// the rounding (15 m abeam), there is no loop around the buoy.
// `side: P` = the mark must stay to port, so the boat aims to starboard of
// it (right of the leg); `S` mirrors; a free side alternates.
function offsetMarks(wps, roundM) {
    return wps.map((w, i) => {
        if (w.kind !== "mark" || i === 0) return w;
        const prev = wps[i - 1];
        const dx = w.x - prev.x, dy = w.y - prev.y;
        const L = Math.hypot(dx, dy) || 1;
        const rx = dy / L, ry = -dx / L; // right of the leg (east, north)
        const s = w.side === "P" ? 1 : w.side === "S" ? -1 : (i % 2 === 0 ? 1 : -1);
        return { ...w, cx: w.x, cy: w.y, x: w.x + s * roundM * rx, y: w.y + s * roundM * ry };
    });
}

function compileShapeRoute(shape, roundingM = DEFAULT_ROUNDING_M) {
    const R = clampRounding(roundingM);
    return offsetMarks(shapeWaypoints(shape), R);
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

module.exports = {
    DEFAULT_ROUNDING_M,
    clampRounding,
    shapeOfCourse,
    shapeOfSession,
    shapeKey,
    shapeWaypoints,
    compileShapeRoute,
    resolveRoute,
    routeForShape,
    routeForSession,
    routeForCourse,
};

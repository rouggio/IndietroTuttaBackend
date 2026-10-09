const { getClient, initDb } = require("./db");

// ------------------------------------------------------------------
// Courses: reusable shapes in WIND-FRAME offsets (meters).
// +y = upwind (direction the wind comes FROM). No lat/lon here â€”
// a course is pure shape; sessions place + rotate it on the day.
// Mark: { x, y, r, side: P|S|G, type: start|mark|gate|finish, gate? }
// Gate = two entries sharing a gate id (either buoy counts, side G).
// Repeated positions are explicit entries (no refs) to keep firmware simple.
//
// The start/finish line sits at y=0 â€” the LEEWARD edge of every shape â€”
// and the course runs UPWIND from it (marks at y>0). Placement puts the
// boat downwind of the line; it beats up through the line at the gun.
// ------------------------------------------------------------------

const LEG = 500;   // default leg length, meters
const GATE_HALF = 40;
const LINE_HALF = 40; // start/finish line half-length (80m line at origin)

// Built-in shapes: roundings only â€” ends are line segments (start + shared
// finish), resolved square to the session wind.
const OOTB_LINES = {
    startLine: { ax: -LINE_HALF, ay: 0, bx: LINE_HALF, by: 0 },
    finishLine: { sameAs: "start" },
};

// Seed catalogue. These are inserted into the `courses` TABLE once (see
// seedBuiltinCourses) and thereafter live as ordinary rows with builtinKey
// set â€” read-only, copyable, never edited in place.
const BUILTINS = [
    {
        key: "wl",
        name: "Windward-Leeward",
        desc: "Start â†’ 1 â†’ 2 â†’ 1 â†’ Finish",
        ...OOTB_LINES,
        marks: [
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 0, y: 0, r: 30, side: "P", type: "mark" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
        ],
    },
    {
        key: "wl-gate",
        name: "W/L with Gate",
        desc: "Start â†’ 1 â†’ Gate â†’ 1 â†’ Finish",
        ...OOTB_LINES,
        marks: [
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: -GATE_HALF, y: 0, r: 30, side: "G", type: "gate", gate: "g1" },
            { x: GATE_HALF, y: 0, r: 30, side: "G", type: "gate", gate: "g1" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
        ],
    },
    {
        key: "triangle",
        name: "Triangle",
        desc: "Start â†’ 1 â†’ 2 â†’ 3 â†’ Finish",
        ...OOTB_LINES,
        marks: [
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 350, y: 100, r: 30, side: "P", type: "mark" },
            { x: -350, y: 100, r: 30, side: "P", type: "mark" },
        ],
    },
    {
        key: "wlt",
        name: "WLT Olympic",
        desc: "Start â†’ 1 â†’ 2 â†’ 3 â†’ 1 â†’ Finish",
        ...OOTB_LINES,
        marks: [
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 350, y: 100, r: 30, side: "P", type: "mark" },
            { x: -350, y: 100, r: 30, side: "P", type: "mark" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
        ],
    },
    {
        key: "trapezoid",
        name: "Trapezoid",
        desc: "Start â†’ 1 â†’ 2 â†’ 3 â†’ 4 â†’ Finish",
        ...OOTB_LINES,
        marks: [
            { x: -150, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 150, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 150, y: 0, r: 30, side: "P", type: "mark" },
            { x: -150, y: 0, r: 30, side: "P", type: "mark" },
        ],
    },
];

function cloneCourse(t) {
    return {
        ...t,
        marks: t.marks.map(m => ({ ...m })),
        startLine: t.startLine ? { ...t.startLine } : t.startLine,
        finishLine: t.finishLine && typeof t.finishLine === "object" ? { ...t.finishLine } : t.finishLine,
    };
}

function getBuiltinShapes() {
    return BUILTINS.map(cloneCourse);
}

function getBuiltinShape(key) {
    const t = BUILTINS.find(t => t.key === key);
    return t ? cloneCourse(t) : null;
}

const SIDES = ["P", "S", "G"];
const TYPES = ["start", "mark", "gate", "finish"];

// Sort helper mirroring the SQL: built-ins (builtinKey set) first, then name.
function byBuiltinThenName(a, b) {
    const ab = a.builtinKey ? 0 : 1;
    const bb = b.builtinKey ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
}

// Returns null when valid, otherwise an error string.
// A defined startLine replaces the start point (same for finish);
// without lines, first/last point marks stay mandatory.
function validateMarks(marks, startLine = null, finishLine = null) {
    if (!Array.isArray(marks) || marks.length < 1 || marks.length > 10) {
        return "marks must be an array of 1..10 entries";
    }
    for (let i = 0; i < marks.length; i++) {
        const m = marks[i] || {};
        if (typeof m.x !== "number" || !isFinite(m.x) || Math.abs(m.x) > 5000) {
            return `marks[${i}].x must be a number within ┬▒5000m`;
        }
        if (typeof m.y !== "number" || !isFinite(m.y) || Math.abs(m.y) > 5000) {
            return `marks[${i}].y must be a number within ┬▒5000m`;
        }
        if (typeof m.r !== "number" || !isFinite(m.r) || m.r < 5 || m.r > 200) {
            return `marks[${i}].r must be 5..200m`;
        }
        if (!SIDES.includes(m.side)) return `marks[${i}].side must be P, S or G`;
        if (!TYPES.includes(m.type)) return `marks[${i}].type must be start, mark, gate or finish`;
        if (m.gate !== undefined && (typeof m.gate !== "string" || !m.gate)) {
            return `marks[${i}].gate must be a non-empty string when present`;
        }
        if (m.sourceUid !== undefined && typeof m.sourceUid !== "string") {
            return `marks[${i}].sourceUid must be a string when present`;
        }
    }
    if (marks[0].type !== "start" && !startLine) return "marks[0] must be type start (or define a startLine)";
    const hasFinishLine = !!finishLine;
    if (marks[marks.length - 1].type !== "finish" && !hasFinishLine) {
        return "last mark must be type finish (or define a finishLine)";
    }
    // gate entries must come in pairs sharing one id
    const gates = {};
    for (const m of marks) {
        if (m.type === "gate") {
            if (!m.gate) return "gate-type marks need a gate id";
            gates[m.gate] = (gates[m.gate] || 0) + 1;
        }
    }
    for (const [g, n] of Object.entries(gates)) {
        if (n !== 2) return `gate ${g} must have exactly 2 buoys`;
    }
    return null;
}

// Optional line segments (wind-frame meters): {ax,ay,bx,by} plus behavior:
// square (default true) = bearing follows session wind + bias;
// square:false = fixed geometry rotating with the course.
// bias: deliberate skew in degrees (-60..60, 0 = square). Length ÔëÑ5m.
function validateSegment(seg, what) {
    if (seg === null || seg === undefined) return null;
    for (const k of ["ax", "ay", "bx", "by"]) {
        if (typeof seg[k] !== "number" || !isFinite(seg[k]) || Math.abs(seg[k]) > 5000) {
            return `${what}.${k} must be a number within ┬▒5000m`;
        }
    }
    const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay);
    if (len < 5) return `${what} must be at least 5m long`;
    if (seg.square !== undefined && typeof seg.square !== "boolean") {
        return `${what}.square must be a boolean when present`;
    }
    if (seg.bias !== undefined && (typeof seg.bias !== "number" || !isFinite(seg.bias) || Math.abs(seg.bias) > 60)) {
        return `${what}.bias must be -60..60 when present`;
    }
    return null;
}

function validateLines(startLine, finishLine) {
    const e1 = validateSegment(startLine, "startLine");
    if (e1) return e1;
    // tolerate the UI shorthand
    if (finishLine === "start") finishLine = { sameAs: "start" };
    if (finishLine !== null && finishLine !== undefined) {
        if (typeof finishLine === "object" && finishLine.sameAs === "start") {
            if (!startLine) return "finishLine.sameAs=start needs a startLine";
            return null;
        }
        const e2 = validateSegment(finishLine, "finishLine");
        if (e2) return e2;
    }
    return null;
}

function rowToCourse(r) {
    const parseOpt = v => (v ? JSON.parse(v) : null);
    return {
        id: r.id,
        name: r.name,
        desc: r.desc || null,
        owner: r.owner || null,
        marks: JSON.parse(r.marks),
        startLine: parseOpt(r.startLine),
        finishLine: parseOpt(r.finishLine),
        version: r.version,
        // null for user courses; the seed key for the five read-only built-ins
        builtinKey: r.builtinKey || null,
        createdAt: r.createdAt,
    };
}

// In-memory fallback
const memCourses = new Map();
let memNextId = 1;

async function createCourse({ name, desc = null, owner = null, marks, startLine = null, finishLine = null, builtinKey = null }) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 64) {
        throw Object.assign(new Error("name must be 1..64 chars"), { status: 400 });
    }
    if (desc !== null && desc !== undefined && (typeof desc !== "string" || desc.length > 140)) {
        throw Object.assign(new Error("desc must be Ôëñ140 chars"), { status: 400 });
    }
    const err = validateMarks(marks, startLine, finishLine) || validateLines(startLine, finishLine);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    const normFinish = finishLine === "start" ? { sameAs: "start" } : (finishLine === undefined ? null : finishLine);

    const client = getClient();
    const clean = {
        name: name.trim(),
        desc: typeof desc === "string" && desc.trim() ? desc.trim().slice(0, 140) : null,
        owner: typeof owner === "string" && owner ? owner.slice(0, 64) : null,
        marks,
        startLine: startLine || null,
        finishLine: normFinish,
        builtinKey: builtinKey || null,
    };
    if (!client) {
        const id = memNextId++;
        const course = { id, ...clean, version: 1, createdAt: new Date().toISOString() };
        memCourses.set(id, course);
        return course;
    }
    await initDb();
    const now = new Date().toISOString();
    const res = await client.execute({
        sql: "INSERT INTO courses (name, desc, owner, marks, startLine, finishLine, version, builtinKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
        args: [clean.name, clean.desc, clean.owner, JSON.stringify(clean.marks),
            clean.startLine ? JSON.stringify(clean.startLine) : null,
            clean.finishLine ? JSON.stringify(clean.finishLine) : null,
            clean.builtinKey, now],
    });
    return { id: Number(res.lastInsertRowid), ...clean, version: 1, createdAt: now };
}

// Built-ins first, then alphabetical — the order the UI and device both show.
async function listCourses() {
    const client = getClient();
    if (!client) {
        return [...memCourses.values()].sort(byBuiltinThenName);
    }
    await initDb();
    const res = await client.execute({
        sql: "SELECT * FROM courses ORDER BY (builtinKey IS NULL), name COLLATE NOCASE ASC, id ASC",
    });
    return res.rows.map(rowToCourse);
}

async function getCourse(id) {
    const client = getClient();
    if (!client) return memCourses.get(Number(id)) || null;
    await initDb();
    const res = await client.execute({ sql: "SELECT * FROM courses WHERE id = ?", args: [Number(id)] });
    return res.rows.length ? rowToCourse(res.rows[0]) : null;
}

// Built-in courses are read-only: the UI may only copy them.
function assertEditable(course) {
    if (course && course.builtinKey) {
        throw Object.assign(
            new Error(`built-in course '${course.name}' is read-only — save a copy instead`),
            { status: 403 }
        );
    }
}

async function updateCourse(id, { name, desc, marks, startLine, finishLine }) {
    const cur = await getCourse(id);
    if (!cur) return null;
    assertEditable(cur);
    const next = {
        name: name !== undefined ? name : cur.name,
        desc: desc !== undefined ? desc : cur.desc,
        marks: marks !== undefined ? marks : cur.marks,
        startLine: startLine !== undefined ? startLine : cur.startLine,
        finishLine: finishLine !== undefined
            ? (finishLine === "start" ? { sameAs: "start" } : finishLine)
            : cur.finishLine,
    };
    if (typeof next.name !== "string" || !next.name.trim() || next.name.trim().length > 64) {
        throw Object.assign(new Error("name must be 1..64 chars"), { status: 400 });
    }
    if (next.desc !== null && next.desc !== undefined && (typeof next.desc !== "string" || next.desc.length > 140)) {
        throw Object.assign(new Error("desc must be Ôëñ140 chars"), { status: 400 });
    }
    const err = validateMarks(next.marks, next.startLine, next.finishLine) || validateLines(next.startLine, next.finishLine);
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const client = getClient();
    if (!client) {
        const updated = { ...cur, name: next.name.trim(), desc: typeof next.desc === "string" && next.desc.trim() ? next.desc.trim().slice(0, 140) : null, marks: next.marks, startLine: next.startLine || null, finishLine: next.finishLine === undefined ? null : next.finishLine, version: cur.version + 1 };
        memCourses.set(cur.id, updated);
        return updated;
    }
    await initDb();
    await client.execute({
        sql: "UPDATE courses SET name = ?, desc = ?, marks = ?, startLine = ?, finishLine = ?, version = version + 1 WHERE id = ?",
        args: [next.name.trim(), (typeof next.desc === "string" && next.desc.trim() ? next.desc.trim().slice(0, 140) : null), JSON.stringify(next.marks),
            next.startLine ? JSON.stringify(next.startLine) : null,
            next.finishLine ? JSON.stringify(next.finishLine) : null, cur.id],
    });
    return getCourse(cur.id);
}

async function deleteCourse(id) {
    const client = getClient();
    const cur = await getCourse(id);
    if (cur) assertEditable(cur);
    if (!client) return memCourses.delete(Number(id));
    await initDb();
    const res = await client.execute({ sql: "DELETE FROM courses WHERE id = ?", args: [Number(id)] });
    return res.rowsAffected > 0;
}

// Insert any built-in shape whose builtinKey is absent. Idempotent: after the
// first run every key exists, so restarts never duplicate. A built-in whose
// row was hand-edited keeps its edit (we do not overwrite existing keys).
//
// Called FROM initDb(), so it must never call initDb() itself — that would
// await the very promise that is still resolving and deadlock the boot.
async function seedBuiltinCourses(client = getClient()) {
    if (!client) {
        for (const b of BUILTINS) {
            if (![...memCourses.values()].some(c => c.builtinKey === b.key)) {
                const id = memNextId++;
                memCourses.set(id, { ...cloneCourse(b), id, name: b.name, desc: b.desc || null, owner: null, version: 1, builtinKey: b.key, createdAt: new Date().toISOString() });
            }
        }
        return;
    }
    for (const b of BUILTINS) {
        const seen = await client.execute({ sql: "SELECT id FROM courses WHERE builtinKey = ?", args: [b.key] });
        if (seen.rows.length) continue;
        const c = cloneCourse(b);
        await client.execute({
            sql: "INSERT INTO courses (name, desc, owner, marks, startLine, finishLine, version, builtinKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
            args: [c.name, c.desc || null, null, JSON.stringify(c.marks),
                c.startLine ? JSON.stringify(c.startLine) : null,
                c.finishLine ? JSON.stringify(c.finishLine) : null,
                b.key, new Date().toISOString()],
        });
    }
}

module.exports = {
    getBuiltinShapes,
    getBuiltinShape,
    validateMarks,
    validateLines,
    createCourse,
    listCourses,
    getCourse,
    updateCourse,
    deleteCourse,
    seedBuiltinCourses,
};

const { getClient, initDb } = require("./db");

// ------------------------------------------------------------------
// Courses: templates in WIND-FRAME offsets (meters).
// +y = upwind (direction the wind comes FROM). No lat/lon here —
// a course is pure shape; sessions place + rotate it on the day.
// Mark: { x, y, r, side: P|S|G, type: start|mark|gate|finish, gate? }
// Gate = two entries sharing a gate id (either buoy counts, side G).
// Repeated positions are explicit entries (no refs) to keep firmware simple.
// ------------------------------------------------------------------

const LEG = 500;   // default leg length, meters
const GATE_HALF = 40;

const TEMPLATES = [
    {
        key: "wl",
        name: "Windward-Leeward",
        desc: "Start → 1 → 2 → 1 → Finish",
        marks: [
            { x: 0, y: 0, r: 30, side: "P", type: "start" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 0, y: 0, r: 30, side: "P", type: "mark" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 0, y: 0, r: 30, side: "P", type: "finish" },
        ],
    },
    {
        key: "wl-gate",
        name: "W/L with Gate",
        desc: "Start → 1 → Gate → 1 → Finish",
        marks: [
            { x: 0, y: 0, r: 30, side: "P", type: "start" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: -GATE_HALF, y: 0, r: 30, side: "G", type: "gate", gate: "g1" },
            { x: GATE_HALF, y: 0, r: 30, side: "G", type: "gate", gate: "g1" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 0, y: 0, r: 30, side: "P", type: "finish" },
        ],
    },
    {
        key: "triangle",
        name: "Triangle",
        desc: "Start → 1 → 2 → 3 → Finish",
        marks: [
            { x: 0, y: 0, r: 30, side: "P", type: "start" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 350, y: 100, r: 30, side: "P", type: "mark" },
            { x: -350, y: 100, r: 30, side: "P", type: "mark" },
            { x: 0, y: 0, r: 30, side: "P", type: "finish" },
        ],
    },
    {
        key: "wlt",
        name: "WLT Olympic",
        desc: "Start → 1 → 2 → 3 → 1 → Finish",
        marks: [
            { x: 0, y: 0, r: 30, side: "P", type: "start" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 350, y: 100, r: 30, side: "P", type: "mark" },
            { x: -350, y: 100, r: 30, side: "P", type: "mark" },
            { x: 0, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 0, y: 0, r: 30, side: "P", type: "finish" },
        ],
    },
    {
        key: "trapezoid",
        name: "Trapezoid",
        desc: "Start → 1 → 2 → 3 → 4 → Finish",
        marks: [
            { x: 0, y: 0, r: 30, side: "P", type: "start" },
            { x: -150, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 150, y: LEG, r: 30, side: "P", type: "mark" },
            { x: 150, y: 0, r: 30, side: "P", type: "mark" },
            { x: -150, y: 0, r: 30, side: "P", type: "mark" },
            { x: 0, y: 0, r: 30, side: "P", type: "finish" },
        ],
    },
];

function getTemplates() {
    return TEMPLATES.map(t => ({ ...t, marks: t.marks.map(m => ({ ...m })) }));
}

function getTemplate(key) {
    const t = TEMPLATES.find(t => t.key === key);
    return t ? { ...t, marks: t.marks.map(m => ({ ...m })) } : null;
}

const SIDES = ["P", "S", "G"];
const TYPES = ["start", "mark", "gate", "finish"];

// Returns null when valid, otherwise an error string.
function validateMarks(marks) {
    if (!Array.isArray(marks) || marks.length < 2 || marks.length > 10) {
        return "marks must be an array of 2..10 entries";
    }
    for (let i = 0; i < marks.length; i++) {
        const m = marks[i] || {};
        if (typeof m.x !== "number" || !isFinite(m.x) || Math.abs(m.x) > 5000) {
            return `marks[${i}].x must be a number within ±5000m`;
        }
        if (typeof m.y !== "number" || !isFinite(m.y) || Math.abs(m.y) > 5000) {
            return `marks[${i}].y must be a number within ±5000m`;
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
    if (marks[0].type !== "start") return "marks[0] must be type start";
    if (marks[marks.length - 1].type !== "finish") return "last mark must be type finish";
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

function rowToCourse(r) {
    return {
        id: r.id,
        name: r.name,
        owner: r.owner || null,
        marks: JSON.parse(r.marks),
        version: r.version,
        is_template: !!r.is_template,
        createdAt: r.createdAt,
    };
}

// In-memory fallback
const memCourses = new Map();
let memNextId = 1;

async function createCourse({ name, owner = null, marks, is_template = false }) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 64) {
        throw Object.assign(new Error("name must be 1..64 chars"), { status: 400 });
    }
    const err = validateMarks(marks);
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const client = getClient();
    const clean = {
        name: name.trim(),
        owner: typeof owner === "string" && owner ? owner.slice(0, 64) : null,
        marks,
        is_template: !!is_template,
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
        sql: "INSERT INTO courses (name, owner, marks, version, is_template, createdAt) VALUES (?, ?, ?, 1, ?, ?)",
        args: [clean.name, clean.owner, JSON.stringify(clean.marks), clean.is_template ? 1 : 0, now],
    });
    return { id: Number(res.lastInsertRowid), ...clean, version: 1, createdAt: now };
}

async function listCourses({ templatesOnly = false } = {}) {
    const client = getClient();
    if (!client) {
        return [...memCourses.values()].filter(c => !templatesOnly || c.is_template);
    }
    await initDb();
    const res = await client.execute({
        sql: templatesOnly
            ? "SELECT * FROM courses WHERE is_template = 1 ORDER BY id ASC"
            : "SELECT * FROM courses ORDER BY id ASC",
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

async function updateCourse(id, { name, marks }) {
    const cur = await getCourse(id);
    if (!cur) return null;
    const next = {
        name: name !== undefined ? name : cur.name,
        marks: marks !== undefined ? marks : cur.marks,
    };
    if (typeof next.name !== "string" || !next.name.trim() || next.name.trim().length > 64) {
        throw Object.assign(new Error("name must be 1..64 chars"), { status: 400 });
    }
    const err = validateMarks(next.marks);
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const client = getClient();
    if (!client) {
        const updated = { ...cur, name: next.name.trim(), marks: next.marks, version: cur.version + 1 };
        memCourses.set(cur.id, updated);
        return updated;
    }
    await initDb();
    await client.execute({
        sql: "UPDATE courses SET name = ?, marks = ?, version = version + 1 WHERE id = ?",
        args: [next.name.trim(), JSON.stringify(next.marks), cur.id],
    });
    return getCourse(cur.id);
}

async function deleteCourse(id) {
    const client = getClient();
    if (!client) return memCourses.delete(Number(id));
    await initDb();
    const res = await client.execute({ sql: "DELETE FROM courses WHERE id = ?", args: [Number(id)] });
    return res.rowsAffected > 0;
}

module.exports = {
    getTemplates,
    getTemplate,
    validateMarks,
    createCourse,
    listCourses,
    getCourse,
    updateCourse,
    deleteCourse,
};

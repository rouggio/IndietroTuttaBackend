const { getClient, initDb } = require("./db");
const crypto = require("crypto");

// In-memory fallback when DB not configured
const memCourses = new Map();

function parseMarks(marks) {
    if (typeof marks === "string") {
        try { return JSON.parse(marks); } catch { return []; }
    }
    return marks || [];
}

function validateCourse({ name, marks }) {
    if (!name || typeof name !== "string" || !name.trim()) return "name required";
    if (!Array.isArray(marks) || marks.length === 0) return "marks array required";
    if (marks.length > 10) return "max 10 marks";
    for (const m of marks) {
        const hasLat = typeof m.lat === "number" || typeof m.latOffset === "number";
        const hasLon = typeof m.lon === "number" || typeof m.lonOffset === "number";
        if (!hasLat || !hasLon) return "each mark needs lat/lon or latOffset/lonOffset numbers";
        if (m.radius != null && typeof m.radius !== "number") return "radius must be number";
        if (m.side && !["P","S","G"].includes(m.side)) return "side must be P/S/G";
    }
    return null;
}

async function createCourse({ name, description = "", marks }) {
    const err = validateCourse({ name, marks });
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const marksStr = JSON.stringify(marks);
    const client = getClient();

    if (!client) {
        const course = { id, name: name.trim(), description, marks, version: 1, createdAt: now, updatedAt: now };
        memCourses.set(id, course);
        return course;
    }

    await initDb();
    await client.execute({
        sql: `INSERT INTO courses (id, name, description, marks, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, name.trim(), description, marksStr, 1, now, now],
    });
    return { id, name: name.trim(), description, marks, version: 1, createdAt: now, updatedAt: now };
}

async function getCourses() {
    const client = getClient();
    if (!client) return Array.from(memCourses.values());

    await initDb();
    const res = await client.execute("SELECT id, name, description, marks, version, createdAt, updatedAt FROM courses ORDER BY updatedAt DESC");
    return res.rows.map(r => ({ ...r, marks: parseMarks(r.marks) }));
}

async function getCourse(id) {
    const client = getClient();
    if (!client) return memCourses.get(id) || null;

    await initDb();
    const res = await client.execute({ sql: "SELECT id, name, description, marks, version, createdAt, updatedAt FROM courses WHERE id = ?", args: [id] });
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return { ...r, marks: parseMarks(r.marks) };
}

async function updateCourse(id, { name, description, marks }) {
    const client = getClient();
    const existing = await getCourse(id);
    if (!existing) return null;

    const newName = name != null ? name.trim() : existing.name;
    const newDesc = description != null ? description : existing.description;
    const newMarks = marks != null ? marks : existing.marks;

    const err = validateCourse({ name: newName, marks: newMarks });
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const now = new Date().toISOString();
    const version = existing.version + 1;
    const marksStr = JSON.stringify(newMarks);

    if (!client) {
        const updated = { ...existing, name: newName, description: newDesc, marks: newMarks, version, updatedAt: now };
        memCourses.set(id, updated);
        return updated;
    }

    await initDb();
    await client.execute({
        sql: `UPDATE courses SET name = ?, description = ?, marks = ?, version = ?, updatedAt = ? WHERE id = ?`,
        args: [newName, newDesc, marksStr, version, now, id],
    });
    return { id, name: newName, description: newDesc, marks: newMarks, version, createdAt: existing.createdAt, updatedAt: now };
}

async function deleteCourse(id) {
    const client = getClient();
    if (!client) return memCourses.delete(id);

    await initDb();
    const res = await client.execute({ sql: "DELETE FROM courses WHERE id = ?", args: [id] });
    return res.rowsAffected > 0;
}

module.exports = { createCourse, getCourses, getCourse, updateCourse, deleteCourse };

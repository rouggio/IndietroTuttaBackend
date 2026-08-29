const { getClient, initDb } = require("./db");
const crypto = require("crypto");

const memRaces = new Map();
const VALID_STATUSES = ["scheduled", "live", "finished", "protest", "final"];

function parseParticipants(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v); } catch { return []; }
}

function validateRace({ name, courseId, startTime, status, participants }) {
    if (!name || typeof name !== "string" || !name.trim()) return "name required";
    if (courseId != null && typeof courseId !== "string") return "courseId must be string";
    if (startTime != null && isNaN(Date.parse(startTime))) return "startTime must be ISO date";
    if (status != null && !VALID_STATUSES.includes(status)) return `status must be one of ${VALID_STATUSES.join(", ")}`;
    if (participants != null && !Array.isArray(participants)) return "participants must be array of deviceIds";
    return null;
}

async function createRace({ name, courseId = null, startTime = null, status = "scheduled", participants = [] }) {
    const err = validateRace({ name, courseId, startTime, status, participants });
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const participantsStr = JSON.stringify(participants);
    const client = getClient();

    if (!client) {
        const race = { id, name: name.trim(), courseId, startTime, status, participants, createdAt: now, updatedAt: now };
        memRaces.set(id, race);
        return race;
    }

    await initDb();
    await client.execute({
        sql: `INSERT INTO races (id, name, courseId, startTime, status, participants, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, name.trim(), courseId, startTime, status, participantsStr, now, now],
    });
    return { id, name: name.trim(), courseId, startTime, status, participants, createdAt: now, updatedAt: now };
}

async function getRaces() {
    const client = getClient();
    if (!client) return Array.from(memRaces.values());

    await initDb();
    const res = await client.execute("SELECT id, name, courseId, startTime, status, participants, createdAt, updatedAt FROM races ORDER BY updatedAt DESC");
    return res.rows.map(r => ({ ...r, participants: parseParticipants(r.participants) }));
}

async function getRace(id) {
    const client = getClient();
    if (!client) return memRaces.get(id) || null;

    await initDb();
    const res = await client.execute({ sql: "SELECT id, name, courseId, startTime, status, participants, createdAt, updatedAt FROM races WHERE id = ?", args: [id] });
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return { ...r, participants: parseParticipants(r.participants) };
}

async function getActiveRaceForDevice(deviceId) {
    if (!deviceId) return null;
    const races = await getRaces();
    // return most recent live or scheduled race that includes this device
    return races.find(r => (r.status === "live" || r.status === "scheduled") && r.participants.includes(deviceId)) || null;
}

async function updateRace(id, { name, courseId, startTime, status, participants }) {
    const existing = await getRace(id);
    if (!existing) return null;

    const newName = name != null ? name.trim() : existing.name;
    const newCourseId = courseId !== undefined ? courseId : existing.courseId;
    const newStartTime = startTime !== undefined ? startTime : existing.startTime;
    const newStatus = status != null ? status : existing.status;
    const newParticipants = participants !== undefined ? participants : existing.participants;

    const err = validateRace({ name: newName, courseId: newCourseId, startTime: newStartTime, status: newStatus, participants: newParticipants });
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const now = new Date().toISOString();
    const participantsStr = JSON.stringify(newParticipants);
    const client = getClient();

    if (!client) {
        const updated = { ...existing, name: newName, courseId: newCourseId, startTime: newStartTime, status: newStatus, participants: newParticipants, updatedAt: now };
        memRaces.set(id, updated);
        return updated;
    }

    await initDb();
    await client.execute({
        sql: `UPDATE races SET name = ?, courseId = ?, startTime = ?, status = ?, participants = ?, updatedAt = ? WHERE id = ?`,
        args: [newName, newCourseId, newStartTime, newStatus, participantsStr, now, id],
    });
    return { id, name: newName, courseId: newCourseId, startTime: newStartTime, status: newStatus, participants: newParticipants, createdAt: existing.createdAt, updatedAt: now };
}

async function deleteRace(id) {
    const client = getClient();
    if (!client) return memRaces.delete(id);

    await initDb();
    const res = await client.execute({ sql: "DELETE FROM races WHERE id = ?", args: [id] });
    return res.rowsAffected > 0;
}

module.exports = { createRace, getRaces, getRace, getActiveRaceForDevice, updateRace, deleteRace };

const { getClient, initDb } = require("./db");
const { getCourse } = require("./courseStore");

// ------------------------------------------------------------------
// Sessions freeze a course onto a day: frozen template copy +
// {originLat, originLon, windDir, scale} + resolved absolute marks.
// windDir = meteorological degrees (where wind comes FROM).
// Resolve: rotate wind-frame (x=east+, y=upwind+) by windDir, then
// equirectangular meters→degrees. Same formula belongs on the device.
// ------------------------------------------------------------------

const EARTH_M = 111320;

function resolveMarks(offsetMarks, { originLat, originLon, windDir, scale = 1 }) {
    const t = (windDir * Math.PI) / 180;
    const cosLat = Math.cos((originLat * Math.PI) / 180);
    return offsetMarks.map(m => {
        const x = m.x * scale, y = m.y * scale;
        const E = x * Math.cos(t) + y * Math.sin(t);
        const N = -x * Math.sin(t) + y * Math.cos(t);
        const r = { ...m };
        r.lat = originLat + N / EARTH_M;
        r.lon = originLon + E / (EARTH_M * cosLat);
        return r;
    });
}

const MODES = ["practice", "race"];
const STATUSES = ["scheduled", "live", "finished", "abandoned"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateSessionInput(b) {
    if (b.date !== undefined && (typeof b.date !== "string" || !DATE_RE.test(b.date))) {
        return "date must be YYYY-MM-DD";
    }
    if (b.mode !== undefined && !MODES.includes(b.mode)) return "mode must be practice or race";
    if (b.status !== undefined && !STATUSES.includes(b.status)) return "bad status";
    if (b.originLat !== undefined && (typeof b.originLat !== "number" || Math.abs(b.originLat) > 90)) {
        return "originLat must be -90..90";
    }
    if (b.originLon !== undefined && (typeof b.originLon !== "number" || Math.abs(b.originLon) > 180)) {
        return "originLon must be -180..180";
    }
    if (b.windDir !== undefined && (typeof b.windDir !== "number" || b.windDir < 0 || b.windDir >= 360)) {
        return "windDir must be 0..359";
    }
    if (b.scale !== undefined && (typeof b.scale !== "number" || b.scale < 0.1 || b.scale > 5)) {
        return "scale must be 0.1..5";
    }
    if (b.startTime !== undefined && b.startTime !== null && isNaN(new Date(b.startTime).getTime())) {
        return "startTime must be ISO datetime or null";
    }
    if (b.name !== undefined && (typeof b.name !== "string" || b.name.length > 64)) {
        return "name must be ≤64 chars";
    }
    return null;
}

function rowToSession(r, boats = []) {
    return {
        id: r.id,
        courseId: r.courseId,
        name: r.name || null,
        date: r.date,
        mode: r.mode,
        originLat: r.originLat,
        originLon: r.originLon,
        windDir: r.windDir,
        scale: r.scale,
        startTime: r.startTime || null,
        status: r.status,
        courseVersion: r.courseVersion,
        templateSnapshot: JSON.parse(r.templateSnapshot),
        marks: JSON.parse(r.marks),
        boats,
        createdAt: r.createdAt,
    };
}

// In-memory fallback
const memSessions = new Map();
const memBoats = new Map(); // sessionId -> [{deviceId, startOffsetSec}]
let memNextId = 1;

async function getBoats(sessionId) {
    const client = getClient();
    if (!client) return memBoats.get(Number(sessionId)) || [];
    await initDb();
    const res = await client.execute({
        sql: "SELECT deviceId, startOffsetSec FROM session_boats WHERE sessionId = ? ORDER BY deviceId ASC",
        args: [Number(sessionId)],
    });
    return res.rows.map(r => ({ deviceId: r.deviceId, startOffsetSec: r.startOffsetSec }));
}

async function createSession(b) {
    const err = validateSessionInput(b) ||
        (!b.courseId ? "courseId required" : null) ||
        (!b.date ? "date required" : null) ||
        (b.originLat === undefined ? "originLat required" : null) ||
        (b.originLon === undefined ? "originLon required" : null) ||
        (b.windDir === undefined ? "windDir required" : null);
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const course = await getCourse(b.courseId);
    if (!course) throw Object.assign(new Error("course not found"), { status: 404 });

    const inst = {
        originLat: b.originLat,
        originLon: b.originLon,
        windDir: b.windDir,
        scale: b.scale === undefined ? 1 : b.scale,
    };
    const snapshot = course.marks;
    const marks = resolveMarks(snapshot, inst);
    const now = new Date().toISOString();
    const base = {
        courseId: course.id,
        name: typeof b.name === "string" && b.name ? b.name.slice(0, 64) : course.name,
        date: b.date,
        mode: b.mode || "practice",
        ...inst,
        startTime: b.startTime ? new Date(b.startTime).toISOString() : null,
        status: "scheduled",
        courseVersion: 1,
        templateSnapshot: snapshot,
        marks,
        createdAt: now,
    };

    const client = getClient();
    if (!client) {
        const id = memNextId++;
        const s = { id, ...base };
        memSessions.set(id, s);
        memBoats.set(id, []);
        return { ...s, boats: [] };
    }
    await initDb();
    const res = await client.execute({
        sql: `INSERT INTO sessions (courseId, name, date, mode, originLat, originLon, windDir, scale,
              startTime, status, courseVersion, templateSnapshot, marks, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        args: [base.courseId, base.name, base.date, base.mode, base.originLat, base.originLon,
            base.windDir, base.scale, base.startTime, base.status,
            JSON.stringify(base.templateSnapshot), JSON.stringify(base.marks), now],
    });
    const id = Number(res.lastInsertRowid);
    return rowToSession({ id, ...base, templateSnapshot: JSON.stringify(base.templateSnapshot), marks: JSON.stringify(base.marks) }, []);
}

async function listSessions({ date } = {}) {
    const client = getClient();
    if (!client) {
        let all = [...memSessions.values()];
        if (date) all = all.filter(s => s.date === date);
        return all.map(s => ({ ...s, boats: memBoats.get(s.id) || [] }));
    }
    await initDb();
    const res = date
        ? await client.execute({ sql: "SELECT * FROM sessions WHERE date = ? ORDER BY id ASC", args: [date] })
        : await client.execute("SELECT * FROM sessions ORDER BY id ASC");
    const out = [];
    for (const r of res.rows) out.push(rowToSession(r, await getBoats(r.id)));
    return out;
}

async function getSession(id) {
    const client = getClient();
    if (!client) {
        const s = memSessions.get(Number(id));
        return s ? { ...s, boats: memBoats.get(s.id) || [] } : null;
    }
    await initDb();
    const res = await client.execute({ sql: "SELECT * FROM sessions WHERE id = ?", args: [Number(id)] });
    if (!res.rows.length) return null;
    return rowToSession(res.rows[0], await getBoats(id));
}

// Pre-start edits (wind/origin/scale/startTime/status) re-resolve + bump version.
async function updateSession(id, b) {
    const cur = await getSession(id);
    if (!cur) return null;
    const err = validateSessionInput(b);
    if (err) throw Object.assign(new Error(err), { status: 400 });

    const geomKeys = ["originLat", "originLon", "windDir", "scale"];
    const geomChanged = geomKeys.some(k => b[k] !== undefined && b[k] !== cur[k]);
    const next = {
        name: b.name !== undefined ? (b.name || cur.name) : cur.name,
        status: b.status !== undefined ? b.status : cur.status,
        startTime: b.startTime !== undefined
            ? (b.startTime ? new Date(b.startTime).toISOString() : null)
            : cur.startTime,
        originLat: b.originLat !== undefined ? b.originLat : cur.originLat,
        originLon: b.originLon !== undefined ? b.originLon : cur.originLon,
        windDir: b.windDir !== undefined ? b.windDir : cur.windDir,
        scale: b.scale !== undefined ? b.scale : cur.scale,
    };
    const marks = geomChanged
        ? resolveMarks(cur.templateSnapshot, next)
        : cur.marks;

    const client = getClient();
    if (!client) {
        const updated = {
            ...cur, ...next, marks,
            courseVersion: geomChanged ? cur.courseVersion + 1 : cur.courseVersion,
        };
        memSessions.set(cur.id, updated);
        return { ...updated, boats: memBoats.get(cur.id) || [] };
    }
    await initDb();
    await client.execute({
        sql: `UPDATE sessions SET name = ?, status = ?, startTime = ?, originLat = ?, originLon = ?,
              windDir = ?, scale = ?, marks = ?, courseVersion = courseVersion + ? WHERE id = ?`,
        args: [next.name, next.status, next.startTime, next.originLat, next.originLon,
            next.windDir, next.scale, JSON.stringify(marks), geomChanged ? 1 : 0, cur.id],
    });
    return getSession(cur.id);
}

async function deleteSession(id) {
    const client = getClient();
    if (!client) {
        memBoats.delete(Number(id));
        return memSessions.delete(Number(id));
    }
    await initDb();
    await client.execute({ sql: "DELETE FROM session_boats WHERE sessionId = ?", args: [Number(id)] });
    const res = await client.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [Number(id)] });
    return res.rowsAffected > 0;
}

async function addBoat(sessionId, deviceId, startOffsetSec = 0) {
    const cur = await getSession(sessionId);
    if (!cur) return null;
    if (typeof deviceId !== "string" || !deviceId.trim()) {
        throw Object.assign(new Error("deviceId required"), { status: 400 });
    }
    const off = Number(startOffsetSec) || 0;
    const client = getClient();
    if (!client) {
        const list = memBoats.get(cur.id) || [];
        if (!list.some(x => x.deviceId === deviceId.trim())) list.push({ deviceId: deviceId.trim(), startOffsetSec: off });
        memBoats.set(cur.id, list);
        return getSession(cur.id);
    }
    await initDb();
    await client.execute({
        sql: "INSERT OR REPLACE INTO session_boats (sessionId, deviceId, startOffsetSec) VALUES (?, ?, ?)",
        args: [cur.id, deviceId.trim(), off],
    });
    return getSession(cur.id);
}

async function removeBoat(sessionId, deviceId) {
    const cur = await getSession(sessionId);
    if (!cur) return null;
    const client = getClient();
    if (!client) {
        memBoats.set(cur.id, (memBoats.get(cur.id) || []).filter(x => x.deviceId !== deviceId));
        return getSession(cur.id);
    }
    await initDb();
    await client.execute({
        sql: "DELETE FROM session_boats WHERE sessionId = ? AND deviceId = ?",
        args: [cur.id, deviceId],
    });
    return getSession(cur.id);
}

module.exports = {
    resolveMarks,
    createSession,
    listSessions,
    getSession,
    updateSession,
    deleteSession,
    addBoat,
    removeBoat,
};

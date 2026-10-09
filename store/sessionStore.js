const { getClient, initDb } = require("./db");
const { getTemplate, validateMarks, validateLines } = require("./templateStore");
const { uploaders } = require("./runStore");
const { terminalBoats } = require("./signalStore");

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

function resolveSegment(seg, { originLat, originLon, windDir, scale = 1 }) {
    const t = (windDir * Math.PI) / 180;
    const cosLat = Math.cos((originLat * Math.PI) / 180);
    const loc = (x, y) => {
        const E = (x * scale) * Math.cos(t) + (y * scale) * Math.sin(t);
        const N = -(x * scale) * Math.sin(t) + (y * scale) * Math.cos(t);
        return { lat: originLat + N / EARTH_M, lon: originLon + E / (EARTH_M * cosLat) };
    };
    // Lines are always square to the wind (90°): fixed center + length,
    // bearing follows the wind. Stored square/bias are ignored leftovers.
    const cx = (seg.ax + seg.bx) / 2, cy = (seg.ay + seg.by) / 2;
    const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) * scale;
    const bdeg = ((((windDir + 90) % 360) + 360) % 360);
    const brad = (bdeg * Math.PI) / 180;
    const c = loc(cx, cy);
    const half = len / 2;
    const dLa = (half * Math.cos(brad)) / EARTH_M;
    const dLo = (half * Math.sin(brad)) / (EARTH_M * cosLat);
    return { ...seg, latA: c.lat - dLa, lonA: c.lon - dLo, latB: c.lat + dLa, lonB: c.lon + dLo };
}

// Lines snapshot (wind-frame) + resolved absolute. finishLine may be
// {sameAs:"start"} — resolved finish then mirrors the resolved start.
function resolveLines(lines, inst) {
    const start = lines.startLine ? resolveSegment(lines.startLine, inst) : null;
    let finish = null;
    if (lines.finishLine && lines.finishLine.sameAs === "start") finish = { sameAs: "start" };
    else if (lines.finishLine) finish = resolveSegment(lines.finishLine, inst);
    return { startLine: start, finishLine: finish };
}

// Inverse of resolveSegment: resolved absolute → wind-frame offsets.
// Exact (resolve rounds nothing), used to re-resolve lines after a
// placement change without refetching the template.
function windFrameSegment(res, inst) {
    const t = (inst.windDir * Math.PI) / 180;
    const cosLat = Math.cos((inst.originLat * Math.PI) / 180);
    const s = inst.scale || 1;
    const pt = (lat, lon) => {
        const E = (lon - inst.originLon) * EARTH_M * cosLat;
        const N = (lat - inst.originLat) * EARTH_M;
        return { x: (E * Math.cos(t) - N * Math.sin(t)) / s, y: (E * Math.sin(t) + N * Math.cos(t)) / s };
    };
    const a = pt(res.latA, res.lonA), b = pt(res.latB, res.lonB);
    return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
}

// Resolved finish for consumers (device/web): sameAs expands to start.
function effectiveFinishLine(session) {
    if (session && session.finishLine && session.finishLine.sameAs === "start") return session.startLine;
    return session ? session.finishLine : null;
}
const MODES = ["practice", "race"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateSessionInput(b) {
    if (b.date !== undefined && (typeof b.date !== "string" || !DATE_RE.test(b.date))) {
        return "date must be YYYY-MM-DD";
    }
    if (b.mode !== undefined && !MODES.includes(b.mode)) return "mode must be practice or race";
    if (b.status !== undefined && !["abandoned", "scheduled"].includes(b.status)) return "status is inferred (only abandoned, or scheduled to re-open, accepted)";
    if (b.originLat !== undefined && (typeof b.originLat !== "number" || Math.abs(b.originLat) > 90)) {
        return "originLat must be -90..90";
    }
    if (b.originLon !== undefined && (typeof b.originLon !== "number" || Math.abs(b.originLon) > 180)) {
        return "originLon must be -180..180";
    }
    if (b.windDir !== undefined && (typeof b.windDir !== "number" || b.windDir < 0 || b.windDir >= 360)) {
        return "windDir must be 0..359";
    }
    if (b.windSpeed !== undefined && b.windSpeed !== null && (typeof b.windSpeed !== "number" || b.windSpeed < 0 || b.windSpeed > 99)) {
        return "windSpeed must be 0..99";
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
        templateId: r.templateId !== undefined && r.templateId !== null ? r.templateId : null,
        templateVersion: r.templateVersion !== undefined && r.templateVersion !== null ? r.templateVersion : null,
        name: r.name || null,
        date: r.date,
        mode: r.mode,
        originLat: r.originLat,
        originLon: r.originLon,
        windDir: r.windDir,
        windSpeed: r.windSpeed !== undefined && r.windSpeed !== null ? r.windSpeed : null,
        scale: r.scale,
        startTime: r.startTime || null,
        status: r.status,
        courseVersion: r.courseVersion,
        templateSnapshot: JSON.parse(r.templateSnapshot),
        marks: JSON.parse(r.marks),
        startLine: r.startLine ? JSON.parse(r.startLine) : null,
        finishLine: r.finishLine ? JSON.parse(r.finishLine) : null,
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
        (!b.date ? "date required" : null) ||
        (b.originLat === undefined ? "originLat required" : null) ||
        (b.originLon === undefined ? "originLon required" : null) ||
        (b.windDir === undefined ? "windDir required" : null);
    if (err) throw Object.assign(new Error(err), { status: 400 });

    // Shape source: a template row (lineage recorded) or an inline snapshot
    // (fully self-contained — no template row needed).
    let templateId = null, templateVersion = null, shapeName = "Session";
    let shape = null;
    if (b.templateId !== undefined && b.templateId !== null) {
        const tpl = await getTemplate(Number(b.templateId));
        if (!tpl) throw Object.assign(new Error("template not found"), { status: 404 });
        templateId = tpl.id;
        templateVersion = tpl.version;
        shapeName = tpl.name;
        shape = { marks: tpl.marks, startLine: tpl.startLine || null, finishLine: tpl.finishLine === undefined ? null : tpl.finishLine };
    } else if (b.snapshot && typeof b.snapshot === "object") {
        const snapErr = validateMarks(b.snapshot.marks, b.snapshot.startLine, b.snapshot.finishLine) ||
            validateLines(b.snapshot.startLine, b.snapshot.finishLine);
        if (snapErr) throw Object.assign(new Error(snapErr), { status: 400 });
        if (typeof b.snapshot.name === "string" && b.snapshot.name.trim()) {
            shapeName = b.snapshot.name.trim().slice(0, 64);
        }
        shape = {
            marks: b.snapshot.marks,
            startLine: b.snapshot.startLine || null,
            finishLine: b.snapshot.finishLine === undefined ? null : b.snapshot.finishLine,
        };
    } else {
        throw Object.assign(new Error("templateId or snapshot required"), { status: 400 });
    }

    const inst = {
        originLat: b.originLat,
        originLon: b.originLon,
        windDir: b.windDir,
        scale: b.scale === undefined ? 1 : b.scale,
    };
    const snapshot = shape.marks;
    const marks = resolveMarks(snapshot, inst);
    const linesSnap = { startLine: shape.startLine, finishLine: shape.finishLine };
    const lines = resolveLines(linesSnap, inst);
    const now = new Date().toISOString();
    const base = {
        templateId,
        templateVersion,
        name: typeof b.name === "string" && b.name ? b.name.slice(0, 64) : shapeName,
        date: b.date,
        mode: b.mode || "practice",
        ...inst,
        windSpeed: b.windSpeed === undefined || b.windSpeed === null ? null : b.windSpeed,
        startTime: b.startTime ? new Date(b.startTime).toISOString() : null,
        status: "scheduled",
        courseVersion: 1,
        templateSnapshot: snapshot,
        marks,
        startLine: lines.startLine,
        finishLine: lines.finishLine,
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
        sql: `INSERT INTO sessions (templateId, templateVersion, name, date, mode, originLat, originLon, windDir, windSpeed, scale,
              startTime, status, courseVersion, templateSnapshot, marks, startLine, finishLine, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        args: [base.templateId, base.templateVersion, base.name, base.date, base.mode, base.originLat, base.originLon,
            base.windDir, base.windSpeed, base.scale, base.startTime, base.status,
            JSON.stringify(base.templateSnapshot), JSON.stringify(base.marks),
            base.startLine ? JSON.stringify(base.startLine) : null,
            base.finishLine ? JSON.stringify(base.finishLine) : null, now],
    });
    const id = Number(res.lastInsertRowid);
    return rowToSession({
        id, ...base,
        templateSnapshot: JSON.stringify(base.templateSnapshot),
        marks: JSON.stringify(base.marks),
        startLine: base.startLine ? JSON.stringify(base.startLine) : null,
        finishLine: base.finishLine ? JSON.stringify(base.finishLine) : null,
    }, []);
}

// Status is inferred on read, never set by the committee (except abandon):
// abandoned sticks; finished when every boat uploaded a run; live once the
// gun passed; scheduled otherwise. Stored column keeps abandoned only.
async function deriveStatus(s) {
    if (!s) return s;
    if (s.status === "abandoned") return "abandoned";
    // A boat-less session can never be live (nothing to run).
    if (!s.boats || s.boats.length === 0) return "scheduled";
    try {
        if (s.boats && s.boats.length) {
            // A boat's race is over with an uploaded run OR a terminal
            // committee signal (DSQ/DNF/RET) — session finishes when all are.
            const done = new Set(await uploaders(s.id));
            for (const d of await terminalBoats(s.id)) done.add(d);
            if (s.boats.every(b => done.has(b.deviceId))) return "finished";
        }
    } catch {}
    if (s.startTime && Date.now() >= new Date(s.startTime).getTime()) return "live";
    return "scheduled";
}

async function listSessions({ date } = {}) {
    const client = getClient();
    if (!client) {
        let all = [...memSessions.values()];
        if (date) all = all.filter(s => s.date === date);
        const out = [];
        for (const s of all) {
            const full = { ...s, boats: memBoats.get(s.id) || [] };
            full.status = await deriveStatus(full);
            out.push(full);
        }
        return out;
    }
    await initDb();
    const res = date
        ? await client.execute({ sql: "SELECT * FROM sessions WHERE date = ? ORDER BY id ASC", args: [date] })
        : await client.execute("SELECT * FROM sessions ORDER BY id ASC");
    const out = [];
    for (const r of res.rows) {
        const full = rowToSession(r, await getBoats(r.id));
        full.status = await deriveStatus(full);
        out.push(full);
    }
    return out;
}

async function getSession(id) {
    const client = getClient();
    if (!client) {
        const s = memSessions.get(Number(id));
        if (!s) return null;
        const full = { ...s, boats: memBoats.get(s.id) || [] };
        full.status = await deriveStatus(full);
        return full;
    }
    await initDb();
    const res = await client.execute({ sql: "SELECT * FROM sessions WHERE id = ?", args: [Number(id)] });
    if (!res.rows.length) return null;
    const full = rowToSession(res.rows[0], await getBoats(id));
    full.status = await deriveStatus(full);
    return full;
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
        windSpeed: b.windSpeed !== undefined ? b.windSpeed : cur.windSpeed,
        scale: b.scale !== undefined ? b.scale : cur.scale,
    };
    const marks = geomChanged
        ? resolveMarks(cur.templateSnapshot, next)
        : cur.marks;
    // lines re-resolve from their wind-frame form: invert the current
    // resolved segments with the OLD placement, then resolve with the new.
    // sameAs finish needs no geometry — it follows the start by definition.
    let startLine = cur.startLine, finishLine = cur.finishLine;
    if (geomChanged) {
        const wfStart = cur.startLine ? windFrameSegment(cur.startLine, cur) : null;
        const wfFinish = cur.finishLine && !cur.finishLine.sameAs
            ? windFrameSegment(cur.finishLine, cur)
            : (cur.finishLine || null);
        const re = resolveLines({ startLine: wfStart, finishLine: wfFinish }, next);
        startLine = re.startLine;
        finishLine = re.finishLine;
    }

    const client = getClient();
    if (!client) {
        const updated = {
            ...cur, ...next, marks, startLine, finishLine,
            courseVersion: geomChanged ? cur.courseVersion + 1 : cur.courseVersion,
        };
        memSessions.set(cur.id, updated);
        return { ...updated, boats: memBoats.get(cur.id) || [] };
    }
    await initDb();
    await client.execute({
        sql: `UPDATE sessions SET name = ?, status = ?, startTime = ?, originLat = ?, originLon = ?,
              windDir = ?, windSpeed = ?, scale = ?, marks = ?, startLine = ?, finishLine = ?,
              courseVersion = courseVersion + ? WHERE id = ?`,
        args: [next.name, next.status, next.startTime, next.originLat, next.originLon,
            next.windDir, next.windSpeed === undefined ? null : next.windSpeed, next.scale, JSON.stringify(marks),
            startLine ? JSON.stringify(startLine) : null,
            finishLine ? JSON.stringify(finishLine) : null,
            geomChanged ? 1 : 0, cur.id],
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

// Every session (any status) this device is a boat in.
async function sessionsForDevice(deviceId) {
    if (!deviceId) return [];
    const client = getClient();
    const out = [];
    if (!client) {
        for (const s of memSessions.values()) {
            const boats = memBoats.get(s.id) || [];
            if (!boats.some(b => b.deviceId === deviceId)) continue;
            const full = { ...s, boats };
            full.status = await deriveStatus(full);
            out.push(full);
        }
        return out;
    }
    await initDb();
    const res = await client.execute({
        sql: `SELECT s.* FROM sessions s JOIN session_boats b ON b.sessionId = s.id
              WHERE b.deviceId = ? ORDER BY s.id ASC`,
        args: [deviceId],
    });
    for (const r of res.rows) {
        const full = rowToSession(r, await getBoats(r.id));
        full.status = await deriveStatus(full);
        out.push(full);
    }
    return out;
}

// Active = scheduled or live (a boat can't be in two at once). `exceptId`
// skips the session being joined/re-added so re-adding is not a conflict.
async function activeSessionsForDevice(deviceId, exceptId = null) {
    const list = await sessionsForDevice(deviceId);
    return list.filter(s => s.id !== exceptId && (s.status === "scheduled" || s.status === "live"));
}

function boatBusyError(conflict) {
    const label = conflict.name ? ` "${conflict.name}"` : "";
    return Object.assign(
        new Error(`boat is already in an active session (#${conflict.id}${label}) — finish or abandon it first`),
        { status: 409 }
    );
}

async function addBoat(sessionId, deviceId, startOffsetSec = 0) {
    const cur = await getSession(sessionId);
    if (!cur) return null;
    if (typeof deviceId !== "string" || !deviceId.trim()) {
        throw Object.assign(new Error("deviceId required"), { status: 400 });
    }
    const dev = deviceId.trim();
    const conflicts = await activeSessionsForDevice(dev, cur.id);
    if (conflicts.length) throw boatBusyError(conflicts[0]);
    const off = Number(startOffsetSec) || 0;
    const client = getClient();
    if (!client) {
        const list = memBoats.get(cur.id) || [];
        if (!list.some(x => x.deviceId === dev)) list.push({ deviceId: dev, startOffsetSec: off });
        memBoats.set(cur.id, list);
        return getSession(cur.id);
    }
    await initDb();
    await client.execute({
        sql: "INSERT OR REPLACE INTO session_boats (sessionId, deviceId, startOffsetSec) VALUES (?, ?, ?)",
        args: [cur.id, dev, off],
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

// Repeat a session onto a new day: same frozen geometry + placement,
// same boats, fresh start (no startTime, back to scheduled).
async function repeatSession(id, { date, mode, name } = {}) {
    const cur = await getSession(id);
    if (!cur) return null;
    if (!date || !DATE_RE.test(date)) {
        throw Object.assign(new Error("date must be YYYY-MM-DD"), { status: 400 });
    }
    // A boat can't be in two concurrent sessions: only repeat once every
    // boat is free (source finished/abandoned).
    for (const b of cur.boats) {
        const conflicts = await activeSessionsForDevice(b.deviceId);
        if (conflicts.length) throw boatBusyError(conflicts[0]);
    }
    const cleanMode = mode && MODES.includes(mode) ? mode : cur.mode;
    const now = new Date().toISOString();
    const base = {
        templateId: cur.templateId,
        templateVersion: cur.templateVersion,
        name: (typeof name === "string" && name ? name : cur.name || "Session").slice(0, 64) + "",
        date,
        mode: cleanMode,
        originLat: cur.originLat,
        originLon: cur.originLon,
        windDir: cur.windDir,
        windSpeed: cur.windSpeed === undefined ? null : cur.windSpeed,
        scale: cur.scale,
        startTime: null,
        status: "scheduled",
        courseVersion: 1,
        templateSnapshot: cur.templateSnapshot,
        marks: cur.marks,
        startLine: cur.startLine,
        finishLine: cur.finishLine,
        createdAt: now,
    };
    // default repeat name carries the new date unless overridden
    if (!name) base.name = `${(cur.name || "Session").split(" — ")[0]} — ${date}`.slice(0, 64);

    const client = getClient();
    if (!client) {
        const newId = memNextId++;
        const s = { id: newId, ...base };
        memSessions.set(newId, s);
        memBoats.set(newId, (memBoats.get(cur.id) || []).map(b => ({ ...b })));
        return { ...s, boats: memBoats.get(newId) };
    }
    await initDb();
    const res = await client.execute({
        sql: `INSERT INTO sessions (templateId, templateVersion, name, date, mode, originLat, originLon, windDir, windSpeed, scale,
              startTime, status, courseVersion, templateSnapshot, marks, startLine, finishLine, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        args: [base.templateId, base.templateVersion, base.name, base.date, base.mode, base.originLat, base.originLon,
            base.windDir, base.windSpeed, base.scale, base.startTime, base.status,
            JSON.stringify(base.templateSnapshot), JSON.stringify(base.marks),
            base.startLine ? JSON.stringify(base.startLine) : null,
            base.finishLine ? JSON.stringify(base.finishLine) : null, now],
    });
    const newId = Number(res.lastInsertRowid);
    for (const b of cur.boats) {
        await client.execute({
            sql: "INSERT INTO session_boats (sessionId, deviceId, startOffsetSec) VALUES (?, ?, ?)",
            args: [newId, b.deviceId, b.startOffsetSec || 0],
        });
    }
    return getSession(newId);
}

module.exports = {
    resolveMarks,
    resolveSegment,
    windFrameSegment,
    effectiveFinishLine,
    createSession,
    listSessions,
    getSession,
    updateSession,
    deleteSession,
    addBoat,
    removeBoat,
    repeatSession,
    sessionsForDevice,
    activeSessionsForDevice,
    getActiveSessionForDevice,
};

// Newest session (scheduled/live) a device is assigned to, trimmed for the
// firmware: resolved geometry + own pursuit offset. Null when unassigned.
const {
    signalsForDevice
} = require("./signalStore");

async function getActiveSessionForDevice(deviceId) {
    if (!deviceId) return null;
    const client = getClient();
    if (!client) return null; // in-memory mode: no race push
    await initDb();
    const res = await client.execute({
        sql: `SELECT s.* FROM sessions s JOIN session_boats b ON b.sessionId = s.id
              WHERE b.deviceId = ? AND s.status IN ('scheduled','live')
              ORDER BY s.id DESC LIMIT 1`,
        args: [deviceId],
    });
    if (!res.rows.length) return null;
    const boats = await getBoats(res.rows[0].id);
    const full = rowToSession(res.rows[0], boats);
    // Finished sessions stop pushing (race over); the inferred status
    // (live once the gun passes) drives the device's fast health poll.
    // deriveStatus costs 2 queries — call once, reuse below.
    const status = await deriveStatus(full);
    if (status === "finished") return null;
    const mine = boats.find(b => b.deviceId === deviceId);
    let signals = [];
    try {
        signals = await signalsForDevice(full.id, deviceId);
    } catch (e) {
        signals = [];
    }
    return {
        id: full.id,
        mode: full.mode,
        status,
        startTime: full.startTime,
        startOffsetSec: (mine && mine.startOffsetSec) || 0,
        courseVersion: full.courseVersion,
        windDir: Math.round(full.windDir),
        windSpeed: full.windSpeed == null ? null : Math.round(full.windSpeed),
        marks: full.marks.map(m => ({
            lat: m.lat, lon: m.lon, r: m.r, side: m.side, type: m.type,
            ...(m.gate ? { gate: m.gate } : {}),
        })),
        startLine: full.startLine,
        finishLine: full.finishLine,
        signals,
    };
}

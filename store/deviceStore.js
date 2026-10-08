const { getClient, initDb } = require("./db");

const USERNAME_PATTERN = /^[A-Za-z0-9 ._-]{1,32}$/;
const FIRMWARE_PATTERN = /^[A-Za-z0-9._-]{1,16}$/;
const BOAT_PATTERN = /^[A-Za-z0-9 ._-]{1,64}$/;

// In-memory fallback when DB not configured
const memDevices = new Map();

function sanitizeUsername(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.trim();
    return USERNAME_PATTERN.test(cleaned) ? cleaned : null;
}

function sanitizeFirmware(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.trim();
    return FIRMWARE_PATTERN.test(cleaned) ? cleaned : null;
}

function sanitizeBoat(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.trim();
    return BOAT_PATTERN.test(cleaned) ? cleaned : null;
}

// Turso may hand back mock as "1.0"/"0.0" strings (legacy TEXT-affinity
// column) — a nonzero-looking "0.0" is truthy in JS, so normalize every
// read to a real 0/1 flag. Number(null/undefined) → 0, Number("1.0") → 1.
function mockFlag(value) {
    return Number(value) ? 1 : 0;
}

function cleanIp(value) {
    if (typeof value !== "string") return null;
    // Express req.ip: "::ffff:192.168.0.106" → "192.168.0.106"
    let v = value.replace(/^::ffff:/, "").trim();
    if (v === "::1") v = "127.0.0.1"; // IPv6 loopback → plain LAN form
    return v ? v.slice(0, 64) : null;
}

async function upsertDevice(deviceId, { username = null, firmware = null, ip = null } = {}) {
    if (!deviceId) return null;

    const clean = sanitizeUsername(username);
    const cleanFw = sanitizeFirmware(firmware);
    const ipAddr = cleanIp(ip);
    const now = new Date().toISOString();
    const client = getClient();

    if (!client) {
        const device = memDevices.get(deviceId) || { deviceId, username: null, firmware: null, boat: null, ip: null, mock: 0, firstSeen: now };
        if (clean) device.username = clean;
        if (cleanFw) device.firmware = cleanFw;
        if (ipAddr) device.ip = ipAddr;
        device.lastSeen = now;
        memDevices.set(deviceId, device);
        return device;
    }

    await initDb();

    // Try to fetch existing to preserve firstSeen
    const existing = await client.execute({
        sql: "SELECT deviceId, username, firmware, boat, ip, mock, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
        args: [deviceId],
    });

    if (existing.rows.length === 0) {
        const firstSeen = now;
        const lastSeen = now;
        const finalUsername = clean;
        await client.execute({
            sql: "INSERT INTO devices (deviceId, username, firmware, boat, ip, mock, firstSeen, lastSeen) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
            args: [deviceId, finalUsername, cleanFw, null, ipAddr, firstSeen, lastSeen],
        });
        return { deviceId, username: finalUsername, firmware: cleanFw, boat: null, ip: ipAddr, mock: 0, firstSeen, lastSeen };
    } else {
        const row = existing.rows[0];
        const firstSeen = row.firstSeen;
        const newUsername = clean || row.username;
        const newFirmware = cleanFw || row.firmware || null;
        const newIp = ipAddr || row.ip || null;
        await client.execute({
            sql: "UPDATE devices SET username = ?, firmware = ?, ip = ?, lastSeen = ? WHERE deviceId = ?",
            args: [newUsername, newFirmware, newIp, now, deviceId],
        });
        return { deviceId, username: newUsername, firmware: newFirmware, boat: row.boat || null, ip: newIp, mock: mockFlag(row.mock), firstSeen, lastSeen: now };
    }
}

// Assumed mock-GPS state, set by POST /devices/:id/mock after proxying to
// the device portal. Never touches lastSeen (no fake "live" status).
async function setDeviceMock(deviceId, on) {
    if (!deviceId) return null;
    const v = on ? 1 : 0;
    const client = getClient();
    if (!client) {
        const device = memDevices.get(deviceId);
        if (!device) return null;
        device.mock = v;
        return device;
    }
    await initDb();
    await client.execute({
        sql: "UPDATE devices SET mock = ? WHERE deviceId = ?",
        args: [v, deviceId],
    });
    return getDevice(deviceId);
}

// Rename/edit boat info without touching lastSeen (no fake "live" status)
async function renameDevice(deviceId, { username, boat } = {}) {
    if (!deviceId) return null;
    const client = getClient();

    if (!client) {
        const device = memDevices.get(deviceId);
        if (!device) return null;
        if (username !== undefined) device.username = username;
        if (boat !== undefined) device.boat = boat;
        return device;
    }

    await initDb();
    const existing = await client.execute({
        sql: "SELECT deviceId, username, firmware, boat, ip, mock, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
        args: [deviceId],
    });
    if (existing.rows.length === 0) return null;
    const row = existing.rows[0];
    const newUsername = username !== undefined ? username : row.username;
    const newBoat = boat !== undefined ? boat : (row.boat || null);
    await client.execute({
        sql: "UPDATE devices SET username = ?, boat = ? WHERE deviceId = ?",
        args: [newUsername, newBoat, deviceId],
    });
    return { ...row, username: newUsername, boat: newBoat, mock: mockFlag(row.mock) };
}

async function getDevice(deviceId) {
    const client = getClient();
    if (!client) return memDevices.get(deviceId) || null;

    await initDb();
    const res = await client.execute({
        sql: "SELECT deviceId, username, firmware, boat, ip, mock, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
        args: [deviceId],
    });
    const row = res.rows[0];
    return row ? { ...row, mock: mockFlag(row.mock) } : null;
}

function computeStatus(lastSeen) {
    if (!lastSeen) return "offline";
    const ageMs = Date.now() - new Date(lastSeen).getTime();
    if (ageMs < 90 * 1000) return "live";      // < 90s
    if (ageMs < 10 * 60 * 1000) return "idle"; // < 10min
    return "offline";
}

async function getDevices() {
    const client = getClient();
    if (!client) {
        return Array.from(memDevices.values()).map(d => ({ ...d, status: computeStatus(d.lastSeen) }));
    }

    await initDb();
    const res = await client.execute("SELECT deviceId, username, firmware, boat, ip, mock, firstSeen, lastSeen FROM devices ORDER BY lastSeen DESC");
    return res.rows.map(r => ({ ...r, mock: mockFlag(r.mock), status: computeStatus(r.lastSeen) }));
}

async function deleteDevice(deviceId) {
    if (!deviceId) return false;
    const client = getClient();
    if (!client) return memDevices.delete(deviceId);
    await initDb();
    const res = await client.execute({ sql: "DELETE FROM devices WHERE deviceId = ?", args: [deviceId] });
    // also clean its points
    await client.execute({ sql: "DELETE FROM gps_points WHERE deviceId = ?", args: [deviceId] });
    return res.rowsAffected > 0;
}

module.exports = { sanitizeUsername, sanitizeFirmware, sanitizeBoat, upsertDevice, setDeviceMock, renameDevice, getDevice, getDevices, deleteDevice };

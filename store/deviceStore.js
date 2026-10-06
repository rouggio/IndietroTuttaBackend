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

async function upsertDevice(deviceId, { username = null, firmware = null } = {}) {
    if (!deviceId) return null;

    const clean = sanitizeUsername(username);
    const cleanFw = sanitizeFirmware(firmware);
    const now = new Date().toISOString();
    const client = getClient();

    if (!client) {
        const device = memDevices.get(deviceId) || { deviceId, username: null, firmware: null, boat: null, firstSeen: now };
        if (clean) device.username = clean;
        if (cleanFw) device.firmware = cleanFw;
        device.lastSeen = now;
        memDevices.set(deviceId, device);
        return device;
    }

    await initDb();

    // Try to fetch existing to preserve firstSeen
    const existing = await client.execute({
        sql: "SELECT deviceId, username, firmware, boat, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
        args: [deviceId],
    });

    if (existing.rows.length === 0) {
        const firstSeen = now;
        const lastSeen = now;
        const finalUsername = clean;
        await client.execute({
            sql: "INSERT INTO devices (deviceId, username, firmware, boat, firstSeen, lastSeen) VALUES (?, ?, ?, ?, ?, ?)",
            args: [deviceId, finalUsername, cleanFw, null, firstSeen, lastSeen],
        });
        return { deviceId, username: finalUsername, firmware: cleanFw, boat: null, firstSeen, lastSeen };
    } else {
        const row = existing.rows[0];
        const firstSeen = row.firstSeen;
        const newUsername = clean || row.username;
        const newFirmware = cleanFw || row.firmware || null;
        await client.execute({
            sql: "UPDATE devices SET username = ?, firmware = ?, lastSeen = ? WHERE deviceId = ?",
            args: [newUsername, newFirmware, now, deviceId],
        });
        return { deviceId, username: newUsername, firmware: newFirmware, boat: row.boat || null, firstSeen, lastSeen: now };
    }
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
        sql: "SELECT deviceId, username, firmware, boat, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
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
    return { ...row, username: newUsername, boat: newBoat };
}

async function getDevice(deviceId) {
    const client = getClient();
    if (!client) return memDevices.get(deviceId) || null;

    await initDb();
    const res = await client.execute({
        sql: "SELECT deviceId, username, firmware, boat, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
        args: [deviceId],
    });
    return res.rows[0] || null;
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
    const res = await client.execute("SELECT deviceId, username, firmware, boat, firstSeen, lastSeen FROM devices ORDER BY lastSeen DESC");
    return res.rows.map(r => ({ ...r, status: computeStatus(r.lastSeen) }));
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

module.exports = { sanitizeUsername, sanitizeFirmware, sanitizeBoat, upsertDevice, renameDevice, getDevice, getDevices, deleteDevice };

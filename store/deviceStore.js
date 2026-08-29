const { getClient, initDb } = require("./db");

const USERNAME_PATTERN = /^[A-Za-z0-9 ._-]{1,32}$/;

// In-memory fallback when DB not configured
const memDevices = new Map();

function sanitizeUsername(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.trim();
    return USERNAME_PATTERN.test(cleaned) ? cleaned : null;
}

async function upsertDevice(deviceId, { username = null } = {}) {
    if (!deviceId) return null;

    const clean = sanitizeUsername(username);
    const now = new Date().toISOString();
    const client = getClient();

    if (!client) {
        const device = memDevices.get(deviceId) || { deviceId, username: null, firstSeen: now };
        if (clean) device.username = clean;
        device.lastSeen = now;
        memDevices.set(deviceId, device);
        return device;
    }

    await initDb();

    // Try to fetch existing to preserve firstSeen
    const existing = await client.execute({
        sql: "SELECT deviceId, username, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
        args: [deviceId],
    });

    if (existing.rows.length === 0) {
        const firstSeen = now;
        const lastSeen = now;
        const finalUsername = clean;
        await client.execute({
            sql: "INSERT INTO devices (deviceId, username, firstSeen, lastSeen) VALUES (?, ?, ?, ?)",
            args: [deviceId, finalUsername, firstSeen, lastSeen],
        });
        return { deviceId, username: finalUsername, firstSeen, lastSeen };
    } else {
        const row = existing.rows[0];
        const firstSeen = row.firstSeen;
        const newUsername = clean || row.username;
        await client.execute({
            sql: "UPDATE devices SET username = ?, lastSeen = ? WHERE deviceId = ?",
            args: [newUsername, now, deviceId],
        });
        return { deviceId, username: newUsername, firstSeen, lastSeen: now };
    }
}

async function getDevice(deviceId) {
    const client = getClient();
    if (!client) return memDevices.get(deviceId) || null;

    await initDb();
    const res = await client.execute({
        sql: "SELECT deviceId, username, firstSeen, lastSeen FROM devices WHERE deviceId = ?",
        args: [deviceId],
    });
    return res.rows[0] || null;
}

async function getDevices() {
    const client = getClient();
    if (!client) return Array.from(memDevices.values());

    await initDb();
    const res = await client.execute("SELECT deviceId, username, firstSeen, lastSeen FROM devices ORDER BY lastSeen DESC");
    return res.rows;
}

module.exports = { sanitizeUsername, upsertDevice, getDevice, getDevices };

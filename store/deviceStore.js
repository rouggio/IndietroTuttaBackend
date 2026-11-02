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

function isLoopbackIp(v) {
    return v === "localhost" || /^127\./.test(v);
}

// A loopback heartbeat says nothing about where the DEVICE lives on a LAN: on
// Render every request arrives via the proxy as 127.0.0.1, so storing it wiped
// the real address a local heartbeat had learned - and that address is what
// POST /boats/:id/server (and the mock toggle) need to reach the portal. Keep
// the known LAN address and only overwrite it with another real one.
function mergeIp(incoming, stored) {
    if (!incoming) return stored || null;
    if (isLoopbackIp(incoming) && stored && !isLoopbackIp(stored)) return stored;
    return incoming;
}

// lastSeen, kept hot in RAM (todo 67, 2026-11-02).
//
// The session staleness rule asks "has each boat's device been heard from?" on
// every session read - and the hottest of those is the health poll, every 5 s
// while a race is live, which is ALSO what writes lastSeen. Going back to Turso
// for the answer to a question this process just wrote would double the round
// trips on the busiest path in the system, so each heartbeat remembers its own
// timestamp here and only a device this process has not seen recently costs a
// (single, batched) query.
const lastSeenMem = new Map(); // deviceId -> { at, iso }
const LAST_SEEN_TTL_MS = 15000;

function rememberLastSeen(deviceId, iso) {
    if (!deviceId || iso === undefined || iso === null) return;
    lastSeenMem.set(deviceId, { at: Date.now(), iso });
}

// deviceId -> lastSeen (ISO, or "" for a device never heard from: `ensureDevice`
// creates fictive boats that way on purpose, and a phantom must not read as
// present).
async function lastSeenMap(deviceIds) {
    const want = [...new Set((deviceIds || []).filter(Boolean))];
    const out = new Map();
    if (!want.length) return out;
    const now = Date.now();
    const missing = [];
    for (const id of want) {
        const hit = lastSeenMem.get(id);
        if (hit && now - hit.at <= LAST_SEEN_TTL_MS) out.set(id, hit.iso);
        else missing.push(id);
    }
    const client = getClient();
    if (!missing.length || !client) {
        for (const id of missing) if (!out.has(id)) out.set(id, "");
        return out;
    }
    await initDb();
    try {
        const res = await client.execute({
            sql: `SELECT deviceId, lastSeen FROM devices
                  WHERE deviceId IN (${missing.map(() => "?").join(",")})`,
            args: missing,
        });
        for (const r of res.rows) {
            const iso = r.lastSeen || "";
            out.set(r.deviceId, iso);
            rememberLastSeen(r.deviceId, iso);
        }
    } catch (e) {
        // A staleness question must never break a read: unknown reads as unknown.
        console.warn("[DEVICES] lastSeen lookup failed:", e.message || e);
    }
    for (const id of missing) if (!out.has(id)) out.set(id, "");
    return out;
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
        const memIp = mergeIp(ipAddr, device.ip);
        if (memIp) device.ip = memIp;
        device.lastSeen = now;
        memDevices.set(deviceId, device);
        rememberLastSeen(deviceId, now);
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
        rememberLastSeen(deviceId, lastSeen);
        return { deviceId, username: finalUsername, firmware: cleanFw, boat: null, ip: ipAddr, mock: 0, firstSeen, lastSeen };
    } else {        const row = existing.rows[0];
        const firstSeen = row.firstSeen;
        const newUsername = clean || row.username;
        const newFirmware = cleanFw || row.firmware || null;
        const newIp = mergeIp(ipAddr, row.ip);
        await client.execute({
            sql: "UPDATE devices SET username = ?, firmware = ?, ip = ?, lastSeen = ? WHERE deviceId = ?",
            args: [newUsername, newFirmware, newIp, now, deviceId],
        });
        rememberLastSeen(deviceId, now);
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

// A boat a session DECLARES that the server has never seen (todo 55): record it
// immediately under a readable, obviously fictive name, so it is visible in the
// boat list and can be given its real details later. Three rules:
//   - it never overwrites an existing row (`INSERT OR IGNORE`), because a
//     declaration is not a fact about the boat;
//   - it carries NO last-seen claim. `devices.lastSeen` is NOT NULL, so the
//     "never heard from" value is the empty string: `computeStatus("")` reads
//     `offline`, the boat list prints "-", and declaring a boat can never paint
//     it live on the map (the migration-free way to say "no heartbeat yet");
//   - it is not a mock and has no ip: nothing is assumed about it.
async function ensureDevice(deviceId, fictiveName) {
    if (!deviceId) return null;
    const clean = sanitizeUsername(fictiveName);
    const now = new Date().toISOString();
    const client = getClient();
    if (!client) {
        const have = memDevices.get(deviceId);
        if (have) return have;
        const row = {
            deviceId, username: clean, firmware: null, boat: null, ip: null,
            mock: 0, firstSeen: now, lastSeen: "",
        };
        memDevices.set(deviceId, row);
        return row;
    }
    await initDb();
    await client.execute({
        sql: `INSERT OR IGNORE INTO devices
                (deviceId, username, firmware, boat, ip, mock, firstSeen, lastSeen)
              VALUES (?, ?, NULL, NULL, NULL, 0, ?, '')`,
        args: [deviceId, clean, now],
    });
    return getDevice(deviceId);
}

// The fictive label for an unknown boat: "Boat EE02". Last four hex chars of the
// id, which is enough to tell two phantoms apart on screen and fits the
// username whitelist (a MAC's colons do not).
function fictiveName(deviceId) {
    const tail = String(deviceId || "").replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase();
    return tail ? `Boat ${tail}` : "Boat";
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

module.exports = { sanitizeUsername, sanitizeFirmware, sanitizeBoat, upsertDevice, setDeviceMock, renameDevice, getDevice, getDevices, deleteDevice, ensureDevice, fictiveName, lastSeenMap };

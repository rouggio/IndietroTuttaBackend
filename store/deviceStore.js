const devices = new Map();

// Usernames are display labels rendered in the browser without escaping,
// so enforce a strict whitelist: letters, digits, space, dot, underscore,
// dash. Max 32 chars (mirrors MAX_USERNAME_LEN on the device).
const USERNAME_PATTERN = /^[A-Za-z0-9 ._-]{1,32}$/;

function sanitizeUsername(value) {
    if (typeof value !== "string")
        return null;

    const cleaned = value.trim();

    return USERNAME_PATTERN.test(cleaned) ? cleaned : null;
}

function upsertDevice(deviceId, { username = null } = {}) {
    if (!deviceId)
        return null;

    const now = new Date().toISOString();

    const device = devices.get(deviceId) || {
        deviceId,
        username: null,
        firstSeen: now
    };

    const clean = sanitizeUsername(username);

    if (clean)
        device.username = clean;

    device.lastSeen = now;
    devices.set(deviceId, device);

    return device;
}

function getDevice(deviceId) {
    return devices.get(deviceId) || null;
}

function getDevices() {
    return Array.from(devices.values());
}

module.exports = {
    sanitizeUsername,
    upsertDevice,
    getDevice,
    getDevices
};

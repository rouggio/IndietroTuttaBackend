const { getClient, initDb } = require("./db");

// In-memory fallback
const memPoints = [];

const UID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function sanitizeUid(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.trim();
    return UID_PATTERN.test(cleaned) ? cleaned : null;
}

async function addPoint(point) {
    const client = getClient();
    const cleanUid = sanitizeUid(point.uid);
    const stored = { ...point, uid: cleanUid };
    if (!client) {
        memPoints.push(stored);
        return stored;
    }

    await initDb();

    const flaggedInt = stored.flagged ? 1 : 0;

    await client.execute({
        sql: `INSERT INTO gps_points (deviceId, username, lat, lon, speed, course, altitude, sats, flagged, uid, timestamp, receivedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            stored.deviceId || null,
            stored.username || null,
            stored.lat,
            stored.lon,
            stored.speed,
            stored.course,
            stored.altitude,
            stored.sats,
            flaggedInt,
            cleanUid,
            stored.timestamp || new Date().toISOString(),
            stored.receivedAt || new Date().toISOString(),
        ],
    });

    // No cap: keep every point.
    return stored;
}

async function getPoints(filter = {}) {
    const client = getClient();
    const { date, deviceId, start, end } = filter;

    if (!client) {
        let pts = memPoints;
        if (start) {
            const s = new Date(start).getTime();
            if (!isNaN(s)) pts = pts.filter(p => new Date(p.timestamp || p.receivedAt || 0).getTime() >= s);
        }
        if (end) {
            const e = new Date(end).getTime();
            if (!isNaN(e)) pts = pts.filter(p => new Date(p.timestamp || p.receivedAt || 0).getTime() <= e);
        } else if (date) pts = pts.filter(p => (p.timestamp || p.receivedAt || "").slice(0, 10) === date);
        if (deviceId) pts = pts.filter(p => p.deviceId === deviceId);
        return pts;
    }

    await initDb();

    let sql = "SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, flagged, uid, timestamp, receivedAt FROM gps_points WHERE 1=1";
    const args = [];

    if (start) {
        // ISO timestamp range filter — takes precedence over date
        sql += " AND timestamp >= ?";
        args.push(new Date(start).toISOString());
    }
    if (end) {
        sql += " AND timestamp <= ?";
        args.push(new Date(end).toISOString());
    }
    if (!start && !end && date) {
        sql += " AND substr(timestamp,1,10) = ?";
        args.push(date);
    }
    if (deviceId) {
        sql += " AND deviceId = ?";
        args.push(deviceId);
    }

    sql += " ORDER BY id ASC";

    const res = await client.execute({ sql, args });
    return res.rows.map(r => ({ ...r, flagged: !!r.flagged }));
}

// Backward compat: getPoints() with no filter returns all
// New: getPoints({date, deviceId}) filters

async function getLatestPoint(deviceId = null) {
    const client = getClient();
    if (!client) {
        if (memPoints.length === 0) return null;
        if (deviceId) {
            for (let i = memPoints.length - 1; i >= 0; i--) {
                if (memPoints[i].deviceId === deviceId) return memPoints[i];
            }
            return null;
        }
        return memPoints[memPoints.length - 1];
    }

    await initDb();
    if (deviceId) {
        const res = await client.execute({ sql: "SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, flagged, uid, timestamp, receivedAt FROM gps_points WHERE deviceId = ? ORDER BY id DESC LIMIT 1", args: [deviceId] });
        if (res.rows.length === 0) return null;
        const r = res.rows[0];
        return { ...r, flagged: !!r.flagged };
    } else {
        const res = await client.execute("SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, flagged, uid, timestamp, receivedAt FROM gps_points ORDER BY id DESC LIMIT 1");
        if (res.rows.length === 0) return null;
        const r = res.rows[0];
        return { ...r, flagged: !!r.flagged };
    }
}

async function getPointCount() {
    const client = getClient();
    if (!client) return memPoints.length;

    await initDb();
    const res = await client.execute("SELECT COUNT(*) as cnt FROM gps_points");
    return res.rows[0].cnt;
}

// Delete the flagged point for deviceId with the exact uid (device waypoint delete).
// Returns deleted row id or null when nothing matches.
async function deleteFlaggedByUid(deviceId, uid) {
    if (!deviceId || typeof uid !== "string" || !uid) return null;

    const client = getClient();
    if (!client) {
        const idx = memPoints.findIndex(p => p.deviceId === deviceId && p.uid === uid);
        if (idx < 0) return null;
        const [gone] = memPoints.splice(idx, 1);
        return gone.id ?? true;
    }

    await initDb();
    const res = await client.execute({
        sql: "SELECT id FROM gps_points WHERE deviceId = ? AND uid = ? LIMIT 1",
        args: [deviceId, uid],
    });
    if (res.rows.length === 0) return null;
    await client.execute({ sql: "DELETE FROM gps_points WHERE id = ?", args: [res.rows[0].id] });
    return res.rows[0].id;
}

module.exports = { addPoint, getPoints, getLatestPoint, getPointCount, deleteFlaggedByUid };


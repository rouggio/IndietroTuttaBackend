const { GPS } = require("../config");
const { getClient, initDb } = require("./db");

// In-memory fallback
const memPoints = [];

async function addPoint(point) {
    const client = getClient();
    if (!client) {
        memPoints.push(point);
        while (memPoints.length > GPS.MAX_POINTS) memPoints.shift();
        return point;
    }

    await initDb();

    const flaggedInt = point.flagged ? 1 : 0;

    await client.execute({
        sql: `INSERT INTO gps_points (deviceId, username, lat, lon, speed, course, altitude, sats, flagged, timestamp, receivedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            point.deviceId || null,
            point.username || null,
            point.lat,
            point.lon,
            point.speed,
            point.course,
            point.altitude,
            point.sats,
            flaggedInt,
            point.timestamp || new Date().toISOString(),
            point.receivedAt || new Date().toISOString(),
        ],
    });

    // Trim to MAX_POINTS (keep newest)
    const countRes = await client.execute("SELECT COUNT(*) as cnt FROM gps_points");
    const cnt = countRes.rows[0].cnt;
    if (cnt > GPS.MAX_POINTS) {
        const toDelete = cnt - GPS.MAX_POINTS;
        await client.execute({
            sql: `DELETE FROM gps_points WHERE id IN (SELECT id FROM gps_points ORDER BY id ASC LIMIT ?)`,
            args: [toDelete],
        });
    }

    return point;
}

async function getPoints(filter = {}) {
    const client = getClient();
    const { date, deviceId } = filter;

    if (!client) {
        let pts = memPoints;
        if (date) pts = pts.filter(p => (p.timestamp || p.receivedAt || "").slice(0, 10) === date);
        if (deviceId) pts = pts.filter(p => p.deviceId === deviceId);
        return pts;
    }

    await initDb();

    let sql = "SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, flagged, timestamp, receivedAt FROM gps_points WHERE 1=1";
    const args = [];

    if (date) {
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
        const res = await client.execute({ sql: "SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, flagged, timestamp, receivedAt FROM gps_points WHERE deviceId = ? ORDER BY id DESC LIMIT 1", args: [deviceId] });
        if (res.rows.length === 0) return null;
        const r = res.rows[0];
        return { ...r, flagged: !!r.flagged };
    } else {
        const res = await client.execute("SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, flagged, timestamp, receivedAt FROM gps_points ORDER BY id DESC LIMIT 1");
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

module.exports = { addPoint, getPoints, getLatestPoint, getPointCount };

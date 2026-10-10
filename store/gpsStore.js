const { getClient, initDb } = require("./db");

// In-memory fallback
const memPoints = [];

async function addPoint(point) {
    const client = getClient();
    // Normalize: device sends JSON true/false; legacy/odd values → 0/1
    const simInt = Number(point.simulated) ? 1 : 0;
    const stored = { ...point, simulated: simInt };
    if (!client) {
        memPoints.push(stored);
        return stored;
    }

    await initDb();

    await client.execute({
        sql: `INSERT INTO gps_points (deviceId, username, lat, lon, speed, course, altitude, sats, simulated, timestamp, receivedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            stored.deviceId || null,
            stored.username || null,
            stored.lat,
            stored.lon,
            stored.speed,
            stored.course,
            stored.altitude,
            stored.sats,
            simInt,
            stored.timestamp || new Date().toISOString(),
            stored.receivedAt || new Date().toISOString(),
        ],
    });

    // No cap: keep every point.
    return stored;
}

async function getPoints(filter = {}) {
    const client = getClient();
    const { date, deviceId, start, end, since } = filter;
    // Live-append cursor: exclusive tail, capped like the sim-live precedent.
    const SINCE_CAP = 2000;

    if (!client) {
        let pts = memPoints;
        if (since) {
            const s = new Date(since).getTime();
            if (!isNaN(s)) pts = pts.filter(p => new Date(p.timestamp || p.receivedAt || 0).getTime() > s);
        } else {
            if (start) {
                const s = new Date(start).getTime();
                if (!isNaN(s)) pts = pts.filter(p => new Date(p.timestamp || p.receivedAt || 0).getTime() >= s);
            }
            if (end) {
                const e = new Date(end).getTime();
                if (!isNaN(e)) pts = pts.filter(p => new Date(p.timestamp || p.receivedAt || 0).getTime() <= e);
            } else if (date) pts = pts.filter(p => (p.timestamp || p.receivedAt || "").slice(0, 10) === date);
        }
        if (deviceId) pts = pts.filter(p => p.deviceId === deviceId);
        if (since) pts = pts.slice(-SINCE_CAP);
        return pts;
    }

    await initDb();

    let sql = "SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, simulated, timestamp, receivedAt FROM gps_points WHERE 1=1";
    const args = [];

    if (since) {
        // Live-append mode: `since` wins over start/end/date (exclusive cursor).
        sql += " AND timestamp > ?";
        args.push(new Date(since).toISOString());
    } else {
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
    }
    if (deviceId) {
        sql += " AND deviceId = ?";
        args.push(deviceId);
    }
    sql += " ORDER BY id ASC";
    if (since) sql += ` LIMIT ${SINCE_CAP}`;

    const res = await client.execute({ sql, args });
    return res.rows.map(r => ({ ...r, simulated: Number(r.simulated) ? 1 : 0 }));
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
        const res = await client.execute({ sql: "SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, simulated, timestamp, receivedAt FROM gps_points WHERE deviceId = ? ORDER BY id DESC LIMIT 1", args: [deviceId] });
        if (res.rows.length === 0) return null;
        const r = res.rows[0];
        return { ...r, simulated: Number(r.simulated) ? 1 : 0 };
    } else {
        const res = await client.execute("SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, simulated, timestamp, receivedAt FROM gps_points ORDER BY id DESC LIMIT 1");
        if (res.rows.length === 0) return null;
        const r = res.rows[0];
        return { ...r, simulated: Number(r.simulated) ? 1 : 0 };
    }
}

// Days (UTC YYYY-MM-DD) that have at least one point for a device,
// with point counts — powers the per-boat calendar.
async function getActiveDays(deviceId) {
    const client = getClient();
    if (!client) {
        const counts = new Map();
        for (const p of memPoints) {
            if (deviceId && p.deviceId !== deviceId) continue;
            const day = (p.timestamp || p.receivedAt || "").slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
            counts.set(day, (counts.get(day) || 0) + 1);
        }
        return [...counts.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([day, count]) => ({ day, count }));
    }

    await initDb();
    const res = await client.execute({
        sql: "SELECT substr(timestamp,1,10) AS day, COUNT(*) AS count FROM gps_points WHERE deviceId = ? GROUP BY day ORDER BY day ASC",
        args: [deviceId],
    });
    return res.rows.map(r => ({ day: r.day, count: Number(r.count) }));
}

async function getPointCount() {
    const client = getClient();
    if (!client) return memPoints.length;

    await initDb();
    const res = await client.execute("SELECT COUNT(*) as cnt FROM gps_points");
    return res.rows[0].cnt;
}

// ------------------------------------------------------------------
// Ephemeral sim slot: mock uploads live here ONLY (never Turso).
// One latest point per boat — no history anywhere, so a refresh can
// only ever pick up upcoming fixes. Lost on restart.
// ------------------------------------------------------------------
const memSim = new Map(); // deviceId -> latest point

function pushSimPoint(point) {
    const id = point.deviceId || "unknown";
    const stored = { ...point, simulated: 1, receivedAt: point.receivedAt || new Date().toISOString() };
    memSim.set(id, stored);
    return stored;
}

function getSimSince(deviceId) {
    const p = memSim.get(deviceId);
    return p ? [p] : [];
}

module.exports = { addPoint, getPoints, getLatestPoint, getPointCount, getActiveDays, pushSimPoint, getSimSince };


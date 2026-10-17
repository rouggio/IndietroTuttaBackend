const { getClient, initDb } = require("./db");

// --------------------------------------------------
// Persisted scripted routes (the mock boat's sailed track).
//
// A scripted run lives in memory only, and `pruneRuns` drops it 10 minutes
// after it ends. That was fine while the only consumer was "is the boat
// moving right now", but it means a FINISHED session has no track at all:
// mock uploads never reach gps_points (they go to the ephemeral slot by
// design), so once the run is pruned there is nothing anywhere to draw.
// Selecting a finished session showed an empty map.
//
// So the compiled route is written once, at run creation, and read back by
// SESSION id. Session-keyed matters: the frontend only knows which session
// is selected, so a route reachable only by run id is unreachable exactly
// when it is needed — after the run has been pruned.
//
// One row per session, the samples as a JSON array. Races are minutes long
// and a few hundred points, so normalising them into rows would buy nothing.
// --------------------------------------------------

const memRoutes = new Map(); // sessionId -> route

const DOWNSAMPLE_EVERY = 5; // match GET /sim/runs/:id/points

function rowToRoute(row) {
    if (!row) return null;
    let samples;
    try {
        samples = JSON.parse(row.samples);
    } catch {
        samples = [];
    }
    if (!Array.isArray(samples)) samples = [];
    return {
        runId: row.runId,
        sessionId: row.sessionId,
        deviceId: row.deviceId,
        startMs: row.startMs,
        gunMs: row.gunMs,
        durationSec: row.durationSec,
        createdAt: row.createdAt,
        samples,
    };
}

// Same shape the in-memory points endpoint returns, so the map code does not
// care where the samples came from.
function toPoints(samples) {
    if (!Array.isArray(samples) || !samples.length) return [];
    const out = [];
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (i % DOWNSAMPLE_EVERY === 0 || i === samples.length - 1) {
            out.push({ t: s.t, lat: +Number(s.lat).toFixed(7), lon: +Number(s.lon).toFixed(7) });
        }
    }
    return out;
}

async function saveRoute({ runId, sessionId, deviceId, startMs, gunMs, durationSec, samples }) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return null;
    const route = {
        runId, sessionId: sid, deviceId: deviceId || null,
        startMs: startMs || 0, gunMs: gunMs || 0,
        durationSec: durationSec || 0,
        createdAt: new Date().toISOString(),
        samples: Array.isArray(samples) ? samples : [],
    };
    memRoutes.set(sid, route);
    const client = getClient();
    if (!client) return route;
    await initDb();
    // One row per session: a repeat start replaces the route rather than
    // accumulating them.
    await client.execute({
        sql: `INSERT INTO sim_routes (runId, sessionId, deviceId, startMs, gunMs, durationSec, createdAt, samples)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(sessionId) DO UPDATE SET
                runId=excluded.runId, deviceId=excluded.deviceId, startMs=excluded.startMs,
                gunMs=excluded.gunMs, durationSec=excluded.durationSec, samples=excluded.samples`,
        args: [
            route.runId, route.sessionId, route.deviceId, route.startMs,
            route.gunMs, route.durationSec, route.createdAt, JSON.stringify(route.samples),
        ],
    });
    return route;
}

async function getRoute(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return null;
    const client = getClient();
    if (!client) return memRoutes.get(sid) || null;
    await initDb();
    const res = await client.execute({
        sql: "SELECT * FROM sim_routes WHERE sessionId = ?",
        args: [sid],
    });
    const fromDb = rowToRoute(res.rows[0]);
    if (fromDb) return fromDb;
    return memRoutes.get(sid) || null;
}

async function getRoutePoints(sessionId) {
    const r = await getRoute(sessionId);
    if (!r) return null;
    return {
        runId: r.runId,
        sessionId: r.sessionId,
        deviceId: r.deviceId,
        startMs: r.startMs,
        gunMs: r.gunMs,
        durationSec: r.durationSec,
        points: toPoints(r.samples),
    };
}

// Called when a session is deleted so the table cannot accumulate orphans.
// Returns how many rows went (0 when there were none) — the delete response
// reports it, so the operator sees what the cascade actually did.
async function deleteRoutesForSession(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return 0;
    const had = memRoutes.delete(sid) ? 1 : 0;
    const client = getClient();
    if (!client) return had;
    await initDb();
    // Counted before the delete: libSQL's rowsAffected is not a row count.
    const c = await client.execute({ sql: "SELECT COUNT(*) AS n FROM sim_routes WHERE sessionId = ?", args: [sid] });
    const n = Number(c.rows[0].n) || 0;
    if (n) await client.execute({ sql: "DELETE FROM sim_routes WHERE sessionId = ?", args: [sid] });
    return n;
}

module.exports = { saveRoute, getRoute, getRoutePoints, deleteRoutesForSession, toPoints };
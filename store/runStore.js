const { getClient } = require("./db");
const { initDb } = require("./db");

// --------------------------------------------------
// Run uploads (Step 5/6): devices POST their race log at finish.
// events: [{t (epoch s), e (code), v?}] — codes: START, OCS, RECROSS,
// WRONG, TURN360, TURN720, PASS, FINISH, SIG (committee signal applied).
// splits: [sec, ...] per rounding index. result: FINISHED|DSQ|DNF|RET.
// In-memory Map fallback mirrors the other stores.
// --------------------------------------------------

const memRuns = [];
let memId = 1;

const VALID_RESULTS = new Set(["FINISHED", "DSQ", "DNF", "RET"]);

function cleanRun(b) {
    const sessionId = parseInt(b.sessionId, 10);
    if (!sessionId || sessionId < 1) throw { status: 400, message: "bad sessionId" };
    const deviceId = String(b.deviceId || "").slice(0, 64);
    if (!deviceId) throw { status: 400, message: "deviceId required" };
    const startEpoch = Math.floor(Number(b.startEpoch));
    if (!startEpoch || startEpoch < 946684800) throw { status: 400, message: "bad startEpoch" };
    const finishEpoch = b.finishEpoch == null ? null : Math.floor(Number(b.finishEpoch));
    const splits = Array.isArray(b.splits) ? b.splits.map(Number).filter(n => Number.isFinite(n)).slice(0, 32) : [];
    const events = Array.isArray(b.events)
        ? b.events.filter(e => e && Number.isFinite(Number(e.t)) && typeof e.e === "string")
            .map(e => ({ t: Math.floor(Number(e.t)), e: String(e.e).slice(0, 12), v: e.v == null ? null : String(e.v).slice(0, 32) }))
            .slice(0, 96)
        : [];
    const result = VALID_RESULTS.has(b.result) ? b.result : "FINISHED";
    // One run per device per session: a re-upload replaces (device retries).
    return { sessionId, deviceId, startEpoch, finishEpoch, splits, events, result };
}

async function submitRun(body) {
    const r = cleanRun(body || {});
    const elapsedSec = r.finishEpoch != null ? r.finishEpoch - r.startEpoch : null;
    const now = new Date().toISOString();
    const client = getClient();
    if (!client) {
        const ix = memRuns.findIndex(x => x.sessionId === r.sessionId && x.deviceId === r.deviceId);
        const row = { id: ix >= 0 ? memRuns[ix].id : memId++, ...r, elapsedSec, createdAt: now };
        if (ix >= 0) memRuns[ix] = row; else memRuns.push(row);
        return row;
    }
    await initDb();
    await client.execute({
        sql: `INSERT INTO runs (sessionId, deviceId, startEpoch, finishEpoch, elapsedSec, splits, events, result, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(sessionId, deviceId) DO UPDATE SET
                startEpoch=excluded.startEpoch, finishEpoch=excluded.finishEpoch,
                elapsedSec=excluded.elapsedSec, splits=excluded.splits, events=excluded.events,
                result=excluded.result, createdAt=excluded.createdAt`,
        args: [r.sessionId, r.deviceId, r.startEpoch, r.finishEpoch, elapsedSec,
            JSON.stringify(r.splits), JSON.stringify(r.events), r.result, now],
    });
    const got = await client.execute({
        sql: `SELECT * FROM runs WHERE sessionId = ? AND deviceId = ?`,
        args: [r.sessionId, r.deviceId],
    });
    return rowToRun(got.rows[0]);
}

function rowToRun(row) {
    return {
        id: row.id,
        sessionId: row.sessionId,
        deviceId: row.deviceId,
        startEpoch: row.startEpoch,
        finishEpoch: row.finishEpoch,
        elapsedSec: row.elapsedSec,
        splits: safeJson(row.splits),
        events: safeJson(row.events),
        result: row.result,
        createdAt: row.createdAt,
    };
}

function safeJson(t) {
    try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; }
    catch { return []; }
}

async function listRuns(sessionId) {    const sid = parseInt(sessionId, 10);
    if (!sid) return [];
    const client = getClient();
    if (!client) return memRuns.filter(r => r.sessionId === sid).sort((a, b) => (a.elapsedSec ?? 9e9) - (b.elapsedSec ?? 9e9));
    await initDb();
    const res = await client.execute({
        sql: `SELECT * FROM runs WHERE sessionId = ? ORDER BY
              CASE WHEN result = 'FINISHED' THEN 0 ELSE 1 END,
              elapsedSec ASC NULLS LAST`,
        args: [sid],
    });
    return res.rows.map(rowToRun);
}

module.exports = { submitRun, listRuns, uploaders, uploadersBySession, deleteRunsForSession };

// Session-delete cascade (todo 33): a session takes its runs with it. The
// count is taken BEFORE the delete because libSQL's rowsAffected is not a row
// count (gpsStore.deletePoints hit the same thing and recounts for the same
// reason) — the caller reports it, so a wrong number would be a wrong report.
async function deleteRunsForSession(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return 0;
    const client = getClient();
    if (!client) {
        const before = memRuns.length;
        for (let i = memRuns.length - 1; i >= 0; i--) {
            if (memRuns[i].sessionId === sid) memRuns.splice(i, 1);
        }
        return before - memRuns.length;
    }
    await initDb();
    const c = await client.execute({ sql: "SELECT COUNT(*) AS n FROM runs WHERE sessionId = ?", args: [sid] });
    const n = Number(c.rows[0].n) || 0;
    if (n) await client.execute({ sql: "DELETE FROM runs WHERE sessionId = ?", args: [sid] });
    return n;
}

// DeviceIds with at least one uploaded run (a run means that boat's race
// is over — finished, DSQ, DNF or RET). Used to infer session status.
async function uploaders(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return [];
    const client = getClient();
    if (!client) return memRuns.filter(r => r.sessionId === sid).map(r => r.deviceId);
    await initDb();
    const res = await client.execute({
        sql: `SELECT DISTINCT deviceId FROM runs WHERE sessionId = ?`,
        args: [sid],
    });
    return res.rows.map(r => r.deviceId);
}

// Batched form for the sessions LIST, which needs this for every row at
// once. The per-id version above made GET /sessions cost one round trip
// per session (with getBoats + terminalBoats that is 3N sequential trips
// — measured 1.5s for 8 rows). Returns Map<sessionId, Set<deviceId>>.
async function uploadersBySession(sessionIds) {
    const ids = [...new Set((sessionIds || []).map(Number).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    for (const id of ids) out.set(id, new Set());
    const client = getClient();
    if (!client) {
        for (const r of memRuns) {
            if (out.has(r.sessionId) && r.deviceId) out.get(r.sessionId).add(r.deviceId);
        }
        return out;
    }
    await initDb();
    const ph = ids.map(() => "?").join(",");
    const res = await client.execute({
        sql: `SELECT DISTINCT sessionId, deviceId FROM runs WHERE sessionId IN (${ph})`,
        args: ids,
    });
    for (const r of res.rows) {
        const set = out.get(Number(r.sessionId));
        if (set && r.deviceId) set.add(r.deviceId);
    }
    return out;
}

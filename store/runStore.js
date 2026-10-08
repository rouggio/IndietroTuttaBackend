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

async function listRuns(sessionId) {
    const sid = parseInt(sessionId, 10);
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

module.exports = { submitRun, listRuns };

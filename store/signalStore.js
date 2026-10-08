const { getClient } = require("./db");
const { initDb } = require("./db");

// --------------------------------------------------
// Committee signals (Step 7): raised from the frontend, delivered to
// devices via the health-piggybacked session (fast-polled when live).
// kind: OCS | DSQ | DNF | RET | SCP | RECALL | ABANDON
// deviceId null = fleet-wide (RECALL/ABANDON). SCP carries seconds in detail.
// Devices apply idempotently by signal id. In-memory fallback included.
// --------------------------------------------------

const memSignals = [];
let memId = 1;

const VALID_KINDS = new Set(["OCS", "DSQ", "DNF", "RET", "SCP", "RECALL", "ABANDON"]);

function cleanSignal(sessionId, b) {
    const sid = parseInt(sessionId, 10);
    if (!sid || sid < 1) throw { status: 400, message: "bad session id" };
    const kind = String(b.kind || "").toUpperCase();
    if (!VALID_KINDS.has(kind)) throw { status: 400, message: "bad kind (OCS|DSQ|DNF|RET|SCP|RECALL|ABANDON)" };
    const fleetWide = kind === "RECALL" || kind === "ABANDON";
    const deviceId = fleetWide ? null : String(b.deviceId || "").slice(0, 64) || null;
    if (!fleetWide && !deviceId) throw { status: 400, message: "deviceId required for boat signals" };
    const detail = String(b.detail ?? "").slice(0, 64);
    return { sessionId: sid, kind, deviceId, detail };
}

function rowToSignal(row) {
    return {
        id: row.id,
        sessionId: row.sessionId,
        kind: row.kind,
        deviceId: row.deviceId,
        detail: row.detail,
        createdAt: row.createdAt,
    };
}

async function raiseSignal(sessionId, body) {
    const s = cleanSignal(sessionId, body || {});
    const now = new Date().toISOString();
    const client = getClient();
    if (!client) {
        const row = { id: memId++, ...s, createdAt: now };
        memSignals.push(row);
        return row;
    }
    await initDb();
    const res = await client.execute({
        sql: `INSERT INTO signals (sessionId, kind, deviceId, detail, createdAt)
              VALUES (?, ?, ?, ?, ?) RETURNING *`,
        args: [s.sessionId, s.kind, s.deviceId, s.detail, now],
    });
    return rowToSignal(res.rows[0]);
}

async function listSignals(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return [];
    const client = getClient();
    if (!client) return memSignals.filter(s => s.sessionId === sid).sort((a, b) => a.id - b.id);
    await initDb();
    const res = await client.execute({
        sql: `SELECT * FROM signals WHERE sessionId = ? ORDER BY id ASC LIMIT 50`,
        args: [sid],
    });
    return res.rows.map(rowToSignal);
}

// Trimmed for the firmware piggyback: latest 20, oldest first (apply in order).
async function signalsForDevice(sessionId, deviceId) {
    const all = await listSignals(sessionId);
    return all.filter(s => !s.deviceId || s.deviceId === deviceId).slice(-20);
}

module.exports = { raiseSignal, listSignals, signalsForDevice, terminalBoats };

// Boats with a terminal committee signal (DSQ/DNF/RET): their race is over
// even without an uploaded run. Used to infer session finish.
async function terminalBoats(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return [];
    const client = getClient();
    if (!client) {
        return [...new Set(memSignals
            .filter(s => s.sessionId === sid && ["DSQ", "DNF", "RET"].includes(s.kind) && s.deviceId)
            .map(s => s.deviceId))];
    }
    await initDb();
    const res = await client.execute({
        sql: `SELECT DISTINCT deviceId FROM signals WHERE sessionId = ? AND kind IN ('DSQ','DNF','RET') AND deviceId IS NOT NULL`,
        args: [sid],
    });
    return res.rows.map(r => r.deviceId);
}

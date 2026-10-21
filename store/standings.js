const { getClient, initDb } = require("./db");
const { listRuns } = require("./runStore");
const { listSignals } = require("./signalStore");
const { getBoats } = require("./sessionStore");

// --------------------------------------------------
// Standings (todo 3, the minimal slice).
//
// One rule set, used twice: the session-detail pane shows a PROVISIONAL table
// while the race is on (computed from runs + signals on the fly, nothing
// stored), and the same computation is FROZEN into `session_results` by the
// event that closes the race. Nothing here invents data: runs carry elapsed
// time and splits, signals carry the committee's decisions.
//
// corrected = elapsed + the SCP seconds raised against that boat.
// A DSQ/DNF/RET signal OUTRANKS the uploaded run's own result — the committee
// can disqualify a boat that crossed the line, and the run would still say
// FINISHED.
// Order: finishers by corrected time, then boats still racing, then DNF/RET,
// then DSQ. Only finishers get a rank; everything else prints as "–", which is
// what the results table always did.
// --------------------------------------------------

const TERMINAL = new Set(["DSQ", "DNF", "RET"]);
// Sort class per result. DNF and RET share a class: both are "stopped, but not
// disqualified", and elapsed time breaks the tie when there is one.
const CLASS = { FINISHED: 0, RACING: 1, DNF: 2, RET: 2, DSQ: 3 };

// Pure: boats in, standings out. Kept separate from the fetches so
// tools/check-standings.js can prove the rules without a database.
function rankRows(boats, runs, signals) {
    const rows = new Map();
    const row = (deviceId) => {
        if (!rows.has(deviceId)) {
            rows.set(deviceId, { deviceId, run: null, penaltySec: 0, signalResult: null });
        }
        return rows.get(deviceId);
    };
    // Participants first, so a boat that has not uploaded anything yet still
    // appears (as RACING) instead of vanishing from its own race.
    for (const b of boats || []) if (b && b.deviceId) row(b.deviceId);
    for (const r of runs || []) if (r && r.deviceId) row(r.deviceId).run = r;
    for (const g of signals || []) {
        if (!g || !g.deviceId) continue;         // fleet-wide signals are not per boat
        const t = rows.get(g.deviceId);
        if (!t) continue;                        // a signal for a boat that left the session
        if (g.kind === "SCP") {
            const sec = Math.round(Number(g.detail));
            if (Number.isFinite(sec) && sec > 0) t.penaltySec += sec;
        }
        if (TERMINAL.has(g.kind)) t.signalResult = g.kind;
    }
    const out = [...rows.values()].map(t => {
        const result = t.signalResult || (t.run && t.run.result) || "RACING";
        const elapsedSec = t.run && t.run.elapsedSec != null ? t.run.elapsedSec : null;
        return {
            deviceId: t.deviceId,
            result,
            elapsedSec,
            penaltySec: t.penaltySec,
            correctedSec: elapsedSec == null ? null : elapsedSec + t.penaltySec,
            splits: (t.run && t.run.splits) || [],
            rank: null,
        };
    });
    const time = r => (r.correctedSec != null ? r.correctedSec : 9e9);
    out.sort((a, b) => {
        const ca = CLASS[a.result] ?? 1, cb = CLASS[b.result] ?? 1;
        if (ca !== cb) return ca - cb;
        if (time(a) !== time(b)) return time(a) - time(b);
        return String(a.deviceId).localeCompare(String(b.deviceId));
    });
    let rank = 0;
    for (const r of out) if (r.result === "FINISHED") r.rank = ++rank;
    return out;
}

async function computeStandings(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return [];
    const [boats, runs, signals] = await Promise.all([
        getBoats(sid), listRuns(sid), listSignals(sid),
    ]);
    return rankRows(boats, runs, signals);
}

// --------------------------------------------------
// The frozen snapshot. `session_results` holds one row per boat; a re-finalize
// REPLACES the set (a device that re-uploads its run after the finish must not
// leave half an old table behind).
// --------------------------------------------------

const memResults = new Map();   // sessionId -> array of rows

function rowToResult(r) {
    return {
        deviceId: r.deviceId,
        rank: r.rank == null ? null : Number(r.rank),
        result: r.result,
        elapsedSec: r.elapsedSec == null ? null : Number(r.elapsedSec),
        penaltySec: Number(r.penaltySec) || 0,
        correctedSec: r.correctedSec == null ? null : Number(r.correctedSec),
        splits: safeJson(r.splits),
        computedAt: r.computedAt,
    };
}

function safeJson(t) {
    if (Array.isArray(t)) return t;
    try {
        const v = JSON.parse(t);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

async function readStandings(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return [];
    const client = getClient();
    if (!client) return (memResults.get(sid) || []).map(r => ({ ...r }));
    await initDb();
    const res = await client.execute({
        sql: `SELECT * FROM session_results WHERE sessionId = ?
              ORDER BY CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank ASC, deviceId ASC`,
        args: [sid],
    });
    return res.rows.map(rowToResult);
}

async function saveStandings(sessionId, standings) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return 0;
    const computedAt = new Date().toISOString();
    const rows = (standings || []).map(r => ({ ...r, sessionId: sid, computedAt }));
    const client = getClient();
    if (!client) {
        memResults.set(sid, rows);
        return rows.length;
    }
    await initDb();
    // Replace, never append: an empty result set must clear an old one too.
    await client.execute({ sql: "DELETE FROM session_results WHERE sessionId = ?", args: [sid] });
    for (const r of rows) {
        await client.execute({
            sql: `INSERT INTO session_results
                    (sessionId, deviceId, rank, result, elapsedSec, penaltySec, correctedSec, splits, computedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [sid, r.deviceId, r.rank, r.result, r.elapsedSec, r.penaltySec,
                r.correctedSec, JSON.stringify(r.splits || []), computedAt],
        });
    }
    return rows.length;
}

// Freeze the result of a race that has just closed. Idempotent: called from the
// run upload that completes the set, so the record is written by the same event
// that made it final.
async function finalizeStandings(sessionId) {
    const standings = await computeStandings(sessionId);
    await saveStandings(sessionId, standings);
    return standings;
}

// The pane's one call: the frozen table when the race is closed, a provisional
// one computed now when it is not. `final` is what the UI labels the table with.
async function getStandings(sessionId) {
    const stored = await readStandings(sessionId);
    if (stored.length) {
        return { final: true, computedAt: stored[0].computedAt || null, standings: stored };
    }
    return { final: false, computedAt: null, standings: await computeStandings(sessionId) };
}

async function deleteStandingsForSession(sessionId) {
    const sid = parseInt(sessionId, 10);
    if (!sid) return 0;
    const client = getClient();
    if (!client) {
        const had = memResults.delete(sid);
        return had ? 1 : 0;
    }
    await initDb();
    const c = await client.execute({
        sql: "SELECT COUNT(*) AS n FROM session_results WHERE sessionId = ?",
        args: [sid],
    });
    const n = Number(c.rows[0].n) || 0;
    if (n) await client.execute({ sql: "DELETE FROM session_results WHERE sessionId = ?", args: [sid] });
    return n;
}

module.exports = {
    rankRows,
    computeStandings,
    finalizeStandings,
    getStandings,
    saveStandings,
    deleteStandingsForSession,
};

// Prune the shared Turso DB of what nothing can reach any more.
//
// Three kinds of garbage, all invisible from the app:
//
//  1. ORPHANS — rows keyed by a sessionId that no longer exists in
//     `sessions` (runs, signals, sim_routes, session_boats). Nothing lists
//     them (every route reaches them through the session), so they are pure
//     accumulation. Since todo 33 a session DELETE cascades, so this only
//     cleans up what was left behind BEFORE that landed — plus anything a
//     future bug orphans.
//
//  2. SIMULATED GPS — gps_points rows tagged simulated=1. A mock boat's
//     uploads persist while it is racing (todo 9: routes/gps.js
//     racingPersist, so a finished mock session has a track), and every mock
//     race leaves a few hundred behind. Real fixes are never touched.
//
//  3. STALE STANDINGS — a frozen `session_results` snapshot whose boats are not
//     the session's boats (todo 55). Participants are declared once at creation,
//     so a mismatch means the table is not a record of anything; the standings
//     route heals one when it is read, and this sweep drops the rest so the next
//     read recomputes them. Session 231 is the specimen: a boat added after the
//     freeze left a FINAL table that never contained it.
//
// Usage:
//   node tools/prune-db.js                 # dry run: report only
//   node tools/prune-db.js --yes           # execute every sweep
//   node tools/prune-db.js --orphans       # only the orphan sweep
//   node tools/prune-db.js --sim-gps       # only the simulated points
//   node tools/prune-db.js --standings     # only the stale standings
//   node tools/prune-db.js --sim-gps --yes # execute just that
//
// Dry run is the default on purpose: this talks to the LIVE Turso DB that
// prod reads (there is no private dev database — see AGENTS.md), so a typo
// here is a prod typo.
const { getClient, initDb } = require("../store/db");

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--yes");
const onlyOrphans = argv.includes("--orphans");
const onlySimGps = argv.includes("--sim-gps");
const onlyStandings = argv.includes("--standings");
const onlySome = onlyOrphans || onlySimGps || onlyStandings;
const doOrphans = onlyOrphans || !onlySome;
const doSimGps = onlySimGps || !onlySome;
const doStandings = onlyStandings || !onlySome;

const ORPHAN_TABLES = ["runs", "signals", "sim_routes", "session_boats"];

async function count(client, sql) {
    const r = await client.execute(sql);
    return Number(r.rows[0].n) || 0;
}

// Which sessions have a frozen table whose boats are not the session's boats?
// Compared as sets, in memory: the two lists are tiny and a SQL join with a
// count comparison is much harder to read.
async function staleStandings(client) {
    const results = await client.execute("SELECT sessionId, deviceId FROM session_results");
    const boats = await client.execute("SELECT sessionId, deviceId FROM session_boats");
    const want = new Map(); // sessionId -> Set(deviceId)
    for (const b of boats.rows) {
        const sid = Number(b.sessionId);
        if (!want.has(sid)) want.set(sid, new Set());
        want.get(sid).add(b.deviceId);
    }
    const have = new Map(); // sessionId -> Set(deviceId)
    for (const r of results.rows) {
        const sid = Number(r.sessionId);
        if (!have.has(sid)) have.set(sid, new Set());
        have.get(sid).add(r.deviceId);
    }
    const bad = [];
    for (const [sid, set] of have) {
        const w = want.get(sid) || new Set();
        if (w.size !== set.size || [...set].some(d => !w.has(d))) bad.push(sid);
    }
    bad.sort((a, b) => a - b);
    return { bad, sessions: have.size, frozen: results.rows.length };
}

async function main() {
    const client = getClient();
    if (!client) {
        console.error("No TURSO_DATABASE_URL — this tool only prunes the real DB.");
        process.exit(1);
    }
    await initDb();

    console.log(EXECUTE ? "PRUNE  (executing)" : "PRUNE  (dry run — pass --yes to execute)");

    if (doOrphans) {
        const where = "sessionId NOT IN (SELECT id FROM sessions)";
        console.log("\n  orphans (sessionId no longer in `sessions`)");
        for (const t of ORPHAN_TABLES) {
            let n = 0;
            try {
                n = await count(client, `SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`);
            } catch (e) {
                console.log(`    ${t.padEnd(14)} —  (${e.message})`);
                continue;
            }
            if (n && EXECUTE) {
                await client.execute(`DELETE FROM ${t} WHERE ${where}`);
                const left = await count(client, `SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`);
                console.log(`    ${t.padEnd(14)} ${String(n).padStart(6)} deleted${left ? ` (${left} left!)` : ""}`);
            } else {
                console.log(`    ${t.padEnd(14)} ${String(n).padStart(6)}${n ? "" : "  (clean)"}`);
            }
        }
    }

    if (doSimGps) {
        const total = await count(client, "SELECT COUNT(*) AS n FROM gps_points");
        const sim = await count(client, "SELECT COUNT(*) AS n FROM gps_points WHERE simulated = 1");
        console.log("\n  simulated GPS (mock uploads persisted while racing)");
        console.log(`    simulated=1    ${String(sim).padStart(6)}`);
        console.log(`    real kept      ${String(total - sim).padStart(6)}  (of ${total})`);
        if (sim && EXECUTE) {
            await client.execute("DELETE FROM gps_points WHERE simulated = 1");
            const left = await count(client, "SELECT COUNT(*) AS n FROM gps_points WHERE simulated = 1");
            console.log(`    deleted        ${String(sim - left).padStart(6)}${left ? ` (${left} left!)` : ""}`);
        }
    }

    if (doStandings) {
        const { bad, sessions, frozen } = await staleStandings(client);
        console.log("\n  stale standings (frozen table is not the session's boats)");
        console.log(`    snapshots      ${String(frozen).padStart(6)}  (of ${sessions} session(s) with results)`);
        if (!bad.length) {
            console.log("    mismatched           0  (clean)");
        } else if (EXECUTE) {
            for (const sid of bad) {
                await client.execute({
                    sql: "DELETE FROM session_results WHERE sessionId = ?",
                    args: [sid],
                });
            }
            console.log(`    dropped        ${String(bad.length).padStart(6)}  session(s) ${bad.join(", ")}`);
            console.log("    (each recomputes and re-freezes on its next standings read)");
        } else {
            console.log(`    mismatched     ${String(bad.length).padStart(6)}  session(s) ${bad.join(", ")}`);
        }
    }

    if (!EXECUTE) console.log("\n  nothing was written — re-run with --yes to execute.");
}

main().catch(e => { console.error("FAIL:", e.message || e); process.exit(1); });

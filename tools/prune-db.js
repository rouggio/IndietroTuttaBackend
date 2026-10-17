// Prune the shared Turso DB of what nothing can reach any more.
//
// Two kinds of garbage, both invisible from the app:
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
// Usage:
//   node tools/prune-db.js                 # dry run: report only
//   node tools/prune-db.js --yes           # execute both prunes
//   node tools/prune-db.js --orphans       # only the orphan sweep
//   node tools/prune-db.js --sim-gps       # only the simulated points
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
const doOrphans = onlyOrphans || !onlySimGps;
const doSimGps = onlySimGps || !onlyOrphans;

const ORPHAN_TABLES = ["runs", "signals", "sim_routes", "session_boats"];

async function count(client, sql) {
    const r = await client.execute(sql);
    return Number(r.rows[0].n) || 0;
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

    if (!EXECUTE) console.log("\n  nothing was written — re-run with --yes to execute.");
}

main().catch(e => { console.error("FAIL:", e.message || e); process.exit(1); });

#!/usr/bin/env node
// Device-free acceptance for todo 55 — "participants are declared ONCE, at
// creation". No ESP32, no browser: two fake boats that the server has never
// seen, driven entirely over HTTP.
//
//   node tools/check-participants.js          (needs `node server.js` on :3000)
//
// It WRITES to the database the server is pointed at (the live Turso DB, both
// locally and on Render) — two sessions, two device rows and one deliberately
// stale `session_results` row — and removes all of it in the `finally` block,
// printing the cascade counts so a failed cleanup is visible rather than silent.
//
// What it proves, in order:
//   1. boats[] on POST /sessions is the declaration, in one call
//   2. an id the server has never seen becomes `Boat XXXX`, lastSeen '' (offline)
//      — a declaration is not a heartbeat
//   3. POST/DELETE /sessions/:id/boats are gone (404)
//   4. the one-active-session guard still fires from the create path (409)
//   5. repeat while the fleet is still racing is refused (409): a repeat is a
//      new session, therefore a new declaration
//   6. a frozen snapshot whose boats are not the session's boats is never
//      served — the heal-on-read path, seeded by a raw INSERT here
//   7. the table freezes (final:true, both boats ranked) only when EVERY
//      declared boat uploaded; one silent boat keeps the race `live`
//   8. repeat after the race closed carries the fleet forward
//
// check-standings.js proves the ORDER without a DB; this proves the FLEET.

const { getClient, initDb } = require("../store/db.js");

const BASE = process.env.BACKEND || "http://localhost:3000";
const A = "AA:BB:CC:DD:EE:11";   // never seen by the server
const B = "AA:BB:CC:DD:EE:12";   // never seen by the server
const GHOST = "ZZ:00:00:00:00:01";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
    if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  (" + detail + ")" : ""}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? "  (" + detail + ")" : ""}`); }
}
async function req(method, path, body) {
    const r = await fetch(BASE + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json body */ }
    return { status: r.status, json, text };
}

const today = new Date().toISOString().slice(0, 10);
// the gun must be in the PAST or the session reads `scheduled` and never goes live
const startTime = new Date(Date.now() - 600e3).toISOString();

(async () => {
    let s1 = null, s2 = null;
    try {
        console.log("\n1. create with two unknown participants");
        const c = await req("POST", "/sessions", {
            courseId: 34, name: "TODO55 device-free", date: today, mode: "practice",
            originLat: 39.92, originLon: 9.65, windDir: 265, startTime,
            boats: [{ deviceId: A }, { deviceId: B }],
        });
        s1 = c.json && c.json.id;
        ok("POST /sessions accepted boats in one call", c.status === 200 || c.status === 201, "HTTP " + c.status);
        ok("both participants are on the session", !!(c.json && c.json.boats && c.json.boats.length === 2),
            "boats=" + (c.json && c.json.boats ? c.json.boats.length : "?"));

        console.log("\n2. unknown ids recorded as `Boat XXXX`, offline by construction");
        const devs = (await req("GET", "/devices")).json || [];
        const da = devs.find(d => d.deviceId === A), db = devs.find(d => d.deviceId === B);
        ok("boat A has a device row", !!da, da && da.username);
        ok("boat B has a device row", !!db, db && db.username);
        ok("fictive names are `Boat EE11` / `Boat EE12`",
            !!da && !!db && da.username === "Boat EE11" && db.username === "Boat EE12");
        ok("a declaration is NOT a heartbeat (lastSeen empty)", !!da && da.lastSeen === "");
        ok("...so they read offline", !!da && da.status === "offline", da && da.status);

        console.log("\n3. there is no add/remove route (todo 55)");
        const add = await req("POST", `/sessions/${s1}/boats`, { deviceId: A });
        ok("POST /sessions/:id/boats -> 404", add.status === 404, "HTTP " + add.status);
        const del = await req("DELETE", `/sessions/${s1}/boats/${encodeURIComponent(A)}`);
        ok("DELETE /sessions/:id/boats/:dev -> 404", del.status === 404, "HTTP " + del.status);

        console.log("\n4. a boat already racing cannot be declared again");
        const clash = await req("POST", "/sessions", {
            courseId: 34, name: "TODO55 clash", date: today, mode: "practice",
            originLat: 39.92, originLon: 9.65, windDir: 265, startTime,
            boats: [{ deviceId: A }],
        });
        ok("POST /sessions with a busy boat -> 409", clash.status === 409, "HTTP " + clash.status);
        ok("the message names the blocking session",
            !!(clash.json && /session/i.test(clash.json.error || "")), clash.json && clash.json.error);

        console.log("\n5. repeat while the first race is still active");
        const repEarly = await req("POST", `/sessions/${s1}/repeat`, { date: today, mode: "practice" });
        ok("repeat is refused while the boats are still in a live session (409)",
            repEarly.status === 409, "HTTP " + repEarly.status);

        console.log("\n6. a snapshot whose boats are not the session's boats is dropped");
        const client = getClient();
        if (!client) throw new Error("no DB client (.env missing?) — run from IndietroTuttaBackend");
        await initDb();
        await client.execute({
            sql: `INSERT INTO session_results
                    (sessionId, deviceId, rank, result, elapsedSec, penaltySec, correctedSec, splits, computedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [s1, GHOST, 1, "FINISHED", 100, 0, 100, "[]", new Date().toISOString()],
        });
        const st0 = await req("GET", `/sessions/${s1}/standings`);
        const rows0 = (st0.json && st0.json.standings) || [];
        ok("the ghost row is not served", !rows0.some(r => r.deviceId === GHOST),
            "rows=" + rows0.map(r => r.deviceId).join("|"));
        ok("the live race still reads PROVISIONAL", st0.json && st0.json.final === false);
        ok("it lists exactly the session's two boats",
            rows0.length === 2 && rows0.every(r => r.deviceId === A || r.deviceId === B), "rows=" + rows0.length);
        ok("no rank while racing", rows0.every(r => r.rank === null));

        console.log("\n7. the table freezes only when EVERY declared boat uploaded");
        const runBody = (dev) => ({
            deviceId: dev, startEpoch: 1790000000, finishEpoch: 1790000150,
            splits: [70], events: [], result: "FINISHED",
        });
        const r1 = await req("POST", `/sessions/${s1}/runs`, runBody(A));
        ok("first run accepted", r1.status === 200 || r1.status === 201, "HTTP " + r1.status);
        const mid = await req("GET", `/sessions/${s1}`);
        ok("one boat still racing keeps the session live", mid.json && mid.json.status === "live",
            mid.json && mid.json.status);
        const r2 = await req("POST", `/sessions/${s1}/runs`, runBody(B));
        ok("second run accepted", r2.status === 200 || r2.status === 201, "HTTP " + r2.status);
        const st1 = await req("GET", `/sessions/${s1}/standings`);
        const rows1 = (st1.json && st1.json.standings) || [];
        ok("standings are FINAL now", st1.json && st1.json.final === true);
        ok("both boats ranked", rows1.length === 2 && rows1.every(r => r.rank === 1 || r.rank === 2),
            rows1.map(r => r.rank + ":" + r.deviceId.slice(-2)).join(" "));

        console.log("\n8. repeat after the race closed");
        const rep = await req("POST", `/sessions/${s1}/repeat`, { date: today, mode: "practice" });
        s2 = rep.json && rep.json.id;
        ok("repeat -> new session", !!s2 && s2 !== s1, "id " + s2 + " HTTP " + rep.status);
        ok("repeat carried both boats", !!(rep.json && rep.json.boats && rep.json.boats.length === 2),
            "boats=" + (rep.json && rep.json.boats ? rep.json.boats.length : "?"));
    } finally {
        console.log("\n9. cleanup");
        for (const id of [s1, s2]) {
            if (!id) continue;
            const d = await req("DELETE", `/sessions/${id}`);
            console.log(`  deleted session ${id} -> HTTP ${d.status} ${JSON.stringify(d.json)}`);
        }
        for (const dev of [A, B]) {
            const d = await req("DELETE", `/devices/${encodeURIComponent(dev)}`);
            console.log(`  deleted device ${dev} -> HTTP ${d.status}`);
        }
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });

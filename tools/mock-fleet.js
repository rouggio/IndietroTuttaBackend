#!/usr/bin/env node
// mock-fleet — play a scripted tape as each boat of a session, so a whole
// fleet can sail (and be scored) with NO device on.
//
//   node tools/mock-fleet.js                       two bench boats, 1x
//   node tools/mock-fleet.js --speed 4             same race, 4x faster
//   node tools/mock-fleet.js --boats 08:D1:F9:C8:4D:24,AA:BB:CC:DD:EE:01
//   node tools/mock-fleet.js --no-run              sail, don't upload the runs
//   node tools/mock-fleet.js --at 39.92,9.65 --gun 40 --speed-kn 12,16
//
// Why this exists: every fleet feature (standings with two rows, the replay,
// the progress ranking) could only be tested by finding a second boat and a
// second sailor. The bench is not a simulator — it is the DEVICE, minus the
// screen: fetch the scripted journey, POST each fix to /gps with that
// DeviceId at the recorded cadence, upload the run at the finish.
//
// Todo 56. Decisions (2026-10-23):
//   - wall clock 1x, `--speed N` only to compress
//   - ONE process drives every boat (one clock, one cleanup path); each boat's
//     fixes are posted on its own sequential chain so a track never lands out
//     of order, and the boats run concurrently
//   - the session is LEFT in the DB (id + table printed) so it can be looked
//     at on the map and replayed later; prune with prune-db.js / Clean
//   - the session comes from new-mock-session.js --boats, because todo 55 made
//     participants a creation-time decision (there is no add-boat route)
//
// Four traps this file exists downstream of:
//   1. POST /sim/runs with NO deviceId scripts every boat with the SAME
//      speedKn — the fleet would tie. So: one call per boat, one speed each.
//   2. the tape's last sample is the 200m finish OVERRUN, not the finish. The
//      run upload carries the line crossing, found here from the samples
//      against the session's frozen finishLine (the predicate the device
//      scores with), or every elapsed time gains ~25s of overrun.
//   3. auto-sim only scripts `mock`-flagged boats, and a bench id is not mock
//      at creation time — the harness owns run creation.
//   4. a run created less than 15s before the session's startTime does NOT get
//      that gun: compileScript falls back to now+60s, so one boat races a
//      different race. All runs are declared back to back and their guns are
//      checked to be identical; --gun below ~40 fails loudly instead of
//      sailing two races.
//   5. (see `args` below) new-mock-session takes windDir POSITIONALLY and scale
//      right after it — a skipped wind shifts scale into the wind slot.

const { execFileSync } = require("child_process");
const path = require("path");

const BASE = process.env.BACKEND || "http://localhost:3000";
const DEFAULT_BOATS = "AA:BB:CC:DD:EE:01,AA:BB:CC:DD:EE:02";
const CROSS_RANGE_M = 150;   // the device's OCS/finish band
const M = 111320;

// --------------------------------------------------
// args
// --------------------------------------------------
const argv = process.argv.slice(2);
// Two readers on purpose: a VALUE flag consumes the next token, a BOOLEAN flag
// must not — `flag("--no-run")` eating the following `--gun` is how the first
// version orphaned its value and then complained about an unknown argument.
function flag(name, fallback) {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith("--")) return fallback;
    argv.splice(i, 2);
    return v;
}
function bool(name) {
    const i = argv.indexOf(name);
    if (i < 0) return false;
    argv.splice(i, 1);
    return true;
}
const boatsArg = String(flag("--boats", DEFAULT_BOATS));
const speed = Math.max(1, Number(flag("--speed", 1)) || 1);
const atArg = flag("--at", null);
const noRun = bool("--no-run");
const gunSec = Number(flag("--gun", 70)) || 70;
const distM = Number(flag("--dist", 30)) || 30;
const courseId = Number(flag("--course", 34)) || 34;
const windDir = flag("--wind", null);
const scale = Number(flag("--scale", 0.3)) || 0.3;
const speedKnArg = String(flag("--speed-kn", "13.5,14.5"));

const BOATS = boatsArg.split(",").map((s) => s.trim()).filter(Boolean);
if (!BOATS.length) fail("--boats needs at least one device id");
if (BOATS.length > 6) fail("more than 6 boats is not a bench, it is a load test");
// anything left in argv is a positional this tool does not take (the usage
// block at the top of the file is the only documentation it has)
if (argv.length) fail(`unknown argument(s): ${argv.join(" ")} — see the usage at the top of tools/mock-fleet.js`);

// one speed per boat, so corrected times differ; the last value repeats when
// the fleet is longer than the list
const SPEEDS = speedKnArg.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
if (!SPEEDS.length) fail("--speed-kn needs at least one number");
const speedKnFor = (i) => SPEEDS[Math.min(i, SPEEDS.length - 1)];

function fail(msg) {
    console.error("FAILED:", msg);
    process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opts) {
    const r = await fetch(BASE + url, opts);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status} ${JSON.stringify(body)}`);
    return body;
}

// --------------------------------------------------
// geometry — the same predicates tools/check-route.js proves the script with
// --------------------------------------------------
const rad = (d) => (d * Math.PI) / 180;
const distToSeg = (p, a, b) => {
    const k = Math.cos(rad(p.lat));
    const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
    const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
    const L2 = bx * bx + by * by;
    let t = L2 ? (px * bx + py * by) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - bx * t, py - by * t);
};
const sideOf = (p, a, b) => {
    const k = Math.cos(rad(p.lat));
    const px = (p.lon - a.lon) * M * k, py = (p.lat - a.lat) * M;
    const bx = (b.lon - a.lon) * M * k, by = (b.lat - a.lat) * M;
    const cr = bx * py - by * px;
    return cr > 2 ? 1 : cr < -2 ? -1 : 0;
};

// The finish crossing: a side flip inside the band that HOLDS for at least
// three more samples. Without the "holds" part the finish scores on the last
// sample of the overrun and every race ends on a single-fix artefact — the
// bug the device's own scorer was written around.
//
// Scanned BACKWARDS on purpose: a W/L's finish line is the start line
// (`finishLine: {sameAs:"start"}`), so the first sustained flip in the tape is
// the START. The last one is the finish; the 200m overrun does not cross again.
//
// Returns an EPOCH (seconds), not a sample index: the tape carries epochs and
// nothing else, and a sample with an invented `t` is how the first version
// produced elapsed=NaN.
function finishCrossing(rows, fin) {
    if (!fin) return null;
    const A = { lat: fin.latA, lon: fin.lonA }, B = { lat: fin.latB, lon: fin.lonB };
    for (let i = rows.length - 1; i >= 1; i--) {
        const prev = rows[i - 1], cur = rows[i];
        if (sideOf(cur, A, B) === sideOf(prev, A, B)) continue;
        if (distToSeg(cur, A, B) >= CROSS_RANGE_M) continue;
        let after = 0;
        for (let j = i + 1; j < rows.length; j++) {
            if (sideOf(rows[j], A, B) === sideOf(cur, A, B) &&
                distToSeg(rows[j], A, B) < CROSS_RANGE_M) after++;
        }
        if (after >= 3) return cur.epoch;
    }
    return null;
}

function finSeg(session) {
    const f = session.finishLine;
    if (!f) return null;
    if (f.sameAs === "start") return session.startLine;
    return ("latA" in f) ? f : null;
}

// --------------------------------------------------
// tape → rows (epoch, lat, lon, speed, course)
// --------------------------------------------------
function parseTape(text) {
    const lines = text.trim().split(/\r?\n/);
    const head = lines.shift();
    if (!head || !head.startsWith("#")) throw new Error("bad tape header: " + head);
    const rows = [];
    for (const line of lines) {
        const p = line.split(",");
        if (p.length < 5) continue;
        rows.push({
            epoch: Number(p[0]), lat: Number(p[1]), lon: Number(p[2]),
            speed: Number(p[3]), course: Number(p[4]),
        });
    }
    return rows;
}

// --------------------------------------------------
// main
// --------------------------------------------------
(async () => {
    // 1. the session — new-mock-session.js owns the placement (line `distM`
    //    metres upwind, scale, gun) and declares the WHOLE fleet, because
    //    participants cannot be added afterwards (todo 55).
    // windDir is POSITIONAL in new-mock-session (4th) and scale is 5th: skipping
    // an unset wind shifts scale into the wind slot — the first version sailed
    // every bench race on a 0.3° wind while placing the line for 45°.
    const args = [
        path.join(__dirname, "new-mock-session.js"),
        String(distM), String(gunSec), String(courseId),
        String(windDir === null ? 45 : Number(windDir)),
        String(scale), "--boats", BOATS.join(","),
    ];
    if (atArg) args.push("--at", String(atArg));

    console.log(`creating a ${BOATS.length}-boat session (${distM}m line, ${gunSec}s gun, scale ${scale})...`);
    const out = execFileSync(process.execPath, args, { encoding: "utf8" });
    process.stdout.write(out.replace(/^/gm, "  "));
    const m = out.match(/session (\d+)/);
    if (!m) fail("could not read the session id from new-mock-session.js");
    const sessionId = Number(m[1]);

    const session = await json(`/sessions/${sessionId}`);
    const declared = (session.boats || []).map((b) => b.deviceId);
    for (const id of BOATS) {
        if (!declared.includes(id)) fail(`boat ${id} is not on session ${sessionId} (got ${declared.join(", ")})`);
    }

    // 2. every run declared BACK TO BACK, then checked to share one gun —
    //    a boat that gets compileScript's now+60s fallback is sailing a
    //    different race, and the table would call it last on nothing.
    //
    //    First drop whatever auto-sim scripted: POST /sessions auto-scripts
    //    `mock`-flagged boats, and a bench boat IS flagged mock after its first
    //    race — a second bench run would otherwise sail two scripts per boat.
    const auto = await json(`/sim/runs?sessionId=${sessionId}`);
    for (const r of auto) await json(`/sim/runs/${encodeURIComponent(r.id)}`, { method: "DELETE" });
    if (auto.length) console.log(`  dropped ${auto.length} auto-sim run(s) — the bench owns the scripts`);

    const metas = [];
    for (let i = 0; i < BOATS.length; i++) {
        metas.push(await json("/sim/runs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, deviceId: BOATS[i], speedKn: speedKnFor(i) }),
        }));
    }
    const guns = metas.map((r) => r.gunMs);
    if (Math.max(...guns) - Math.min(...guns) > 1000) {
        fail("the boats did not get the same gun (" +
            guns.map((g) => new Date(g).toISOString()).join(" / ") +
            "). The session startTime was too close: raise --gun (40s+).");
    }

    // 3. tapes + the two epochs that matter: the start CROSSING (gun + the
    //    script's crossing offset, reported by the run) and the finish
    //    crossing found in the samples — never the last sample (see trap 2).
    const fin = finSeg(session);
    const fleet = [];
    for (let i = 0; i < metas.length; i++) {
        const run = metas[i];
        const rows = parseTape(await (await fetch(
            `${BASE}/sim/tape?runId=${encodeURIComponent(run.id)}`)).text());
        if (!rows.length) fail(`empty tape for ${BOATS[i]}`);
        const startEpoch = Math.floor(run.gunMs / 1000) + Math.round((run.crossMs || 0) / 1000);
        const cross = finishCrossing(rows, fin);
        const finishEpoch = cross === null ? rows[rows.length - 1].epoch : cross;
        fleet.push({
            deviceId: BOATS[i], run, rows, startEpoch, finishEpoch,
            elapsedSec: finishEpoch - startEpoch,
            noFinishLine: cross === null,
            played: 0,
        });
    }

    const t0 = Math.min(...fleet.map((f) => f.rows[0].epoch));
    const tCross = Math.max(...fleet.map((f) => f.startEpoch));
    const tEnd = Math.max(...fleet.map((f) => f.finishEpoch));
    console.log(`\nsession ${sessionId} "${session.name}"`);
    console.log(`  gun ${new Date(metas[0].gunMs).toISOString()}  +${tCross - t0}s line`);
    for (const f of fleet) {
        console.log(`  ${f.deviceId}  ${f.run.speedKn}kn  fixes ${f.rows.length}` +
            `  finish +${f.finishEpoch - t0}s  elapsed ${f.elapsedSec}s` +
            (f.noFinishLine ? "  (no finish line on this course: last fix)" : ""));
    }
    console.log(`\nsailing ~${Math.round(tEnd - t0)}s of race at ${speed}x` +
        (noRun ? " — runs will NOT be uploaded" : "") + "\n");

    // 4. play. One chain per boat (its fixes must land in order, or the map
    //    draws a zigzag), the chains concurrent. Each push is ~400ms against
    //    the live Turso DB — the backend, not this loop, is the ceiling, so
    //    the achieved rate is reported instead of assumed.
    const wall0 = Date.now();
    await Promise.all(fleet.map((f) => playBoat(sessionId, f)));
    const wallSec = (Date.now() - wall0) / 1000;

    // 5. the verdict is the table, not our own arithmetic
    const st = await json(`/sessions/${sessionId}/standings`);
    const rows = st.standings || [];
    console.log(`\nstandings (${st.final ? "FINAL" : "PROVISIONAL"})`);
    for (const r of rows) {
        console.log(`  ${r.rank == null ? "-" : r.rank}  ${r.deviceId}  ${r.result}` +
            (r.correctedSec == null ? "" : `  corrected ${mmss(r.correctedSec)}`) +
            (r.penaltySec ? `  (+${r.penaltySec}s)` : ""));
    }
    const achieved = Math.round(((tEnd - t0) / wallSec) * 10) / 10;
    console.log(`\n${Math.round(wallSec)}s wall for ${Math.round(tEnd - t0)}s of race (${achieved}x, requested ${speed}x)`);
    if (achieved < speed * 0.9) {
        // Measured 2026-10-23: /health answers in 2-15 ms, /gps takes 240-570 ms
        // because EVERY fix upserts the device against Turso (plus the racing
        // addPoint). Two boats posting at 1 Hz already sit at the edge of that
        // link, so a compressed run is bounded by the backend, not by this loop.
        console.log("  note: the wall clock lagged the script — each fix costs a server-side device");
        console.log("        upsert (~0.4-0.6 s against Turso). The stored fix TIMESTAMPS and the");
        console.log("        table are unaffected; only the pace of delivery is.");
    }
    console.log(`session ${sessionId} left in place — open it on the map, or sweep it with prune-db.js`);

    if (noRun) {
        console.log(`\n${BOATS.length}/${BOATS.length} boats sailed, runs not uploaded (--no-run)`);
        process.exit(0);
    }
    if (rows.length !== BOATS.length) fail(`the table has ${rows.length} row(s), expected ${BOATS.length}`);
    if (!st.final) fail("the race did not close: at least one run is missing");
    console.log(`\n${BOATS.length}/${BOATS.length} boats sailed and uploaded — table is FINAL`);
})().catch((e) => fail(e.message));

async function playBoat(sessionId, f) {
    const base = Date.now();
    const first = f.rows[0].epoch;
    let beat = -1;
    for (const row of f.rows) {
        const due = base + ((row.epoch - first) * 1000) / speed;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
        try {
            await json("/gps", {
                method: "POST",
                headers: { "Content-Type": "application/json", DeviceId: f.deviceId },
                body: JSON.stringify({
                    lat: row.lat, lon: row.lon, speed: row.speed, course: row.course,
                    altitude: 5, sats: 9, simulated: true,
                    timestamp: new Date(row.epoch * 1000).toISOString(),
                }),
            });
        } catch (e) {
            // one lost fix is a gap in a track; a lost RUN is a lost race
            console.log(`  ! ${f.deviceId} fix ${row.epoch} rejected: ${e.message}`);
        }
        f.played++;
        const scriptT = row.epoch - first;
        if (scriptT - beat >= 60) {
            beat = scriptT;
            console.log(`  [${mmss(scriptT)}] ${f.deviceId} ${f.played}/${f.rows.length}`);
        }
    }
    if (noRun) return;
    const body = {
        deviceId: f.deviceId,
        startEpoch: f.startEpoch,
        finishEpoch: f.finishEpoch,
        // the tape carries no mark passes (the compiled route knows them, the
        // wire format does not), so the split column stays empty — 64's fault
        // work is where passes appear
        splits: [],
        events: [
            { t: f.startEpoch, e: "START", v: "line" },
            { t: f.finishEpoch, e: "FINISH" },
        ],
        result: "FINISHED",
    };
    try {
        await json(`/sessions/${sessionId}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        console.log(`  ${f.deviceId} finished — run uploaded (${f.elapsedSec}s)`);
    } catch (e) {
        fail(`run upload for ${f.deviceId} failed: ${e.message}`);
    }
}

function mmss(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

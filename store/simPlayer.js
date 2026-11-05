// ------------------------------------------------------------------
// Todo 63 — the sandbox: a session with real marks and real `gps_points`,
// sailed by the BACKEND, with no device on the other end.
//
// The engine is `tools/mock-fleet.js` (todo 56): that tool proved the shape
// of this job — one scripted run per boat, each played into `POST /gps`
// with that boat's `DeviceId` so the fix lands in `gps_points` exactly as a
// device's would, then the run uploads at its own finish. What changes here
// is WHERE it lives (in-process, so closing the browser tab cannot kill a
// race), and that it can be started, inspected and stopped over HTTP.
//
// Three rules this module keeps:
//
//   1. It is a CLIENT of the live path, never a shortcut around it. Every
//      fix goes out over HTTP to `/gps` on this same process — the device's
//      own request, minus the screen. Calling `addPoint()` directly would
//      skip `upsertDevice`, the `simulated` tagging and `racingPersist`, so
//      a sim race would diverge from a real one in exactly the place 63
//      exists to prove they don't.
//   2. Only START and FINISH are scored. The tape carries no mark passes
//      (the compiled route knows them, the wire format does not) and the
//      frozen table does not need them — `rankRows` orders by corrected
//      time. Passes are todo 64's work: it is the item that sails a boat
//      which misses a gate, and a pass list is what proves the miss.
//   3. State is RAM only, like the scripts it plays (`store/sim.js`). A
//      restart loses the players, so `sweepOrphanedSimSessions()` runs at
//      boot and abandons what it can no longer drive — otherwise a dead
//      player leaves a session `live` for ever (the session-250 pattern).
// ------------------------------------------------------------------

const { getSession, updateSession, listSessions, MAX_TIME_SCALE } = require("./sessionStore");
const { createRun, getRun, listRuns, deleteRun } = require("./sim");

const fetchImpl = typeof fetch === "function" ? fetch : require("node-fetch");

const players = new Map();   // sessionId -> player
// A finished player stays inspectable for as long as a finished run does
// (store/sim.js prunes a run 10 min after it ends), so the pane can show the
// last frame instead of blinking back to "not running".
const KEEP_MS = 10 * 60 * 1000;
const CROSS_RANGE_M = 150;   // the device's OCS/finish band
const MAX_BOATS = 6;         // same ceiling as the bench
const DEG_M = 111320;
// Todo 66: how much wall clock one `POST /gps` window may carry. A round trip is
// ~415 ms, so 800 ms is about two of them per call: at 1x a window is one fix (the
// tape is 1 Hz) and nothing changes for a wall-clock race, while at 50x it is ~40
// fixes and the tape is done in a few seconds. The cost is granularity: the live
// map steps once per window, which at 50x is 40 s of race time per refresh - fine
// for a sandbox, and the trade that buys the speed.
const BATCH_MS = 800;

// Todo 63 sails at wall clock. `sessions.timeScale` exists anyway so that 66
// (10-50x) only lifts this clamp instead of migrating the table again — the
// number itself lives in store/sessionStore.js, where the create path
// enforces the same limit.
const DEFAULT_SPEEDS_KN = [13.5, 14.5];

function bad(msg, status = 400) {
    return Object.assign(new Error(msg), { status });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sandbox posts to its own server. PORT is what the process bound, so a
// Render instance (10000) and a laptop (3000) both work without config.
function baseUrl() {
    return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

// --------------------------------------------------
// geometry — the device's finish predicate, transcribed a third time on
// purpose (tools/mock-fleet.js and tools/check-route.js each carry their own).
// A shared copy would couple a server module to two dev tools that must keep
// working against a REMOTE backend; three short transcriptions of one locked
// rule are cheaper to keep honest than one import that drags the store chain
// into a CLI.
// --------------------------------------------------
const rad = (d) => (d * Math.PI) / 180;

function distToSeg(p, a, b) {
    const k = Math.cos(rad(p.lat));
    const px = (p.lon - a.lon) * DEG_M * k, py = (p.lat - a.lat) * DEG_M;
    const bx = (b.lon - a.lon) * DEG_M * k, by = (b.lat - a.lat) * DEG_M;
    const L2 = bx * bx + by * by;
    let t = L2 ? (px * bx + py * by) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - bx * t, py - by * t);
}

function sideOf(p, a, b) {
    const k = Math.cos(rad(p.lat));
    const px = (p.lon - a.lon) * DEG_M * k, py = (p.lat - a.lat) * DEG_M;
    const bx = (b.lon - a.lon) * DEG_M * k, by = (b.lat - a.lat) * DEG_M;
    const cr = bx * py - by * px;
    return cr > 2 ? 1 : cr < -2 ? -1 : 0;
}

function finSeg(session) {
    const f = session.finishLine;
    if (!f) return null;
    if (f.sameAs === "start") return session.startLine;
    return ("latA" in f) ? f : null;
}

// The LAST sustained side flip inside the band — scanned backwards because a
// W/L's finish line IS the start line, so the first flip in the tape is the
// start. "Sustained" (three more samples on the new side) is what stops the
// overrun's final sample from scoring a finish on its own.
function finishCrossing(rows, fin) {
    if (!fin || !rows.length) return null;
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

// --------------------------------------------------
// start / status / stop
// --------------------------------------------------

function normaliseBoats(input, session) {
    const declared = (session.boats || []).map((b) => b.deviceId);
    if (!declared.length) throw bad("session has no boats — declare the fleet when the session is created");

    // No `boats` list means "every declared boat at the default speeds", which
    // is what the UI sends when the operator only picked a boat count.
    const raw = Array.isArray(input) && input.length
        ? input
        : declared.map((deviceId) => ({ deviceId }));

    const list = raw.map((b, i) => ({
        deviceId: String((typeof b === "string" ? b : b && b.deviceId) || "").trim(),
        speedKn: Number((b && b.speedKn) !== undefined ? b.speedKn : DEFAULT_SPEEDS_KN[Math.min(i, DEFAULT_SPEEDS_KN.length - 1)]),
    }));
    if (list.length > MAX_BOATS) throw bad(`at most ${MAX_BOATS} boats in a sandbox race`);
    for (const b of list) {
        if (!b.deviceId) throw bad("each boat needs a deviceId");
        if (!declared.includes(b.deviceId)) {
            throw bad(`boat ${b.deviceId} is not a participant of session ${session.id} (${declared.join(", ")})`);
        }
        if (!(b.speedKn >= 1 && b.speedKn <= 40)) throw bad(`speedKn for ${b.deviceId} must be 1..40`);
    }
    // Unique: two runs for one boat is two tapes fighting over one DeviceId.
    if (new Set(list.map((b) => b.deviceId)).size !== list.length) {
        throw bad("the same boat is listed twice");
    }
    return list;
}

async function start({ sessionId, boats, timeScale } = {}) {
    const sid = Number(sessionId);
    if (!Number.isFinite(sid) || sid <= 0) throw bad("sessionId required");

    const ts = timeScale === undefined || timeScale === null ? 1 : Number(timeScale);
    if (!(ts >= 1)) throw bad("timeScale must be >= 1");
    if (ts > MAX_TIME_SCALE) {
        throw bad(`timeScale ${ts} is above the sandbox ceiling (${MAX_TIME_SCALE}x)`);
    }

    if (players.has(sid)) throw bad("a sandbox is already sailing this session", 409);
    const session = await getSession(sid);
    if (!session) throw bad("session not found", 404);
    if (!session.simulated) {
        throw bad("this session is not marked simulated — create it with simulated:true (the UI's Simulate switch does)");
    }
    if (session.status === "finished" || session.status === "abandoned") {
        throw bad(`session is ${session.status}`);
    }

    const fleet = normaliseBoats(boats, session);

    // Whatever is scripted already goes: POST /sessions auto-scripts a boat
    // already flagged `mock`, and a re-run would otherwise sail two tapes.
    for (const r of listRuns(sid)) deleteRun(r.id);

    const metas = [];
    try {
        for (const b of fleet) {
            metas.push(await createRun({ sessionId: sid, deviceId: b.deviceId, speedKn: b.speedKn }));
        }
    } catch (e) {
        for (const m of metas) deleteRun(m.id);
        throw e;
    }

    // One gun for the fleet, or two races in one session: a run created less
    // than 15 s before `startTime` silently gets now+60 s (compileScript's
    // fallback), and the table would then rank boats that never met.
    const guns = metas.map((m) => m.gunMs);
    if (Math.max(...guns) - Math.min(...guns) > 1000) {
        for (const m of metas) deleteRun(m.id);
        throw bad("the boats did not get the same gun — the session's startTime is too close; give the gun 40 s or more", 409);
    }

    const fin = finSeg(session);
    const boatsOut = metas.map((meta, i) => {
        const run = getRun(meta.id);
        const rows = (run.samples || []).map((s) => ({
            epoch: Math.floor(run.startMs / 1000) + s.t,
            lat: s.lat, lon: s.lon, speed: s.speed, course: s.course,
        }));
        const startEpoch = Math.floor(run.gunMs / 1000) + Math.round((meta.crossMs || 0) / 1000);
        const cross = finishCrossing(rows, fin);
        const finishEpoch = cross === null
            ? (rows.length ? rows[rows.length - 1].epoch : startEpoch)
            : cross;
        return {
            deviceId: fleet[i].deviceId,
            runId: meta.id,
            speedKn: meta.speedKn,
            rows,
            startEpoch,
            finishEpoch,
            elapsedSec: Math.max(0, finishEpoch - startEpoch),
            noFinishLine: cross === null,
            played: 0,
            total: rows.length,
            uploaded: false,
            failed: false,
        };
    });

    const wall0 = Date.now();
    const first = Math.min(...boatsOut.map((b) => (b.rows.length ? b.rows[0].epoch : 0)));
    const p = {
        sessionId: sid,
        timeScale: ts,
        startedAt: new Date(wall0).toISOString(),
        wall0,
        first,
        aborted: false,
        endedAt: null,
        warnings: [],
        boats: boatsOut,
    };
    players.set(sid, p);

    // Fire and forget: the race is the set of loops, and the request that
    // started it must not be held open for its duration.
    for (const b of boatsOut) {
        Promise.resolve()
            .then(() => playBoat(p, b))
            .catch((e) => {
                b.failed = true;
                p.warnings.push(`${b.deviceId}: ${e.message}`);
                maybeEnd(p);
            });
    }
    return playerStatus(p);
}

// Todo 66: the tape is played in WINDOWS, not one HTTP call per fix.
// A single `POST /gps` costs ~415 ms (the Turso round trip + device upsert), so
// one-request-per-fix caps the sandbox at ~2x no matter what timeScale asks for.
// A window is every fix whose due time falls inside the next `batchMs` of wall
// clock (or the rest of the tape), posted as ONE batched insert, each fix keeping
// its own tape timestamp. The schedule is unchanged: windows are still placed by
// `due`, so a slow server makes the race LATE, never different.
async function playBoat(p, b) {
    try {
        let i = 0;
        while (i < b.rows.length) {
            if (p.aborted) return;
            const head = b.rows[i];
            const headDue = p.wall0 + ((head.epoch - p.first) * 1000) / p.timeScale;
            await waitUntil(headDue, p);
            if (p.aborted) return;
            // Everything due before headDue + batchMs rides along. At 1x that is
            // exactly one fix (a tape spans 1000 ms per sample); at 50x it is ~25.
            const windowEnd = headDue + BATCH_MS;
            const batch = [];
            while (i < b.rows.length) {
                const row = b.rows[i];
                const due = p.wall0 + ((row.epoch - p.first) * 1000) / p.timeScale;
                if (due > windowEnd) break;
                batch.push(row);
                i++;
            }
            try {
                await postJson("/gps", {
                    points: batch.map((row) => ({
                        lat: row.lat, lon: row.lon,
                        speed: row.speed, course: row.course,
                        altitude: 5, sats: 9,
                        timestamp: new Date(row.epoch * 1000).toISOString(),
                    })),
                }, b.deviceId);
                b.played += batch.length;
            } catch (e) {
                // One lost WINDOW is a gap in a track; a lost RUN is a lost race.
                if (p.warnings.length < 20) {
                    p.warnings.push(`${b.deviceId} ${batch.length} fix(es) from ${batch[0].epoch}: ${e.message}`);
                }
            }
        }
        if (p.aborted) return;
        await postJson(`/sessions/${p.sessionId}/runs`, {
            deviceId: b.deviceId,
            startEpoch: b.startEpoch,
            finishEpoch: b.finishEpoch,
            // No mark passes exist for a device-free boat (see the header).
            splits: [],
            events: [
                { t: b.startEpoch, e: "START", v: "line" },
                { t: b.finishEpoch, e: "FINISH" },
            ],
            result: "FINISHED",
        }, b.deviceId);
        b.uploaded = true;
    } catch (e) {
        b.failed = true;
        p.warnings.push(`${b.deviceId}: ${e.message}`);
    } finally {
        maybeEnd(p);
    }
}

// playBoat's POSTs carry the boat's DeviceId, as a device would: identity is
// that header everywhere, and the run upload needs it to attribute the result.
async function postJson(path, body, deviceId) {
    const headers = { "Content-Type": "application/json" };
    if (deviceId) headers.DeviceId = deviceId;
    const r = await fetchImpl(baseUrl() + path, {
        method: "POST", headers, body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { return text; }
}

async function waitUntil(t, p) {
    for (;;) {
        if (p.aborted) return;
        const left = t - Date.now();
        if (left <= 0) return;
        // Sliced, so Stop lands in a quarter second instead of at the end of
        // a 70 s pre-start hold.
        await sleep(Math.min(left, 250));
    }
}

function maybeEnd(p) {
    if (p.endedAt) return;
    if (p.boats.every((b) => b.uploaded || b.failed)) {
        p.endedAt = new Date().toISOString();
    }
}

function playerStatus(p) {
    return {
        sessionId: p.sessionId,
        running: !p.aborted && !p.endedAt,
        timeScale: p.timeScale,
        startedAt: p.startedAt,
        endedAt: p.endedAt,
        warnings: p.warnings,
        boats: p.boats.map((b) => ({
            deviceId: b.deviceId,
            runId: b.runId,
            speedKn: b.speedKn,
            played: b.played,
            total: b.total,
            startEpoch: b.startEpoch,
            finishEpoch: b.finishEpoch,
            elapsedSec: b.elapsedSec,
            uploaded: b.uploaded,
            failed: b.failed,
            done: b.uploaded || b.failed,
        })),
    };
}

// A finished player is kept for 10 minutes (KEEP_MS), like its runs.
function prunePlayers(nowMs = Date.now()) {
    for (const [sid, p] of players) {
        if (p.aborted) { players.delete(sid); continue; }
        const end = p.endedAt ? new Date(p.endedAt).getTime() : 0;
        if (end && nowMs - end > KEEP_MS) players.delete(sid);
    }
}

function status(sessionId) {
    const sid = Number(sessionId);
    prunePlayers();
    const p = players.get(sid);
    if (!p) return { sessionId: sid, running: false, boats: [] };
    return playerStatus(p);
}

// Stop mid-race: halt every loop, drop the scripts (so nothing keeps feeding
// a boat) and close the record honestly. `abandon` is the default because a
// half-sailed race that stays `live` never closes and blocks its boats — the
// same hole Stop exists to avoid.
async function stop(sessionId, { abandon = true } = {}) {
    const sid = Number(sessionId);
    const p = players.get(sid);
    if (!p) throw bad("no sandbox is sailing this session", 404);
    p.aborted = true;
    for (const b of p.boats) {
        try { deleteRun(b.runId); } catch {}
    }
    players.delete(sid);
    // Only a race that is still open needs closing. If every boat already
    // uploaded, the session derived `finished` on its own and abandoning it
    // would rewrite a sailed race as a void one.
    const stillOpen = !p.endedAt;
    if (abandon && stillOpen) await updateSession(sid, { status: "abandoned" });
    return { stopped: true, sessionId: sid, abandoned: !!(abandon && stillOpen), finished: !stillOpen };
}

// --------------------------------------------------
// boot sweep
//
// A player lives in RAM, so a restart (or a Render spin-down, which is the
// same thing from here) loses the fleet but NOT the session: with no runs
// uploaded it derives `live` for ever, never freezes a table and never closes
// — exactly the state session 250 was found in. At boot there are no players
// at all, so any simulated session still reading scheduled/live is a race
// nobody can finish: abandon it. The tracks and partial runs stay for
// inspection, which is why this does not delete anything.
// --------------------------------------------------
async function sweepOrphanedSimSessions() {
    let n = 0;
    let rows = [];
    try {
        rows = await listSessions();
    } catch (e) {
        console.warn("[simPlayer] boot sweep could not list sessions:", e.message);
        return 0;
    }
    for (const row of rows) {
        if (!row.simulated) continue;
        if (players.has(Number(row.id))) continue;
        if (!["scheduled", "live"].includes(row.status)) continue;
        try {
            await updateSession(row.id, { status: "abandoned" });
            n++;
        } catch (e) {
            console.warn(`[simPlayer] could not abandon simulated session ${row.id}:`, e.message);
        }
    }
    if (n) console.log(`[simPlayer] abandoned ${n} simulated session(s) with no player (restart)`);
    return n;
}

module.exports = {
    start, status, stop, sweepOrphanedSimSessions, playerStatus,
    MAX_TIME_SCALE, MAX_BOATS,
};

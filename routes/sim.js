const express = require("express");

const {
    createRun,
    listRuns,
    deleteRun,
    echoSample,
    nextSample,
    activeRunForDevice,
    getRun,
    wanderSample,
    wanderAnchorFor,
    wanderNext,
    wanderBatch,
    setPushedAnchor,
    nextBatch,
    SIM_BATCH_MAX,
} = require("../store/sim");
const { getRoutePoints } = require("../store/simRoute");

const router = express.Router();

function sendErr(res, e) {
    return res.status(e.status || 500).json({ error: e.message || "internal error" });
}

// The device's tape format (see GET /sim/tape): one CSV line per fix.
// Header carries the run identity, the SESSION it belongs to, and the
// SERVER's clock — the device anchors its wall clock on it, exactly as it
// used to from each /sim/next reply, and it will not sail a journey until the
// race screen is up AND the engine holds that same session (a journey that
// starts before the engine knows its course is what broke race 182).
function sendTape(res, runId, sessionId, gunSec, durationSec, total, rows) {
    const lines = [`#${runId},${sessionId || 0},${gunSec},${durationSec},${total},${Math.floor(Date.now() / 1000)}`];
    for (const r of rows) lines.push(r.join(","));
    return res.type("text/plain").send(lines.join("\n") + "\n");
}

// --------------------------------------------------
// POST /sim/runs — compile a scripted run off a session.
// {sessionId, deviceId?, speedKn?, startInSec?, roundingM?} — deviceId absent =
// one run per session boat. roundingM = the REAL metres the boat passes off
// each buoy (default 30); a session that scales its course gets a wider shape
// radius so that distance survives the scaling.
// --------------------------------------------------

router.post("/sim/runs", async (req, res) => {
    try {
        const { sessionId, deviceId, speedKn, startInSec, roundingM } = req.body || {};
        if (!sessionId) return res.status(400).json({ error: "sessionId required" });
        if (deviceId) {
            res.status(201).json(await createRun({ sessionId, deviceId, speedKn, startInSec, roundingM }));
            return;
        }
        const { getSession } = require("../store/sessionStore");
        const s = await getSession(sessionId);
        if (!s) return res.status(404).json({ error: "session not found" });
        if (!s.boats.length) return res.status(400).json({ error: "session has no boats" });
        const runs = [];
        for (const b of s.boats) {
            runs.push(await createRun({ sessionId, deviceId: b.deviceId, speedKn, startInSec, roundingM }));
        }
        res.status(201).json({ runs });
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /sim/next — the device's single mock-fix poll (?deviceId= newest
// live run, or ?runId= for a specific one). One request per pass: live
// scripted sample wins; an exhausted device run retires into the walk;
// otherwise the server-driven walk (404 only when anchorless).
// --------------------------------------------------

router.get("/sim/next", async (req, res) => {
    try {
        const { deviceId, runId } = req.query;
        const run = runId ? getRun(runId)
            : (deviceId ? activeRunForDevice(deviceId) : null);
        const nowMs = Date.now();
        if (run) {
            const sample = nextSample(run, nowMs);
            if (!sample.done || runId) {
                const b = nextBatch(run, nowMs);
                return res.json({
                    runId: run.id,
                    deviceId: run.deviceId,
                    sessionId: run.sessionId,
                    serverTime: new Date(nowMs).toISOString(),
                    // Batch delivery: the device buffers these and refetches
                    // with 10 to spare, so a fix costs 1/30th of the requests.
                    // The flat fields below stay for a device that predates
                    // batching — it ignores `batch` and reads these.
                    batch: b.batch,
                    batchSize: b.batch.length,
                    ...sample,
                });
            }
            deleteRun(run.id); // exhausted: fall through to the walk below
        }
        if (!deviceId) return res.status(404).json({ error: "no live run" });
        const wb = await wanderBatch(deviceId, SIM_BATCH_MAX, nowMs);
        // Null only when there is no walk state AND nothing to seed from:
        // no browser anchor and no stored point for this boat or any boat.
        if (!wb || !wb.batch.length) return res.status(404).json({ error: "no wander seed available" });
        const head = wb.batch[0];
        res.json({
            deviceId,
            wander: true,
            seededFrom: wb.seededFrom,
            serverTime: head.st,
            batch: wb.batch,
            batchSize: wb.batch.length,
            // Flat compatibility fields for a pre-batching device.
            lat: head.lat,
            lon: head.lon,
            speed: head.speed,
            course: head.course,
        });
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /sim/tape — the WHOLE scripted run as one compact CSV tape
// (?deviceId= newest live run, or ?runId= for a specific one).
//
// The batched poll below is still the wander's transport, but it was a bad
// way to feed a RACE: the window is sliced by the server's clock, so a
// device that adopted the session late started mid-journey (race 182 began
// at t=130s and never saw the start or the first mark — a pass is then
// simply missing for the rest of the race), and a device that ran ahead was
// handed fixes it had already passed, dropped as replays in 13s lumps.
// One request buys the whole journey instead: the device plays it from RAM
// at its own 1Hz and nothing in the race depends on the network.
//
// One line per fix: epoch,lat,lon,speed,course — no ISO strings (the device
// formats the NMEA stamp from the epoch), so a 500s journey is ~20KB and
// the tool that reads it never builds a JSON tree.
router.get("/sim/tape", async (req, res) => {
    try {
        const { deviceId, runId } = req.query;
        const run = runId ? getRun(runId) : (deviceId ? activeRunForDevice(deviceId) : null);
        const from = Math.max(0, Math.floor(Number(req.query.from) || 0));
        const n = Math.max(1, Math.min(1200, Math.floor(Number(req.query.n) || 1200)));
        if (run) {
            const last = Math.min(run.samples.length, from + n);
            const base = Math.floor(run.startMs / 1000);
            const rows = [];
            for (let i = from; i < last; i++) {
                const s = run.samples[i];
                rows.push([
                    base + s.t, s.lat.toFixed(7), s.lon.toFixed(7),
                    Number(s.speed).toFixed(1), Math.round(s.course),
                ]);
            }
            return sendTape(res, run.id, run.sessionId, run.gunSec, run.durationSec, run.samples.length, rows);
        }
        if (!deviceId) return res.status(404).json({ error: "no live run" });
        // No scripted run: the same tape carries the walk (30 fixes), so the
        // device needs one URL and one reader whatever the mock is doing.
        // `from` is a journey cursor and means nothing to a walk.
        const wb = await wanderBatch(deviceId, SIM_BATCH_MAX, Date.now());
        if (!wb || !wb.batch.length) return res.status(404).json({ error: "no wander seed available" });
        const rows = wb.batch.map((s) => [
            Math.floor(new Date(s.st).getTime() / 1000),
            (+s.lat).toFixed(7), (+s.lon).toFixed(7),
            (+s.speed).toFixed(1), Math.round(s.course),
        ]);
        return sendTape(res, "wander", 0, 0, 0, rows.length, rows);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /sim/runs[?sessionId=] — run progress (no samples)
// --------------------------------------------------

router.get("/sim/runs", async (req, res) => {
    try {
        res.json(listRuns(req.query.sessionId));
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sim/echo — device-reported receipt of a scripted fix.
// {runId, t, lat, lon, speed?, course?} → stored per-run (no tracks).
// --------------------------------------------------

router.post("/sim/echo", async (req, res) => {
    try {
        const { runId, t, lat, lon, speed, course } = req.body || {};
        if (!runId) return res.status(400).json({ error: "runId required" });
        const meta = echoSample(runId, { t, lat, lon, speed, course });
        if (!meta) return res.status(404).json({ error: "run not found or bad fix" });
        res.json(meta);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /sim/runs/:id/points — scripted route preview for the map
// (downsampled 1:5 + every leg joint kept). Lets the indoor tester see
// the mock boat move without touching the gps_points track store.
// --------------------------------------------------

router.get("/sim/runs/:id/points", async (req, res) => {
    try {
        const run = getRun(req.params.id);
        if (!run) return res.status(404).json({ error: "run not found" });
        const pts = run.samples.filter((s, i) => i % 5 === 0 || i === run.samples.length - 1)
            .map(s => ({ t: s.t, lat: +s.lat.toFixed(7), lon: +s.lon.toFixed(7) }));
        res.json({
            id: run.id, sessionId: run.sessionId, deviceId: run.deviceId,
            startMs: run.startMs, gunMs: run.gunMs, durationSec: run.durationSec,
            points: pts,
        });
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /sim/routes/:sessionId — the scripted route a session's mock boat
// sailed, by SESSION rather than by run id.
//
// Keyed by session because that is all the frontend knows: it holds a
// selected session id. The run-id route above is unreachable at exactly the
// moment it matters, because a run is pruned 10 minutes after it ends — so
// asking for it by run id works while the race is live and 404s once the
// race is over and someone actually wants to look at it. Reads the persisted
// route, so it works after a restart too.
// --------------------------------------------------

router.get("/sim/routes/:sessionId", async (req, res) => {
    try {
        const sid = parseInt(req.params.sessionId, 10);
        if (!sid) return res.status(400).json({ error: "sessionId required" });
        const pts = await getRoutePoints(sid);
        if (!pts) return res.status(404).json({ error: "no scripted route for this session" });
        res.json(pts);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /sim/wander?deviceId= — server-driven wander fix (mock GPS with
// no scripted run). Anchored walk while the browser pushes a viewport,
// free random walk from the last position when it doesn't, 404 with
// neither (device holds).
// --------------------------------------------------

router.get("/sim/wander", async (req, res) => {
    try {
        const { deviceId } = req.query;
        if (!deviceId) return res.status(400).json({ error: "deviceId required" });
        const sample = await wanderNext(deviceId);
        if (!sample) return res.status(404).json({ error: "no wander seed available" });
        res.json(sample);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sim/anchor {lat, lon} — viewport anchor pushed by the frontend
// (map center on load / pan / keep-alive). The walk follows the map;
// sessions are ignored. Fresh 5 min, then fallbacks apply.
// --------------------------------------------------

router.post("/sim/anchor", async (req, res) => {
    try {
        const { lat, lon } = req.body || {};
        if (typeof lat !== "number" || typeof lon !== "number"
            || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) {
            return res.status(400).json({ error: "lat/lon must be numbers" });
        }
        res.json({ anchor: setPushedAnchor(lat, lon) });
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// DELETE /sim/runs/:id — stop a run
// --------------------------------------------------

router.delete("/sim/runs/:id", async (req, res) => {
    try {
        if (!deleteRun(req.params.id)) return res.status(404).json({ error: "run not found" });
        res.json({ status: "deleted" });
    } catch (e) {
        sendErr(res, e);
    }
});

module.exports = router;

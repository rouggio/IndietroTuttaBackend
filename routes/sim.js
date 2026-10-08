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
} = require("../store/sim");

const router = express.Router();

function sendErr(res, e) {
    return res.status(e.status || 500).json({ error: e.message || "internal error" });
}

// --------------------------------------------------
// POST /sim/runs — compile a scripted run off a session.
// {sessionId, deviceId?, speedKn?, startInSec?} — deviceId absent =
// one run per session boat.
// --------------------------------------------------

router.post("/sim/runs", async (req, res) => {
    try {
        const { sessionId, deviceId, speedKn, startInSec } = req.body || {};
        if (!sessionId) return res.status(400).json({ error: "sessionId required" });
        if (deviceId) {
            res.status(201).json(await createRun({ sessionId, deviceId, speedKn, startInSec }));
            return;
        }
        const { getSession } = require("../store/sessionStore");
        const s = await getSession(sessionId);
        if (!s) return res.status(404).json({ error: "session not found" });
        if (!s.boats.length) return res.status(400).json({ error: "session has no boats" });
        const runs = [];
        for (const b of s.boats) {
            runs.push(await createRun({ sessionId, deviceId: b.deviceId, speedKn, startInSec }));
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
                return res.json({
                    runId: run.id,
                    deviceId: run.deviceId,
                    sessionId: run.sessionId,
                    serverTime: new Date(nowMs).toISOString(),
                    ...sample,
                });
            }
            deleteRun(run.id); // exhausted: fall through to the walk below
        }
        if (!deviceId) return res.status(404).json({ error: "no live run" });
        const anchor = await wanderAnchorFor(deviceId);
        if (!anchor) return res.status(404).json({ error: "no wander anchor" });
        res.json(wanderSample(deviceId, anchor));
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
// GET /sim/wander?deviceId= — server-driven wander fix (mock GPS with
// no scripted run). Advances per-device random-walk state and returns
// {wander:true, lat, lon, speed:6, course, serverTime, anchor}.
// 404 when there is no anchor (no session + no tracks): the device
// then wanders locally instead.
// --------------------------------------------------

router.get("/sim/wander", async (req, res) => {
    try {
        const { deviceId } = req.query;
        if (!deviceId) return res.status(400).json({ error: "deviceId required" });
        const anchor = await wanderAnchorFor(deviceId);
        if (!anchor) return res.status(404).json({ error: "no wander anchor" });
        res.json(wanderSample(deviceId, anchor));
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

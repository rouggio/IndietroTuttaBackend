const express = require("express");

const {
    createRun,
    listRuns,
    deleteRun,
    nextSample,
    activeRunForDevice,
    getRun,
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
// GET /sim/next — wall-clock delivery (?deviceId= newest live run,
// or ?runId= for a specific one).
// --------------------------------------------------

router.get("/sim/next", async (req, res) => {
    try {
        const { deviceId, runId } = req.query;
        const run = runId ? getRun(runId)
            : (deviceId ? activeRunForDevice(deviceId) : null);
        if (!run) return res.status(404).json({ error: "no live run" });
        const nowMs = Date.now();
        res.json({
            runId: run.id,
            deviceId: run.deviceId,
            sessionId: run.sessionId,
            serverTime: new Date(nowMs).toISOString(),
            ...nextSample(run, nowMs),
        });
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

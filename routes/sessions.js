const express = require("express");

const {
    createSession,
    listSessions,
    getSession,
    updateSession,
    deleteSession,
    addBoat,
    removeBoat,
    repeatSession,
} = require("../store/sessionStore");

const {
    submitRun,
    listRuns,
} = require("../store/runStore");

const {
    raiseSignal,
    listSignals,
} = require("../store/signalStore");

const router = express.Router();

function sendErr(res, e) {
    return res.status(e.status || 500).json({ error: e.message || "internal error" });
}

// --------------------------------------------------
// GET /sessions[?date=YYYY-MM-DD]
// --------------------------------------------------

router.get("/sessions", async (req, res) => {
    try {
        const { date } = req.query;
        const cleanDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
        res.json(await listSessions({ date: cleanDate }));
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sessions — encapsulate a template (or ad-hoc shape) onto a day.
// {templateId?, snapshot:{name?,marks,startLine?,finishLine}?, date, mode?,
//  originLat, originLon, windDir, scale?, startTime?, name?}
// → frozen snapshot + resolved absolute marks.
// --------------------------------------------------

router.post("/sessions", async (req, res) => {
    try {
        res.status(201).json(await createSession(req.body || {}));
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /sessions/:id (includes boats)
// --------------------------------------------------

router.get("/sessions/:id", async (req, res) => {
    try {
        const s = await getSession(req.params.id);
        if (!s) return res.status(404).json({ error: "session not found" });
        res.json(s);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// PUT /sessions/:id — pre-start edits (wind/origin/scale/
// startTime/status); geometry edits re-resolve + bump version.
// --------------------------------------------------

router.put("/sessions/:id", async (req, res) => {
    try {
        const s = await updateSession(req.params.id, req.body || {});
        if (!s) return res.status(404).json({ error: "session not found" });
        res.json(s);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// DELETE /sessions/:id
// --------------------------------------------------

router.delete("/sessions/:id", async (req, res) => {
    try {
        const ok = await deleteSession(req.params.id);
        if (!ok) return res.status(404).json({ error: "session not found" });
        res.json({ status: "deleted" });
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sessions/:id/repeat — same course onto a new day.
// {date, mode?, name?} → fresh scheduled session, boats carried over.
// --------------------------------------------------

router.post("/sessions/:id/repeat", async (req, res) => {
    try {
        const { date, mode, name } = req.body || {};
        const s = await repeatSession(req.params.id, { date, mode, name });
        if (!s) return res.status(404).json({ error: "session not found" });
        res.status(201).json(s);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sessions/:id/boats — {deviceId, startOffsetSec?}
// (pursuit offsets live here; default 0 = fleet start)
// --------------------------------------------------

router.post("/sessions/:id/boats", async (req, res) => {
    try {
        const { deviceId, startOffsetSec } = req.body || {};
        const s = await addBoat(req.params.id, deviceId, startOffsetSec);
        if (!s) return res.status(404).json({ error: "session not found" });
        res.status(201).json(s);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// DELETE /sessions/:id/boats/:deviceId
// --------------------------------------------------

router.delete("/sessions/:id/boats/:deviceId", async (req, res) => {
    try {
        const s = await removeBoat(req.params.id, req.params.deviceId);
        if (!s) return res.status(404).json({ error: "session not found" });
        res.json(s);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sessions/:id/runs — device run upload at finish
// (retries replace). {deviceId, startEpoch, finishEpoch?,
// splits?, events?, result?}
// GET /sessions/:id/runs — results table (finished first, elapsed ASC)
// --------------------------------------------------

router.post("/sessions/:id/runs", async (req, res) => {
    try {
        const s = await getSession(req.params.id);
        if (!s) return res.status(404).json({ error: "session not found" });
        res.status(201).json(await submitRun({ ...(req.body || {}), sessionId: s.id }));
    } catch (e) {
        sendErr(res, e);
    }
});

router.get("/sessions/:id/runs", async (req, res) => {
    try {
        const s = await getSession(req.params.id);
        if (!s) return res.status(404).json({ error: "session not found" });
        res.json(await listRuns(s.id));
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sessions/:id/signals — committee raises a signal
// {kind: OCS|DSQ|DNF|RET|SCP|RECALL|ABANDON, deviceId?, detail?}
// GET /sessions/:id/signals — signal log
// --------------------------------------------------

router.post("/sessions/:id/signals", async (req, res) => {
    try {
        const s = await getSession(req.params.id);
        if (!s) return res.status(404).json({ error: "session not found" });
        res.status(201).json(await raiseSignal(s.id, req.body || {}));
    } catch (e) {
        sendErr(res, e);
    }
});

router.get("/sessions/:id/signals", async (req, res) => {
    try {
        const s = await getSession(req.params.id);
        if (!s) return res.status(404).json({ error: "session not found" });
        res.json(await listSignals(s.id));
    } catch (e) {
        sendErr(res, e);
    }
});

module.exports = router;

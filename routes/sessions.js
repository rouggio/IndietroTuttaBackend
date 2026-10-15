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

const {
    getDevice,
} = require("../store/deviceStore");

const {
    createRun,
} = require("../store/sim");

const {
    emit,
    scheduleGun,
    clearGun,
} = require("./events");

const router = express.Router();

function sendErr(res, e) {
    return res.status(e.status || 500).json({ error: e.message || "internal error" });
}

// A mock boat auto-starts its scripted sim (same as the Simulate button)
// so it begins sailing without a manual step. Used both by
// POST /sessions/:id/boats and by boats[] riding along a create call.
// Non-fatal: a failure here never blocks the boat being added.
async function autoSimMockBoats(session, deviceIds) {
    for (const raw of deviceIds || []) {
        const deviceId = typeof raw === "string" ? raw.trim() : "";
        if (!deviceId) continue;
        try {
            const dev = await getDevice(deviceId);
            if (dev && dev.mock) await createRun({ sessionId: session.id, deviceId });
        } catch (e) { /* non-fatal */ }
    }
}

// --------------------------------------------------
// GET /sessions[?date=YYYY-MM-DD]
// --------------------------------------------------

// GET /sessions — LIST ROWS ONLY (no course geometry). The pane renders
// name/date/boats/mode/status/courseVersion; geometry lives in
// GET /sessions/:id, which the pane fetches on selection.
//
//   ?date=YYYY-MM-DD        exact day (existing)
//   ?from=&to=YYYY-MM-DD    inclusive range
//   ?status=a,b             any of the inferred statuses (comma-separated)
//                           filtered AFTER deriveStatus — status is computed
//                           on read, so it cannot be a SQL predicate.
//   ?mode=practice,race      session mode (practice | race), SQL-side
// Unknown dates, statuses or modes are 400 rather than silently ignored.
const SESSION_STATUSES = ["scheduled", "live", "finished", "abandoned"];
const SESSION_MODES = ["practice", "race"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseListParam(raw, allowed) {
    if (!raw) return undefined;
    const wanted = String(raw).split(",").map(s => s.trim()).filter(Boolean);
    const bad = wanted.filter(s => !allowed.includes(s));
    if (bad.length) return { error: { error: `unknown: ${bad.join(",")}`, allowed } };
    return { wanted };
}

router.get("/sessions", async (req, res) => {
    try {
        const { date, from, to, status, mode } = req.query;
        const cleanDate = date && DATE_RE.test(date) ? date : undefined;
        if (date && !cleanDate) return res.status(400).json({ error: "date must be YYYY-MM-DD" });

        const cleanFrom = from && DATE_RE.test(from) ? from : undefined;
        const cleanTo = to && DATE_RE.test(to) ? to : undefined;
        if (from && !cleanFrom) return res.status(400).json({ error: "from must be YYYY-MM-DD" });
        if (to && !cleanTo) return res.status(400).json({ error: "to must be YYYY-MM-DD" });
        if (cleanFrom && cleanTo && cleanFrom > cleanTo) {
            return res.status(400).json({ error: "from must not be after to" });
        }

        const st = parseListParam(status, SESSION_STATUSES);
        if (st && st.error) {
            return res.status(400).json({ ...st.error, error: `unknown status: ${st.error.error}` });
        }
        const md = parseListParam(mode, SESSION_MODES);
        if (md && md.error) {
            return res.status(400).json({ error: `unknown mode: ${md.error.error}`, allowed: SESSION_MODES });
        }

        res.json(await listSessions({
            date: cleanDate, from: cleanFrom, to: cleanTo,
            status: st && st.wanted, mode: md && md.wanted,
        }));
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sessions — encapsulate a course (or ad-hoc shape) onto a day.
// {courseId?, snapshot:{name?,marks,startLine?,finishLine}?, boats?:
//   [{deviceId}], date, mode?, originLat, originLon, windDir,
//   scale?, startTime?, name?}
// → frozen snapshot + resolved absolute marks (+ boats, one round trip).
// Pursuit/handicap starts (per-boat startOffsetSec) were REMOVED in todo 13:
// one gun for the whole session. A leftover nonzero offset is rejected, not
// silently dropped — a caller asking for a staggered start deserves to know.
// --------------------------------------------------

function rejectPursuitOffset(body) {
    // Absent or 0 is a no-op and stays accepted (old clients send 0); a
    // NONZERO offset is rejected. Careful: Number(undefined) is NaN and
    // NaN !== 0, so an absent field must be filtered out explicitly.
    const nonzero = v => v !== undefined && v !== null && v !== "" && Number(v) !== 0;
    const boats = (body || {}).boats;
    const list = Array.isArray(boats) ? boats : [];
    const offenders = list.filter(b => b && typeof b === "object" && nonzero(b.startOffsetSec));
    if (offenders.length || nonzero((body || {}).startOffsetSec)) {
        return Object.assign(
            new Error("startOffsetSec is no longer supported — every boat shares the session gun (pursuit starts were removed)"),
            { status: 400 }
        );
    }
    return null;
}

router.post("/sessions", async (req, res) => {
    try {
        const pursuitErr = rejectPursuitOffset(req.body);
        if (pursuitErr) throw pursuitErr;
        const s = await createSession(req.body || {});
        if (Array.isArray((req.body || {}).boats)) {
            await autoSimMockBoats(s, req.body.boats.map((b) => (typeof b === "string" ? b : b && b.deviceId)));
        }
        emit("session.created", { id: s.id });
        scheduleGun(s.id, s.startTime);
        res.status(201).json(s);
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
        emit("session.updated", { id: s.id, status: s.status });
        scheduleGun(s.id, s.startTime);
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
        clearGun(req.params.id);
        emit("session.deleted", { id: Number(req.params.id) });
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
        emit("session.created", { id: s.id });
        scheduleGun(s.id, s.startTime);
        res.status(201).json(s);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /sessions/:id/boats - {deviceId}
// (a nonzero startOffsetSec is rejected: pursuit starts were removed)
// --------------------------------------------------

router.post("/sessions/:id/boats", async (req, res) => {
    try {
        const pursuitErr = rejectPursuitOffset(req.body);
        if (pursuitErr) throw pursuitErr;
        const { deviceId } = req.body || {};
        const s = await addBoat(req.params.id, deviceId);
        if (!s) return res.status(404).json({ error: "session not found" });
await autoSimMockBoats(s, typeof deviceId === "string" ? [deviceId] : []);
    emit("session.boats", { id: s.id });
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
        emit("session.boats", { id: s.id });
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
        const run = await submitRun({ ...(req.body || {}), sessionId: s.id });
        emit("session.runs", { id: s.id });
        res.status(201).json(run);
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
        const sig = await raiseSignal(s.id, req.body || {});
        emit("signal.raised", { sessionId: s.id, kind: sig.kind, deviceId: sig.deviceId || null });
        if ((req.body || {}).kind === "ABANDON") {
            clearGun(s.id);
            emit("session.status", { id: s.id, status: "abandoned" });
        }
        res.status(201).json(sig);
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

const express = require("express");

const {
    getSession,
    listSessions,
    deriveStatus,
} = require("../store/sessionStore");

const {
    getDevices,
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// GET /events — server-sent event stream (todo 2).
//
// One channel for session/boat/signal changes. Never GPS. The browser
// connects while the Sessions pane is open and closes it on hide; the
// 15s tickStatus stays as the fallback when the stream is down.
// Event shape: {type, ...} with types session.status, session.boats,
// session.updated, session.created, session.deleted, session.runs,
// signal.raised, boat.mock, device.status.
// --------------------------------------------------

const clients = new Set();

function send(res, type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Topic = event-type prefix (session|signal|boat|device). ?topics=a,b
// subscribes to a subset; absent/empty means all. Panes toggle interest by
// reconnecting with a new set — cheap, since events are rare.
router.get("/events", (req, res) => {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const topics = new Set(
        String(req.query.topics || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
    );
    res.sseTopics = topics;
    res.write(": connected\n\n");
    clients.add(res);
    // heartbeat comment so proxies don't idle-drop the stream
    const hb = setInterval(() => {
        try {
            res.write(": hb\n\n");
        } catch {
            // dead below, reaped on next emit or close
        }
    }, 25000);
    req.on("close", () => {
        clearInterval(hb);
        clients.delete(res);
    });
});

function emit(type, data) {
    const topic = String(type).split(".")[0];
    for (const res of [...clients]) {
        try {
            if (res.sseTopics && res.sseTopics.size && !res.sseTopics.has(topic)) continue;
            send(res, type, data);
        } catch {
            clients.delete(res);
        }
    }
}

// --------------------------------------------------
// Gun scheduler: status is derived on read, so no mutation fires when a
// gun passes. One timer per upcoming startTime re-derives and broadcasts
// the flip to live. Rescheduled on every session write; primed at boot.
// --------------------------------------------------

const gunTimers = new Map(); // sessionId -> Timeout

function clearGun(sessionId) {
    const t = gunTimers.get(Number(sessionId));
    if (t) {
        clearTimeout(t);
        gunTimers.delete(Number(sessionId));
    }
}

function scheduleGun(sessionId, startTime) {
    clearGun(sessionId);
    if (!startTime) return;
    const ms = new Date(startTime).getTime() - Date.now();
    if (!(ms > 0) || ms > 2147483647) return; // past or beyond setTimeout range
    gunTimers.set(
        Number(sessionId),
        setTimeout(async () => {
            gunTimers.delete(Number(sessionId));
            try {
                const s = await getSession(sessionId);
                if (!s) return;
                const status = await deriveStatus(s);
                if (status === "live") emit("session.status", { id: s.id, status });
            } catch {}
        }, ms)
    );
}

async function primeGuns() {
    try {
        const all = await listSessions();
        for (const s of all || []) scheduleGun(s.id, s.startTime);
    } catch {}
}

// --------------------------------------------------
// Liveness sweeper: device live/idle/offline is derived on read, so no
// mutation fires when a boat goes quiet. Every 30s re-derive and emit
// only on change (plus first-seen). Lets the frontend drop its 5s
// /boats poll while the stream is healthy.
// --------------------------------------------------

const lastBoatStatus = new Map(); // deviceId -> status

async function sweepBoats(seedOnly = false) {
    try {
        const all = await getDevices();
        for (const d of all || []) {
            const prev = lastBoatStatus.get(d.deviceId);
            if (prev === undefined) {
                lastBoatStatus.set(d.deviceId, d.status);
                if (!seedOnly) emit("boat.created", { deviceId: d.deviceId });
            } else if (prev !== d.status) {
                lastBoatStatus.set(d.deviceId, d.status);
                if (!seedOnly) emit("device.status", { deviceId: d.deviceId, status: d.status, lastSeen: d.lastSeen });
            }
        }
    } catch {}
}

function primeBoats() {
    sweepBoats(true);
    setInterval(() => sweepBoats(false), 30000);
}

module.exports = { router, emit, scheduleGun, clearGun, primeGuns, primeBoats };
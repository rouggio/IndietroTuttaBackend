const express = require("express");
const fetch = require("node-fetch");
const os = require("os");

const { PORT } = require("../config");

const {
    emit,
} = require("./events");

const {
    getDevices,
    getDevice,
    renameDevice,
    setDeviceMock,
    sanitizeUsername,
    sanitizeBoat
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// GET /devices
// --------------------------------------------------

router.get("/devices", async (req, res) => {
    res.json(await getDevices());
});

// --------------------------------------------------
// PUT /devices/:id — rename boat (name and/or make-model), no heartbeat side effects
// --------------------------------------------------

async function handleRename(req, res) {
    const { username, boat } = req.body || {};
    if (username === undefined && boat === undefined) {
        return res.status(400).json({ error: "username and/or boat required" });
    }
    let cleanUsername;
    let cleanBoat;
    if (username !== undefined) {
        cleanUsername = sanitizeUsername(username);
        if (!cleanUsername) return res.status(400).json({ error: "username must match [A-Za-z0-9 ._-]{1,32}" });
    }
    if (boat !== undefined) {
        const trimmed = typeof boat === "string" ? boat.trim() : "";
        if (trimmed) {
            cleanBoat = sanitizeBoat(trimmed);
            if (!cleanBoat) return res.status(400).json({ error: "boat must match [A-Za-z0-9 ._-]{1,64}" });
        } else {
            cleanBoat = null; // clear make/model
        }
    }
    const device = await renameDevice(req.params.id, { username: cleanUsername, boat: cleanBoat });
    if (!device) return res.status(404).json({ error: "Device not found" });
    const full = await getDevice(req.params.id);
    res.json(full || device);
}

router.put("/devices/:id", handleRename);

router.delete("/devices/:id", async (req, res) => {
    const { deleteDevice } = require("../store/deviceStore");
    const ok = await deleteDevice(req.params.id);
    if (!ok) return res.status(404).json({ error: "Device not found" });
    emit("boat.deleted", { deviceId: req.params.id });
    res.json({ status: "deleted" });
});

// --------------------------------------------------
// POST /devices/:id/mock {on:true|false} — toggle mock GPS via the device
// portal over LAN (uses the last-seen ip from health/gps heartbeats), then
// records the assumed mock state. Never touches lastSeen (no fake "live").
// 409 when the device has no known LAN ip (offline or never seen on LAN).
// --------------------------------------------------

async function handleMock(req, res) {
    const on = req.body?.on;
    if (typeof on !== "boolean") {
        return res.status(400).json({ error: "on must be a boolean" });
    }
    const device = await getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.ip) {
        return res.status(409).json({ error: "no known LAN ip for device" });
    }
    try {
        const r = await fetch(`http://${device.ip}/mock?on=${on ? 1 : 0}`, {
            method: "POST",
            timeout: 8000,
        });
        if (!r.ok) {
            return res.status(502).json({ error: `device portal refused mock (http ${r.status})` });
        }
    } catch (e) {
        return res.status(502).json({ error: "device portal unreachable" });
    }
    const updated = await setDeviceMock(req.params.id, on);
    emit("boat.mock", { deviceId: req.params.id, mock: on });
    res.json({ deviceId: req.params.id, mock: on, ip: updated?.ip || device.ip });
}

router.post("/devices/:id/mock", handleMock);

// Alias: /boats — globally renamed from Devices to Boats (keeps /devices for compat)
router.get("/boats", async (req, res) => {
    res.json(await getDevices());
});

// --------------------------------------------------
// POST /devices/:id/server {mode:"prod"|"dev", host?} — point the boat's
// telemetry + OTA at PROD (Render) or DEV (a laptop backend), by proxying the
// device portal's own /server switch over LAN. This is the UI face of
//   POST http://<device-ip>/server?mode=dev&host=<laptop-ip>:3000
// Nothing is stored here: the device owns the choice (NVS `srv`), so the
// answer reports what the device replied ({mode, host, base}).
// DEV with no explicit host = this backend's own LAN address + port, because
// that IS the machine the boat should talk to, and localhost is meaningless
// to the device.
// 409 no known LAN ip, 502 portal unreachable.
// --------------------------------------------------

// The address a boat can reach THIS backend on: first non-internal IPv4,
// skipping link-local and Tailscale's CGNAT range (a boat is not on the tailnet).
function backendLanHost() {
    const nets = os.networkInterfaces();
    const pick = [];
    for (const list of Object.values(nets)) {
        for (const n of list || []) {
            if (n.family !== "IPv4" || n.internal) continue;
            if (/^169\.254\./.test(n.address)) continue;
            if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(n.address)) continue;
            pick.push(n.address);
        }
    }
    // prefer a real private LAN (a phone hotspot and the house wifi are both
    // 192.168.x), then anything else that answered
    pick.sort((a, b) => {
        const rank = ip => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
        return rank(a) - rank(b);
    });
    return pick.length ? `${pick[0]}:${PORT}` : "";
}

const HOST_RE = /^[A-Za-z0-9.\-]{1,64}(:\d{1,5})?$/;

async function handleServer(req, res) {
    const mode = req.body?.mode;
    if (mode !== "prod" && mode !== "dev") {
        return res.status(400).json({ error: "mode must be prod or dev" });
    }
    let host = "";
    if (mode === "dev") {
        host = typeof req.body?.host === "string" ? req.body.host.trim() : "";
        if (host && !HOST_RE.test(host)) {
            return res.status(400).json({ error: "host must be an address or host:port" });
        }
        if (!host) host = backendLanHost();
        if (!host) {
            return res.status(409).json({ error: "cannot work out this backend's LAN address; pass host explicitly" });
        }
    }
    const device = await getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: "Device not found" });
    if (!device.ip) return res.status(409).json({ error: "no known LAN ip for device" });
    const url = `http://${device.ip}/server?mode=${mode}` +
        (host ? `&host=${encodeURIComponent(host)}` : "");
    try {
        const r = await fetch(url, { method: "POST", timeout: 8000 });
        if (!r.ok) {
            return res.status(502).json({ error: `device portal refused server switch (http ${r.status})` });
        }
        const body = await r.json().catch(() => ({}));
        return res.json({ deviceId: req.params.id, ip: device.ip, ...body });
    } catch (e) {
        return res.status(502).json({ error: "device portal unreachable" });
    }
}

router.post("/devices/:id/server", handleServer);
router.post("/boats/:id/server", handleServer);

router.put("/boats/:id", handleRename);

router.post("/boats/:id/mock", handleMock);

router.delete("/boats/:id", async (req, res) => {
    const { deleteDevice } = require("../store/deviceStore");
    const ok = await deleteDevice(req.params.id);
    if (!ok) return res.status(404).json({ error: "Device not found" });
    emit("boat.deleted", { deviceId: req.params.id });
    res.json({ status: "deleted" });
});
module.exports = router;

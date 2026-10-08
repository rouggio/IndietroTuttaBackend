const express = require("express");
const fetch = require("node-fetch");

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
    res.json({ deviceId: req.params.id, mock: on, ip: updated?.ip || device.ip });
}

router.post("/devices/:id/mock", handleMock);

// Alias: /boats — globally renamed from Devices to Boats (keeps /devices for compat)
router.get("/boats", async (req, res) => {
    res.json(await getDevices());
});

router.put("/boats/:id", handleRename);

router.post("/boats/:id/mock", handleMock);

router.delete("/boats/:id", async (req, res) => {
    const { deleteDevice } = require("../store/deviceStore");
    const ok = await deleteDevice(req.params.id);
    if (!ok) return res.status(404).json({ error: "Device not found" });
    res.json({ status: "deleted" });
});
module.exports = router;

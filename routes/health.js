const express = require("express");

const {
    getPointCount
} = require("../store/gpsStore");

const {
    upsertDevice
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// GET /health
// --------------------------------------------------

// GET /health doubles as heartbeat: every poll re-registers the device
// so the backend learns the username within ~30s even without GPS.
// Also updates lastSeen for live/idle status.
router.get("/health", async (req, res) => {
    const deviceId = req.header("DeviceId");
    const username = req.header("Username");

    if (deviceId) {
        await upsertDevice(deviceId, { username });
    }

    const count = await getPointCount();
    res.json({
        status: "ok",
        storedPoints: count,
        deviceId: deviceId || null,
        heartbeat: !!deviceId,
    });
});

// POST /health alias for devices that prefer POST as heartbeat
router.post("/health", async (req, res) => {
    const deviceId = req.header("DeviceId") || req.body?.deviceId;
    const username = req.header("Username") || req.body?.username;
    if (deviceId) await upsertDevice(deviceId, { username });
    const count = await getPointCount();
    res.json({ status: "ok", storedPoints: count, deviceId: deviceId || null, heartbeat: !!deviceId });
});

module.exports = router;
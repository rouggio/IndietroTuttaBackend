const express = require("express");

const {
    getPointCount
} = require("../store/gpsStore");

const {
    upsertDevice
} = require("../store/deviceStore");

const {
    getActiveSessionForDevice
} = require("../store/sessionStore");

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
    const firmware = req.header("Firmware-Version");

    if (deviceId) {
        await upsertDevice(deviceId, { username, firmware, ip: req.ip });
    }

    // NOTE: no storedPoints here — COUNT(*) per heartbeat cost a full
    // extra Turso round trip on the hottest endpoint (5s live poll).

    // Race push: assigned session (geometry + start) rides the heartbeat.
    // Null when the device has no scheduled/live session.
    let session = null;
    try {
        session = await getActiveSessionForDevice(deviceId);
    } catch (e) {
        session = null;
    }

    res.json({
        status: "ok",
        deviceId: deviceId || null,
        heartbeat: !!deviceId,
        serverTime: new Date().toISOString(),
        session,
    });
});

// POST /health alias for devices that prefer POST as heartbeat
router.post("/health", async (req, res) => {
    const deviceId = req.header("DeviceId") || req.body?.deviceId;
    const username = req.header("Username") || req.body?.username;
    const firmware = req.header("Firmware-Version") || req.body?.firmware || req.body?.fw;
    if (deviceId) await upsertDevice(deviceId, { username, firmware, ip: req.ip });
    const count = await getPointCount();
    res.json({ status: "ok", storedPoints: count, deviceId: deviceId || null, heartbeat: !!deviceId, serverTime: new Date().toISOString() });
});

module.exports = router;
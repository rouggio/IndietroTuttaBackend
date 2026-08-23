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

router.get("/health", (req, res) => {

    const deviceId = req.header("DeviceId");
    const username = req.header("Username");

    // Every poll re-registers the device, so the backend learns the
    // username within ~30s of the device coming online even without GPS
    if (deviceId) {
        upsertDevice(deviceId, { username });
    }

    res.json({
        status: "ok",
        storedPoints: getPointCount(),
        deviceId: deviceId || null
    });
});

module.exports = router;
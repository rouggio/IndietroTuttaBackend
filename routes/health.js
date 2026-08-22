const express = require("express");

const {
    getPointCount
} = require("../store/gpsStore");

const router = express.Router();

// --------------------------------------------------
// GET /health
// --------------------------------------------------

router.get("/health", (req, res) => {

    const deviceId = req.header("DeviceId");

    res.json({
        status: "ok",
        storedPoints: getPointCount(),
        deviceId: deviceId || null
    });
});

module.exports = router;
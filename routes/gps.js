const express = require("express");

const {
    addPoint,
    getPoints,
    getLatestPoint
} = require("../store/gpsStore");

const {
    upsertDevice,
    getDevice,
    sanitizeUsername
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// POST /gps
// --------------------------------------------------

router.post("/gps", (req, res) => {

    const deviceId = req.header("DeviceId");

    const {
        lat,
        lon,
        speed = null,
        course = null,
        altitude = null,
        sats = null,
        flagged = false,
        username = null,
        timestamp = new Date().toISOString()
    } = req.body;

    // --------------------------------------------------
    // Validate coordinates
    // --------------------------------------------------

    if (
        typeof lat !== "number" ||
        typeof lon !== "number"
    ) {
        return res.status(400).json({
            error: "lat and lon must be numbers"
        });
    }

    // --------------------------------------------------
    // Validate flagged
    // --------------------------------------------------

    if (typeof flagged !== "boolean") {
        return res.status(400).json({
            error: "flagged must be a boolean"
        });
    }

    // --------------------------------------------------
    // Register/update the device identity (keyed by MAC)
    // --------------------------------------------------

    const device = upsertDevice(deviceId, { username });

    // --------------------------------------------------
    // Store point
    // --------------------------------------------------

    addPoint({
        lat,
        lon,
        speed,
        course,
        altitude,
        sats,
        flagged,
        timestamp,
        receivedAt: new Date().toISOString(),
        deviceId,
        username: sanitizeUsername(username) ||
                  (device && device.username) ||
                  null
    });

    // --------------------------------------------------
    // Response
    // --------------------------------------------------

    res.json({
        status: "ok",
        stored: getPoints().length
    });
});

// --------------------------------------------------
// GET /gps
// --------------------------------------------------

router.get("/gps", (req, res) => {
    res.json(getPoints());
});

// --------------------------------------------------
// GET /gps/latest
// --------------------------------------------------

router.get("/gps/latest", (req, res) => {

    const latest = getLatestPoint();

    if (!latest) {
        return res.status(404).json({
            error: "No GPS data available"
        });
    }

    res.json(latest);
});

module.exports = router;
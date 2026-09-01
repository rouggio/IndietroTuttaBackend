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

router.post("/gps", async (req, res) => {

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

    const device = await upsertDevice(deviceId, { username });

    // --------------------------------------------------
    // Store point
    // --------------------------------------------------

    await addPoint({
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

    const count = (await getPoints()).length;
    res.json({
        status: "ok",
        stored: count
    });
});

// --------------------------------------------------
// GET /gps
// --------------------------------------------------

router.get("/gps", async (req, res) => {
    const { date, deviceId } = req.query;
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        return res.status(400).json({ error: "deviceId query param required" });
    }
    const cleanDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    const cleanDeviceId = deviceId.trim();
    res.json(await getPoints({ date: cleanDate, deviceId: cleanDeviceId }));
});

// --------------------------------------------------
// GET /gps/latest
// --------------------------------------------------

router.get("/gps/latest", async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        return res.status(400).json({ error: "deviceId query param required" });
    }
    const latest = await getLatestPoint(deviceId.trim());

    if (!latest) {
        return res.status(404).json({
            error: "No GPS data available"
        });
    }

    res.json(latest);
});

module.exports = router;
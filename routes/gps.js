const express = require("express");

const {
    addPoint,
    getPoints,
    getLatestPoint,
    getActiveDays,
    getPointCount,
    pushSimPoint,
    getSimSince
} = require("../store/gpsStore");

const {
    upsertDevice,
    getDevice,
    setDeviceMock,
    sanitizeUsername
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// POST /gps
// --------------------------------------------------

router.post("/gps", async (req, res) => {

    const deviceId = req.header("DeviceId");
    const firmware = req.header("Firmware-Version");

    const {
        lat,
        lon,
        speed = null,
        course = null,
        altitude = null,
        sats = null,
        username = null,
        simulated = false,
        fw = null,
        firmware: bodyFirmware = null,
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
    // Register/update the device identity (keyed by MAC)
    // --------------------------------------------------

    const device = await upsertDevice(deviceId, { username, firmware: firmware || bodyFirmware || fw, ip: req.ip });

    // Keep the assumed mock flag in sync with what the device actually
    // reports: simulated uploads mean mock is on, real ones mean it's off.
    // Writes only on a transition, never per upload.
    if (device && deviceId) {
        const isSim = simulated === true ? 1 : 0;
        if (device.mock !== isSim) {
            try { await setDeviceMock(deviceId, isSim); } catch (e) { /* ignore */ }
        }
    }

    // --------------------------------------------------
    // Store point — simulated uploads NEVER touch Turso: they live in
    // the ephemeral memory buffer (map overlay only, gone on restart).
    // --------------------------------------------------

    if (simulated === true) {
        pushSimPoint({
            lat, lon, speed, course, altitude, sats,
            timestamp,
            receivedAt: new Date().toISOString(),
            deviceId,
            username: sanitizeUsername(username) ||
                      (device && device.username) ||
                      null
        });
        return res.json({ status: "ok", stored: false, simulated: true });
    }

    await addPoint({
        lat,
        lon,
        speed,
        course,
        altitude,
        sats,
        simulated,
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

    // Response: cheap COUNT(*) — never fetch all points per upload
    // (getPoints() here cost a full table scan every ~2s per device).
    const count = await getPointCount();
    res.json({
        status: "ok",
        stored: count
    });
});

// --------------------------------------------------
// GET /gps/sim-live?deviceId= — the single latest sim point for one
// boat (or [] when none). No history by design: the frontend keeps
// only points newer than its own load, so a refresh picks up
// upcoming fixes exclusively.
// --------------------------------------------------

router.get("/gps/sim-live", async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        return res.status(400).json({ error: "deviceId query param required" });
    }
    res.json(getSimSince(deviceId.trim()));
});

// --------------------------------------------------
// GET /gps
// --------------------------------------------------

router.get("/gps", async (req, res) => {
    const { date, deviceId, start, end, since } = req.query;
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        return res.status(400).json({ error: "deviceId query param required" });
    }
    const cleanDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    const cleanDeviceId = deviceId.trim();
    let cleanStart = null, cleanEnd = null, cleanSince = null;
    if (since) {
        const s = new Date(since);
        if (!isNaN(s.getTime())) cleanSince = s.toISOString();
    }
    if (start) {
        const s = new Date(start);
        if (!isNaN(s.getTime())) cleanStart = s.toISOString();
    }
    if (end) {
        const e = new Date(end);
        if (!isNaN(e.getTime())) cleanEnd = e.toISOString();
    }
    // Live-append mode: a valid `since` wins over start/end/date. Exclusive
    // cursor, capped tail, same row shape as the range path.
    if (cleanSince) {
        res.json(await getPoints({ deviceId: cleanDeviceId, since: cleanSince }));
    } else if (cleanStart || cleanEnd) {
        // if range provided, it takes precedence over date
        res.json(await getPoints({ deviceId: cleanDeviceId, start: cleanStart, end: cleanEnd }));
    } else {
        res.json(await getPoints({ date: cleanDate, deviceId: cleanDeviceId }));
    }
});

// --------------------------------------------------
// GET /gps/days — days with track data for a device (per-boat calendar)
// --------------------------------------------------

router.get("/gps/days", async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        return res.status(400).json({ error: "deviceId query param required" });
    }
    res.json(await getActiveDays(deviceId.trim()));
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
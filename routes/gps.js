const express = require("express");

const {
    addPoint,
    getPoints,
    getLatestPoint,
    getActiveDays,
    getPointCount,
    deleteFlaggedByUid,
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
        flagged = false,
        username = null,
        uid = null,
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
        flagged,
        uid,
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
// DELETE /gps/flagged — delete flagged point by exact uid (device waypoint delete)
// --------------------------------------------------

router.delete("/gps/flagged", async (req, res) => {
    const deviceId = req.header("DeviceId");
    if (!deviceId) return res.status(400).json({ error: "DeviceId header required" });

    const { uid } = req.body || {};
    if (typeof uid !== "string" || !uid.trim()) {
        return res.status(400).json({ error: "uid must be a non-empty string" });
    }

    const deletedId = await deleteFlaggedByUid(deviceId, uid.trim());
    if (deletedId == null) return res.status(404).json({ error: "No matching flagged point" });
    res.json({ status: "deleted", id: deletedId });
});

// --------------------------------------------------
// GET /gps
// --------------------------------------------------

router.get("/gps", async (req, res) => {
    const { date, deviceId, start, end, flagged } = req.query;
    if (!deviceId || typeof deviceId !== "string" || !deviceId.trim()) {
        return res.status(400).json({ error: "deviceId query param required" });
    }
    const cleanDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    const cleanDeviceId = deviceId.trim();
    let cleanStart = null, cleanEnd = null;
    if (start) {
        const s = new Date(start);
        if (!isNaN(s.getTime())) cleanStart = s.toISOString();
    }
    if (end) {
        const e = new Date(end);
        if (!isNaN(e.getTime())) cleanEnd = e.toISOString();
    }
    // if range provided, it takes precedence over date
    // flagged=true limits to device waypoint flags (course adopter)
    const flaggedOnly = flagged === "true" || flagged === "1";
    if (cleanStart || cleanEnd) {
        res.json(await getPoints({ deviceId: cleanDeviceId, start: cleanStart, end: cleanEnd, flaggedOnly }));
    } else {
        res.json(await getPoints({ date: cleanDate, deviceId: cleanDeviceId, flaggedOnly }));
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
const express = require("express");

const {
    getPointCount
} = require("../store/gpsStore");

const {
    upsertDevice
} = require("../store/deviceStore");

const { getActiveRaceForDevice } = require("../store/raceStore");
const { getCourse } = require("../store/courseStore");

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

    // Piggyback active race + course for this device (wireframe push)
    let race = null;
    let course = null;
    if (deviceId) {
        race = await getActiveRaceForDevice(deviceId);
        if (race && race.courseId) {
            course = await getCourse(race.courseId);
        }
    }

    res.json({
        status: "ok",
        storedPoints: count,
        deviceId: deviceId || null,
        heartbeat: !!deviceId,
        race: race || null,
        course: course || null,
        serverTime: new Date().toISOString(),
    });
});

// POST /health alias for devices that prefer POST as heartbeat
router.post("/health", async (req, res) => {
    const deviceId = req.header("DeviceId") || req.body?.deviceId;
    const username = req.header("Username") || req.body?.username;
    if (deviceId) await upsertDevice(deviceId, { username });
    const count = await getPointCount();
    let race = null;
    let course = null;
    if (deviceId) {
        race = await getActiveRaceForDevice(deviceId);
        if (race && race.courseId) course = await getCourse(race.courseId);
    }
    res.json({ status: "ok", storedPoints: count, deviceId: deviceId || null, heartbeat: !!deviceId, race: race || null, course: course || null, serverTime: new Date().toISOString() });
});

module.exports = router;
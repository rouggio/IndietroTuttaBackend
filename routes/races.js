const express = require("express");
const { createRace, getRaces, getRace, getActiveRaceForDevice, updateRace, deleteRace } = require("../store/raceStore");
const { getCourse } = require("../store/courseStore");

const router = express.Router();

// --------------------------------------------------
// GET /races
// --------------------------------------------------
router.get("/races", async (req, res) => {
    res.json(await getRaces());
});

// --------------------------------------------------
// GET /races/active?deviceId=MAC — race assigned to this device (for health piggyback)
// --------------------------------------------------
router.get("/races/active", async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });
    const race = await getActiveRaceForDevice(deviceId);
    if (!race) return res.json(null);
    // include course wireframe if assigned
    let course = null;
    if (race.courseId) course = await getCourse(race.courseId);
    res.json({ ...race, course });
});

// --------------------------------------------------
// GET /races/:id
// --------------------------------------------------
router.get("/races/:id", async (req, res) => {
    const race = await getRace(req.params.id);
    if (!race) return res.status(404).json({ error: "Race not found" });
    let course = null;
    if (race.courseId) course = await getCourse(race.courseId);
    res.json({ ...race, course });
});

// --------------------------------------------------
// POST /races
// --------------------------------------------------
router.post("/races", async (req, res) => {
    try {
        const { name, courseId, startTime, status, participants } = req.body;
        const race = await createRace({ name, courseId, startTime, status, participants });
        res.status(201).json(race);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// --------------------------------------------------
// PUT /races/:id
// --------------------------------------------------
router.put("/races/:id", async (req, res) => {
    try {
        const { name, courseId, startTime, status, participants } = req.body;
        const race = await updateRace(req.params.id, { name, courseId, startTime, status, participants });
        if (!race) return res.status(404).json({ error: "Race not found" });
        res.json(race);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// --------------------------------------------------
// DELETE /races/:id
// --------------------------------------------------
router.delete("/races/:id", async (req, res) => {
    const ok = await deleteRace(req.params.id);
    if (!ok) return res.status(404).json({ error: "Race not found" });
    res.json({ status: "deleted" });
});

module.exports = router;

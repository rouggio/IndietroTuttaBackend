const express = require("express");

const {
    getDevices
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// GET /devices
// --------------------------------------------------

router.get("/devices", async (req, res) => {
    res.json(await getDevices());
});

router.delete("/devices/:id", async (req, res) => {
    const { deleteDevice } = require("../store/deviceStore");
    const ok = await deleteDevice(req.params.id);
    if (!ok) return res.status(404).json({ error: "Device not found" });
    res.json({ status: "deleted" });
});

// Alias: /boats — globally renamed from Devices to Boats (keeps /devices for compat)
router.get("/boats", async (req, res) => {
    res.json(await getDevices());
});

router.delete("/boats/:id", async (req, res) => {
    const { deleteDevice } = require("../store/deviceStore");
    const ok = await deleteDevice(req.params.id);
    if (!ok) return res.status(404).json({ error: "Device not found" });
    res.json({ status: "deleted" });
});
module.exports = router;

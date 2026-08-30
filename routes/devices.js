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

// Alias: /boats — globally renamed from Devices to Boats (keeps /devices for compat)
router.get("/boats", async (req, res) => {
    res.json(await getDevices());
});

module.exports = router;

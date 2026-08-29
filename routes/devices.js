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

module.exports = router;

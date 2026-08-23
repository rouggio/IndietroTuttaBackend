const express = require("express");

const {
    getDevices
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// GET /devices
// --------------------------------------------------

router.get("/devices", (req, res) => {
    res.json(getDevices());
});

module.exports = router;

const express = require("express");

const { getWind } = require("../store/wind");

const router = express.Router();

// --------------------------------------------------
// GET /wind?lat=&lon= — suggest-only wind for the session dial.
// Chain: WU PWS → Weathercloud → Open-Meteo model.
// Advises, never decides: caller freezes the value into the session.
// --------------------------------------------------

router.get("/wind", async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return res.status(400).json({ error: "lat (-90..90) and lon (-180..180) query params required" });
    }
    try {
        res.json(await getWind(lat, lon));
    } catch (e) {
        res.status(502).json({ error: "no wind source available" });
    }
});

module.exports = router;

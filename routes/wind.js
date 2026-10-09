const express = require("express");

const { getWind } = require("../store/wind");

const router = express.Router();

// --------------------------------------------------
// GET /wind?lat=&lon=[&provider=auto|wu|wc|om] — suggest-only wind
// for the session dial and the wind pane.
// Chain: WU PWS → Weathercloud → Open-Meteo model; `provider` forces a
// single source. Advises, never decides: caller freezes the value.
// --------------------------------------------------

router.get("/wind", async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return res.status(400).json({ error: "lat (-90..90) and lon (-180..180) query params required" });
    }
    const provider = String(req.query.provider || "auto").toLowerCase();
    if (!["auto", "wu", "wc", "om"].includes(provider)) {
        return res.status(400).json({ error: "provider must be one of auto|wu|wc|om" });
    }
    try {
        const w = await getWind(lat, lon, provider);
        if (!w) return res.status(502).json({ error: `no data from provider '${provider}'` });
        res.json(w);
    } catch (e) {
        res.status(502).json({ error: "no wind source available" });
    }
});

module.exports = router;
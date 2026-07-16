const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS access for frontend
app.use(cors());

// serve public site
app.use(express.static(path.join(__dirname, "public")));

// Parse JSON bodies
app.use(express.json());

// Circular buffer (simple implementation)
const MAX_POINTS = 500;
const points = [];

/**
 * POST /gps
 *
 * Example body:
 * {
 *   "lat": 39.92526367,
 *   "lon": 9.656643667,
 *   "speed": 12.5,
 *   "course": 271.2,
 *   "altitude": 18,
 *   "sats": 9,
 *   "timestamp": "2026-07-16T08:15:00Z"
 * }
 */
app.post("/gps", (req, res) => {
    const {
        lat,
        lon,
        speed = null,
        course = null,
        altitude = null,
        sats = null,
        timestamp = new Date().toISOString()
    } = req.body;

    if (typeof lat !== "number" || typeof lon !== "number") {
        return res.status(400).json({
            error: "lat and lon must be numbers"
        });
    }

    points.push({
        lat,
        lon,
        speed,
        course,
        altitude,
        sats,
        timestamp,
        receivedAt: new Date().toISOString()
    });

    // Keep only last 100 entries
    if (points.length > MAX_POINTS) {
        points.shift();
    }

    res.json({
        status: "ok",
        stored: points.length
    });
});


/**
 * Returns all stored points
 */
app.get("/gps", (req, res) => {
    res.json(points);
});


/**
 * Returns latest point
 */
app.get("/gps/latest", (req, res) => {
    if (points.length === 0) {
        return res.status(404).json({
            error: "No GPS data available"
        });
    }

    res.json(points[points.length - 1]);
});


/**
 * Health check
 */
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        storedPoints: points.length
    });
});

app.listen(PORT, () => {
    console.log(`GPS server listening on port ${PORT}`);
});
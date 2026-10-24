require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const { initDb } = require("./store/db");

const gpsRoutes = require("./routes/gps");
const healthRoutes = require("./routes/health");
const devicesRoutes = require("./routes/devices");
const coursesRoutes = require("./routes/courses");
const sessionsRoutes = require("./routes/sessions");
const simRoutes = require("./routes/sim");
const windRoutes = require("./routes/wind");
const { router: eventsRoutes, primeGuns, primeBoats } = require("./routes/events");

const app = express();

const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// Routes
// --------------------------------------------------

app.use("/", gpsRoutes);
app.use("/", healthRoutes);
app.use("/", devicesRoutes);
app.use("/", coursesRoutes);
app.use("/", sessionsRoutes);
app.use("/", simRoutes);
app.use("/", windRoutes);
app.use("/", eventsRoutes);

// --------------------------------------------------
// Start server
// --------------------------------------------------

initDb().then(async () => {
    primeGuns();
    primeBoats();
    // Todo 63: a sandbox player lives in RAM, so whatever the last process
    // was sailing is gone. Abandon those sessions before serving anything —
    // a simulated race with no runs derives `live` for ever, which is the
    // one state nobody can clean up from the UI.
    try {
        await require("./store/simPlayer").sweepOrphanedSimSessions();
    } catch (e) {
        console.warn("[simPlayer] boot sweep failed:", e.message);
    }
    app.listen(PORT, () => {
        console.log(`IndietroTutta server listening on port ${PORT}`);
    });
}).catch(err => {
    console.error("Failed to init DB, starting without it:", err.message);
    app.listen(PORT, () => {
        console.log(`IndietroTutta server listening on port ${PORT} (no DB)`);
    });
});
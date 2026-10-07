require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const { initDb } = require("./store/db");

const gpsRoutes = require("./routes/gps");
const healthRoutes = require("./routes/health");
const devicesRoutes = require("./routes/devices");
const templatesRoutes = require("./routes/templates");
const sessionsRoutes = require("./routes/sessions");
const simRoutes = require("./routes/sim");
const windRoutes = require("./routes/wind");

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
app.use("/", templatesRoutes);
app.use("/", sessionsRoutes);
app.use("/", simRoutes);
app.use("/", windRoutes);

// --------------------------------------------------
// Start server
// --------------------------------------------------

initDb().then(() => {
    app.listen(PORT, () => {
        console.log(`IndietroTutta server listening on port ${PORT}`);
    });
}).catch(err => {
    console.error("Failed to init DB, starting without it:", err.message);
    app.listen(PORT, () => {
        console.log(`IndietroTutta server listening on port ${PORT} (no DB)`);
    });
});
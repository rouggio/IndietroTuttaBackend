require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const { initDb } = require("./store/db");

const gpsRoutes = require("./routes/gps");
const healthRoutes = require("./routes/health");
const devicesRoutes = require("./routes/devices");
const coursesRoutes = require("./routes/courses");

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

// --------------------------------------------------
// Start server
// --------------------------------------------------

initDb().then(() => {
    app.listen(PORT, () => {
        console.log(`GPS server listening on port ${PORT}`);
    });
}).catch(err => {
    console.error("Failed to init DB, starting without it:", err.message);
    app.listen(PORT, () => {
        console.log(`GPS server listening on port ${PORT} (no DB)`);
    });
});
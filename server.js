const express = require("express");
const path = require("path");
const cors = require("cors");

const gpsRoutes = require("./routes/gps");
const healthRoutes = require("./routes/health");
const mapRoutes = require("./routes/map");

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
app.use("/", mapRoutes);

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, () => {
    console.log(`GPS server listening on port ${PORT}`);
});
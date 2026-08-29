const express = require("express");
const path = require("path");
const fs = require("fs");

const router = express.Router();

// --------------------------------------------------
// GET /courses/templates
// --------------------------------------------------
router.get("/courses/templates", (req, res) => {
    try {
        const filePath = path.join(__dirname, "..", "courses", "templates.json");
        const raw = fs.readFileSync(filePath, "utf8");
        const templates = JSON.parse(raw);
        res.json(templates);
    } catch (e) {
        console.error("[courses] failed to load templates:", e.message);
        res.status(500).json({ error: "Failed to load templates" });
    }
});

module.exports = router;

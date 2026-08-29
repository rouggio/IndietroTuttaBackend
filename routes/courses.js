const express = require("express");
const path = require("path");
const fs = require("fs");
const { createCourse, getCourses, getCourse, updateCourse, deleteCourse } = require("../store/courseStore");

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

// --------------------------------------------------
// GET /courses
// --------------------------------------------------
router.get("/courses", async (req, res) => {
    res.json(await getCourses());
});

// --------------------------------------------------
// GET /courses/:id
// --------------------------------------------------
router.get("/courses/:id", async (req, res) => {
    const course = await getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: "Course not found" });
    res.json(course);
});

// --------------------------------------------------
// POST /courses
// --------------------------------------------------
router.post("/courses", async (req, res) => {
    try {
        const { name, description, marks } = req.body;
        const course = await createCourse({ name, description, marks });
        res.status(201).json(course);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// --------------------------------------------------
// PUT /courses/:id
// --------------------------------------------------
router.put("/courses/:id", async (req, res) => {
    try {
        const { name, description, marks } = req.body;
        const course = await updateCourse(req.params.id, { name, description, marks });
        if (!course) return res.status(404).json({ error: "Course not found" });
        res.json(course);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// --------------------------------------------------
// DELETE /courses/:id
// --------------------------------------------------
router.delete("/courses/:id", async (req, res) => {
    const ok = await deleteCourse(req.params.id);
    if (!ok) return res.status(404).json({ error: "Course not found" });
    res.json({ status: "deleted" });
});

module.exports = router;

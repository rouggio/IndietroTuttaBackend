const express = require("express");

const {
    getTemplates,
    getTemplate,
    createCourse,
    listCourses,
    getCourse,
    updateCourse,
    deleteCourse,
} = require("../store/courseStore");

const router = express.Router();

function sendErr(res, e) {
    return res.status(e.status || 500).json({ error: e.message || "internal error" });
}

// --------------------------------------------------
// GET /courses/templates — the 5 wind-frame presets (no DB)
// --------------------------------------------------

router.get("/courses/templates", (req, res) => {
    res.json(getTemplates());
});

// --------------------------------------------------
// GET /courses[?templates=1]
// --------------------------------------------------

router.get("/courses", async (req, res) => {
    try {
        res.json(await listCourses({ templatesOnly: req.query.templates === "1" }));
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /courses — {name, owner?, marks} or {name, template: key}
// --------------------------------------------------

router.post("/courses", async (req, res) => {
    try {
        const { name, owner, marks, template, is_template } = req.body || {};
        let finalMarks = marks;
        if (template) {
            const t = getTemplate(template);
            if (!t) return res.status(400).json({ error: "unknown template" });
            finalMarks = finalMarks || t.marks;
        }
        const course = await createCourse({ name, owner, marks: finalMarks, is_template });
        res.status(201).json(course);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /courses/:id
// --------------------------------------------------

router.get("/courses/:id", async (req, res) => {
    try {
        const course = await getCourse(req.params.id);
        if (!course) return res.status(404).json({ error: "course not found" });
        res.json(course);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// PUT /courses/:id — {name?, marks?}, bumps version
// --------------------------------------------------

router.put("/courses/:id", async (req, res) => {
    try {
        const { name, marks } = req.body || {};
        const course = await updateCourse(req.params.id, { name, marks });
        if (!course) return res.status(404).json({ error: "course not found" });
        res.json(course);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// DELETE /courses/:id
// --------------------------------------------------

router.delete("/courses/:id", async (req, res) => {
    try {
        const ok = await deleteCourse(req.params.id);
        if (!ok) return res.status(404).json({ error: "course not found" });
        res.json({ status: "deleted" });
    } catch (e) {
        sendErr(res, e);
    }
});

module.exports = router;

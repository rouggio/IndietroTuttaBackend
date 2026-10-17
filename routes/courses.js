const express = require("express");

const {
    createCourse,
    listCourses,
    getCourse,
    updateCourse,
    deleteCourse,
    validateMarks,
    validateLines,
} = require("../store/courseStore");

const router = express.Router();

function sendErr(res, e) {
    return res.status(e.status || 500).json({ error: e.message || "internal error" });
}

// --------------------------------------------------
// GET /courses — every course: the five read-only built-ins first
// (builtinKey set), then the user's own alphabetically.
// --------------------------------------------------

router.get("/courses", async (req, res) => {
    try {
        res.json(await listCourses());
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /courses — {name, desc?, owner?, marks, startLine?, finishLine?}
// --------------------------------------------------

router.post("/courses", async (req, res) => {
    try {
        const { name, desc, owner, marks, startLine, finishLine } = req.body || {};
        const course = await createCourse({ name, desc, owner, marks, startLine, finishLine });
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
        const c = await getCourse(req.params.id);
        if (!c) return res.status(404).json({ error: "course not found" });
        res.json(c);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// PUT /courses/:id — {name?, desc?, marks?, startLine?, finishLine?}
// 403 on a built-in (save a copy instead).
// --------------------------------------------------

router.put("/courses/:id", async (req, res) => {
    try {
        const { name, desc, marks, startLine, finishLine } = req.body || {};
        const cur = await getCourse(req.params.id);
        if (!cur) return res.status(404).json({ error: "course not found" });
        const c = await updateCourse(req.params.id, { name, desc, marks, startLine, finishLine });
        res.json(c);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// DELETE /courses/:id — 403 on a built-in.
// --------------------------------------------------

router.delete("/courses/:id", async (req, res) => {
    try {
        const cur = await getCourse(req.params.id);
        if (!cur) return res.status(404).json({ error: "course not found" });
        const ok = await deleteCourse(req.params.id);
        if (!ok) return res.status(404).json({ error: "course not found" });
        res.json({ status: "deleted" });
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /courses/:id/sim-route — the compiled simulator route for this
// course's SHAPE (todo 32). Wind-frame metres, no placement: the start
// line centre, then every mark already offset to the required side by
// `roundingM` (default 30m, in shape metres here: a course has no scale),
// gates collapsed to their crossing point,
// then the finish centre. A session rotates/scales/places exactly this
// list; it is compiled once per shape and kept on the course row.
// `?roundingM=` recompiles at another radius (experiments).
// --------------------------------------------------

router.get("/courses/:id/sim-route", async (req, res) => {
    try {
        const c = await getCourse(req.params.id);
        if (!c) return res.status(404).json({ error: "course not found" });
        const { routeForCourse, shapeOfCourse, DEFAULT_ROUNDING_M } = require("../store/simShape");
        const { key, roundingM, wps, cached } = await routeForCourse(
            c,
            req.query.roundingM === undefined ? DEFAULT_ROUNDING_M : req.query.roundingM
        );
        res.json({
            courseId: c.id,
            name: c.name,
            version: c.version,
            builtinKey: c.builtinKey || null,
            roundingM, key, cached,
            shape: shapeOfCourse(c),
            wps,
        });
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /courses/sim-route — compile a route for a shape that is not
// saved yet (the course editor). Body: {marks, startLine, finishLine,
// roundingM?} in wind-frame metres. Nothing is stored: same compiler as
// the course cache (store/simShape.js), so the editor draws exactly the
// route the simulator will sail. Validation is the course one — a course
// without lines is not a course, and has no route.
// -> {roundingM, key, wps, passes}
// --------------------------------------------------

router.post("/courses/sim-route", async (req, res) => {
    try {
        const { marks, startLine, roundingM } = req.body || {};
        let { finishLine } = req.body || {};
        if (finishLine === "start") finishLine = { sameAs: "start" };
        const err = validateMarks(marks, startLine, finishLine) || validateLines(startLine, finishLine);
        if (err) return res.status(400).json({ error: err });
        const { compileShapeRoute, analyzeRoute, shapeKey, clampRounding } = require("../store/simShape");
        const shape = { marks, startLine, finishLine };
        const R = clampRounding(roundingM);
        const wps = compileShapeRoute(shape, R);
        res.json({ roundingM: R, key: shapeKey(shape, R), wps, passes: analyzeRoute(shape, wps) });
    } catch (e) {
        sendErr(res, e);
    }
});

module.exports = router;
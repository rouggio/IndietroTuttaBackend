const express = require("express");

const {
    getPresetTemplates,
    getPresetTemplate,
    createTemplate,
    listTemplates,
    getTemplate,
    updateTemplate,
    deleteTemplate,
} = require("../store/templateStore");

const router = express.Router();

function sendErr(res, e) {
    return res.status(e.status || 500).json({ error: e.message || "internal error" });
}

// --------------------------------------------------
// GET /templates/presets — the built-in sailing shapes (no DB)
// --------------------------------------------------

router.get("/templates/presets", (req, res) => {
    res.json(getPresetTemplates());
});

// --------------------------------------------------
// GET /templates (all rows are templates)
// --------------------------------------------------

router.get("/templates", async (req, res) => {
    try {
        res.json(await listTemplates());
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// POST /templates — {name, desc?, owner?, marks, startLine?, finishLine?}
// or {name, template: presetKey}
// --------------------------------------------------

router.post("/templates", async (req, res) => {
    try {
        let { name, desc, owner, marks, template, startLine, finishLine } = req.body || {};
        let finalMarks = marks, finalStart = startLine, finalFinish = finishLine;
        if (template) {
            const t = getPresetTemplate(template);
            if (!t) return res.status(400).json({ error: "unknown template" });
            finalMarks = finalMarks || t.marks;
            if (finalStart === undefined) finalStart = t.startLine || null;
            if (finalFinish === undefined) finalFinish = t.finishLine === undefined ? null : t.finishLine;
            if (desc === undefined) desc = t.desc || null;
        }
        const tpl = await createTemplate({ name, desc, owner, marks: finalMarks, startLine: finalStart, finishLine: finalFinish });
        res.status(201).json(tpl);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// GET /templates/:id
// --------------------------------------------------

router.get("/templates/:id", async (req, res) => {
    try {
        const tpl = await getTemplate(req.params.id);
        if (!tpl) return res.status(404).json({ error: "template not found" });
        res.json(tpl);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// PUT /templates/:id — {name?, desc?, marks?, startLine?, finishLine?}
// --------------------------------------------------

router.put("/templates/:id", async (req, res) => {
    try {
        const { name, desc, marks, startLine, finishLine } = req.body || {};
        const tpl = await updateTemplate(req.params.id, { name, desc, marks, startLine, finishLine });
        if (!tpl) return res.status(404).json({ error: "template not found" });
        res.json(tpl);
    } catch (e) {
        sendErr(res, e);
    }
});

// --------------------------------------------------
// DELETE /templates/:id
// --------------------------------------------------

router.delete("/templates/:id", async (req, res) => {
    try {
        const ok = await deleteTemplate(req.params.id);
        if (!ok) return res.status(404).json({ error: "template not found" });
        res.json({ status: "deleted" });
    } catch (e) {
        sendErr(res, e);
    }
});

module.exports = router;

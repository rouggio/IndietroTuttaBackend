const express = require("express");

const {
    getDevices,
    getDevice,
    renameDevice,
    sanitizeUsername,
    sanitizeBoat
} = require("../store/deviceStore");

const router = express.Router();

// --------------------------------------------------
// GET /devices
// --------------------------------------------------

router.get("/devices", async (req, res) => {
    res.json(await getDevices());
});

// --------------------------------------------------
// PUT /devices/:id — rename boat (name and/or make-model), no heartbeat side effects
// --------------------------------------------------

async function handleRename(req, res) {
    const { username, boat } = req.body || {};
    if (username === undefined && boat === undefined) {
        return res.status(400).json({ error: "username and/or boat required" });
    }
    let cleanUsername;
    let cleanBoat;
    if (username !== undefined) {
        cleanUsername = sanitizeUsername(username);
        if (!cleanUsername) return res.status(400).json({ error: "username must match [A-Za-z0-9 ._-]{1,32}" });
    }
    if (boat !== undefined) {
        const trimmed = typeof boat === "string" ? boat.trim() : "";
        if (trimmed) {
            cleanBoat = sanitizeBoat(trimmed);
            if (!cleanBoat) return res.status(400).json({ error: "boat must match [A-Za-z0-9 ._-]{1,64}" });
        } else {
            cleanBoat = null; // clear make/model
        }
    }
    const device = await renameDevice(req.params.id, { username: cleanUsername, boat: cleanBoat });
    if (!device) return res.status(404).json({ error: "Device not found" });
    const full = await getDevice(req.params.id);
    res.json(full || device);
}

router.put("/devices/:id", handleRename);

router.delete("/devices/:id", async (req, res) => {
    const { deleteDevice } = require("../store/deviceStore");
    const ok = await deleteDevice(req.params.id);
    if (!ok) return res.status(404).json({ error: "Device not found" });
    res.json({ status: "deleted" });
});

// Alias: /boats — globally renamed from Devices to Boats (keeps /devices for compat)
router.get("/boats", async (req, res) => {
    res.json(await getDevices());
});

router.put("/boats/:id", handleRename);

router.delete("/boats/:id", async (req, res) => {
    const { deleteDevice } = require("../store/deviceStore");
    const ok = await deleteDevice(req.params.id);
    if (!ok) return res.status(404).json({ error: "Device not found" });
    res.json({ status: "deleted" });
});
module.exports = router;

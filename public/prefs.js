// prefs.js — split from app.js. Persisted UI prefs: saveUI/loadUI/migration.
// Load order is index.html script order; cross-file names resolve at call time.
const UI_KEY = "indietrotutta:ui";
// Wind prefs, edited in the Settings pane. Declared up here because
// loadUI() (called before the wind block) restores them.
let windProvider = "auto";   // auto | wu | wc | om (see GET /wind)
let windRefreshMin = 10;     // minutes between auto refreshes; 0 = off

// 2026-09-10: the Courses pane used to be #template-panel and the builder
// draft carried templateId. Move those saved keys across so an existing
// browser keeps its pane positions, visibility and open builder draft.
const BUILDER_DRAFT_KEY = "indietrotutta:builder";
function migratePrefs(d) {
    if (!d || typeof d !== "object") return d;
    if (d.panels && "template-panel" in d.panels) {
        if (!("course-panel" in d.panels)) d.panels["course-panel"] = d.panels["template-panel"];
        delete d.panels["template-panel"];
    }
    if (d.panelPos && "template-panel" in d.panelPos) {
        if (!("course-panel" in d.panelPos)) d.panelPos["course-panel"] = d.panelPos["template-panel"];
        delete d.panelPos["template-panel"];
    }
    try {
        const raw = localStorage.getItem(BUILDER_DRAFT_KEY);
        if (raw) {
            const draft = JSON.parse(raw);
            if (draft && "templateId" in draft) {
                if (!("courseId" in draft)) draft.courseId = draft.templateId;
                delete draft.templateId;
                localStorage.setItem(BUILDER_DRAFT_KEY, JSON.stringify(draft));
            }
        }
    } catch {}
    return d;
}
function saveUI() {
    try {
        const data = {
            selectedDeviceIds: [...selectedDeviceIds],
            isLive: UI.isLive,
            selectedDate, // compat
            timePreset: UI.timePreset,
            customStart: UI.customStart,
            customEnd: UI.customEnd,
            boatFilter: document.getElementById("boatFilter")?.value || "",
            windProvider,
            windRefreshMin,
            liveMins,
            playbackSpeed: playbackSpeed,
            showSimPreview: !!showSimPreview,
            panels: {
                "device-panel": document.getElementById("device-panel")?.style.display,
                "wind-panel": document.getElementById("wind-panel")?.style.display,
                "playback": document.getElementById("playback")?.style.display,
                "course-panel": document.getElementById("course-panel")?.style.display,
                "session-panel": document.getElementById("session-panel")?.style.display,
                "session-create-panel": document.getElementById("session-create-panel")?.style.display,
                "settings-panel": document.getElementById("settings-panel")?.style.display,
                "clean-panel": document.getElementById("clean-panel")?.style.display,
                "features-panel": document.getElementById("features-panel")?.style.display,
                "session-detail-panel": document.getElementById("session-detail-panel")?.style.display,
            },
            panelPos: ["device-panel", "wind-panel", "course-panel", "session-panel", "session-create-panel", "session-detail-panel", "settings-panel", "clean-panel", "features-panel", "builder-panel"].reduce((acc, id) => {
                const el = document.getElementById(id);
                if (el && el.style.left && el.style.top) acc[id] = { left: el.style.left, top: el.style.top };
                return acc;
            }, {}),
            // Positions chosen by avoidPanelOverlap rather than by hand, so a
            // reload does not promote them to "user-owned" and freeze them.
            panelAuto: [...document.querySelectorAll("[data-auto-placed]")].map(e => e.id),
            viewGpsVisible: undefined, // legacy compat (now per-boat panels)
            openPanels: [...boatPanels.values()].filter(p => p.open).map(p => p.id),
        };
        localStorage.setItem(UI_KEY, JSON.stringify(data));
    } catch {}
}
function loadUI() {
    try {
        const raw = localStorage.getItem(UI_KEY);
        if (!raw) return;
        const d = migratePrefs(JSON.parse(raw));
        if (Array.isArray(d.selectedDeviceIds)) { selectedDeviceIds = new Set(d.selectedDeviceIds); }
        if (typeof d.isLive === "boolean") UI.isLive = d.isLive;
        if (typeof d.showSimPreview === "boolean") showSimPreview = d.showSimPreview;
        if (d.selectedDate) selectedDate = d.selectedDate;
        if (d.timePreset) UI.timePreset = d.timePreset;
        else if (d.selectedDate && d.selectedDate !== todayStr()) UI.timePreset = "custom"; // migrate old date
        if (d.customStart) UI.customStart = d.customStart;
        if (d.customEnd) UI.customEnd = d.customEnd;
        if (d.boatFilter !== undefined) { const el=document.getElementById("boatFilter"); if(el) el.value=d.boatFilter; }
        if (d.windProvider) windProvider = d.windProvider;
        if (typeof d.windRefreshMin === "number") windRefreshMin = d.windRefreshMin;
        if ([-1, 0, 2, 5, 15, 60].includes(Number(d.liveMins))) liveMins = Number(d.liveMins);
        if ([1,2,5,10,20].includes(Number(d.playbackSpeed))) { playbackSpeed=Number(d.playbackSpeed); const ps=document.getElementById("playSpeed"); if(ps) ps.value=String(playbackSpeed); }
        if (d.panels) Object.entries(d.panels).forEach(([id, disp]) => {
            const el=document.getElementById(id); if(el && disp) el.style.display=disp;
        });
        if (d.panelPos) {
            // Which restored positions were ours rather than the user's.
            // Without this, auto-placed panes look identical to hand-placed
            // ones and the overlap cascade skips all of them — it was
            // effectively inert on every reload after the first.
            const autoPlaced = new Set(Array.isArray(d.panelAuto) ? d.panelAuto : []);
            Object.entries(d.panelPos).forEach(([id, pos]) => {
                const el = document.getElementById(id);
                if (el && pos && isFinite(parseFloat(pos.left)) && isFinite(parseFloat(pos.top))) {
                    el.style.left = Math.max(0, Math.min(parseFloat(pos.left), window.innerWidth - 60)) + "px";
                    el.style.top = Math.max(0, parseFloat(pos.top)) + "px";
                    el.style.right = "auto"; // restored left wins over CSS right dock
                    // The clamp above only guards the LEFT/TOP origin, so a
                    // position saved on a big monitor still restored mostly
                    // off-screen on a laptop (right edge and bottom never
                    // clamped). Settle the whole pane inside the viewport.
                    // Ownership is unaffected: this only corrects reachability.
                    clampPanelIntoView(el);
                    if (autoPlaced.has(id)) {
                        // Ours: keep it eligible for the next cascade pass.
                        el.dataset.autoPlaced = "1";
                    } else {
                        el.dataset.moved = "1"; // user-owned, never auto-moved
                    }
                }
            });
        }
        // The new-session pane is ephemeral: never reopen it on refresh,
        // regardless of the saved UI state.
        const scp = document.getElementById("session-create-panel");
        if (scp) scp.style.display = "none";
        // restore boats button active state
        const dp=document.getElementById("device-panel"), bb=document.getElementById("boatsToggleBtn");
        if(dp && bb) bb.classList.toggle("active", dp.style.display!=="none" && dp.style.display!=="");
        // open boat panels persisted from previous session (applied after first data load)
        if (Array.isArray(d.openPanels)) panelsToRestore = new Set(d.openPanels);
    } catch {}
}

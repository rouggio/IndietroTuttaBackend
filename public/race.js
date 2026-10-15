// race.js — split from app.js. Courses, builder, sessions, sim overlay, event stream.
// Load order is index.html script order; cross-file names resolve at call time.
// --- Courses, builder & sessions (Step 2) ---
function escHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Route threading: the sailed route passes THROUGH each gate once — a pair
// collapses to its midpoint, never buoy-to-buoy (that spike is what made
// gate courses draw incoherently). items: [{lat,lon,type,gate,src}] →
// [{pt:[lat,lon], src}]. Orphan gates fall through as singles.
function routeThread(items) {
    const seen = new Set();
    const out = [];
    items.forEach(it => {
        if (it.type === "gate" && it.gate) {
            if (seen.has(it.gate)) return;
            seen.add(it.gate);
            const pair = items.filter(q => q.type === "gate" && q.gate === it.gate);
            if (pair.length === 2) {
                out.push({ pt: [(pair[0].lat + pair[1].lat) / 2, (pair[0].lon + pair[1].lon) / 2], src: it.src });
                return;
            }
        }
        out.push({ pt: [it.lat, it.lon], src: it.src });
    });
    return out;
}
// Rounding-direction arrow inside a mark's circle (P = counter-clockwise,
// S = clockwise; gates/unsided marks get none). Geographic arc at 0.55r so
// it stays "within the range" at every zoom. Returns {arc, head} latlngs.
function roundingArc(lat, lon, rM, side) {
    if (side !== "P" && side !== "S") return null;
    const R = Math.max(5, rM * 0.55), D = Math.PI / 180;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const at = b => [lat + (R * Math.cos(b * D)) / 111320, lon + (R * Math.sin(b * D)) / (111320 * cosLat)];
    const step = (distM, brg) => [lat + (distM * Math.cos(brg * D)) / 111320, lon + (distM * Math.sin(brg * D)) / (111320 * cosLat)];
    const arc = [];
    for (let k = 0; k <= 12; k++) arc.push(at(side === "S" ? k * 15 : -k * 15));
    // arrowhead at the arc end, pointing along travel. Half-circle arcs end
    // at the bottom: clockwise/S heads west, counter-clockwise/P heads east.
    const end = at(180);
    const mB = side === "S" ? 270 : 90; // motion compass bearing at the end
    const h = R * 0.5;
    const tip = [end[0] + (h * Math.cos(mB * D)) / 111320, end[1] + (h * Math.sin(mB * D)) / (111320 * cosLat)];
    const bc = [end[0] - (h * 0.4 * Math.cos(mB * D)) / 111320, end[1] - (h * 0.4 * Math.sin(mB * D)) / (111320 * cosLat)];
    const pB = (mB + 90) % 360, w = h * 0.4;
    const w1 = [bc[0] + (w * Math.cos(pB * D)) / 111320, bc[1] + (w * Math.sin(pB * D)) / (111320 * cosLat)];
    const w2 = [bc[0] - (w * Math.cos(pB * D)) / 111320, bc[1] - (w * Math.sin(pB * D)) / (111320 * cosLat)];
    return { arc, head: [tip, w1, w2] };
}
// Arrow sides per mark: oriented marks show their side. Gates show none —
// a gate is a through-passage with side choice, not a rounding; the route
// threading between the buoys says it all.
function arrowSides(m, i, all) {
    if (m.side === "P" || m.side === "S") return [m.side];
    return [];
}
// JS mirror of the backend wind-frame resolve (rotate + translate).
function resolveMarksJS(offsetMarks, o) {
    const t = (o.windDir * Math.PI) / 180;
    const cosLat = Math.cos((o.originLat * Math.PI) / 180);
    const scale = o.scale || 1;
    return offsetMarks.map(m => {
        const x = m.x * scale, y = m.y * scale;
        const E = x * Math.cos(t) + y * Math.sin(t);
        const N = -x * Math.sin(t) + y * Math.cos(t);
        return { ...m, lat: o.originLat + N / 111320, lon: o.originLon + E / (111320 * cosLat) };
    });
}
// Inverse: absolute lat/lon → wind-frame offsets (builder placement).
function offsetsFromLatLon(lat, lon, o) {
    const t = (o.windDir * Math.PI) / 180;
    const cosLat = Math.cos((o.originLat * Math.PI) / 180);
    const E = (lon - o.originLon) * 111320 * cosLat;
    const N = (lat - o.originLat) * 111320;
    const scale = o.scale || 1;
    return { x: (E * Math.cos(t) - N * Math.sin(t)) / scale, y: (E * Math.sin(t) + N * Math.cos(t)) / scale };
}

// (flat top bar: Boats · Timeline · Sessions · Courses · New session —
// the old Races ▾ parent menu is gone; each button syncs itself)
const coursesBtn = document.getElementById("coursesToggleBtn");
const coursePanel = document.getElementById("course-panel");
if (coursesBtn && coursePanel) {
    const syncCoursesBtn = () => {
        const open = coursePanel.style.display !== "none" && coursePanel.style.display !== "";
        coursesBtn.classList.toggle("active", open);
    };
    coursesBtn.addEventListener("click", () => { toggleEl("course-panel"); avoidPanelOverlap(coursePanel); syncCoursesBtn(); saveUI(); loadCourses(); if (!panelVisible(coursePanel)) closeBuilder(); });
    new MutationObserver(syncCoursesBtn).observe(coursePanel, { attributes: true, attributeFilter: ["style"] });
    syncCoursesBtn();
    document.getElementById("courseClose")?.addEventListener("click", () => { toggleEl("course-panel", false); syncCoursesBtn(); saveUI(); closeBuilder(); });
}
const sessionsBtn = document.getElementById("sessionsToggleBtn");
const sessionPanel = document.getElementById("session-panel");
if (sessionsBtn && sessionPanel) {
    // New session: opens the creation pane directly (the list
    // lives under the top-bar Sessions entry).
    const syncSessionsBtn = () => {
        const cp = document.getElementById("session-create-panel");
        const open = cp && cp.style.display !== "none" && cp.style.display !== "";
        sessionsBtn.classList.toggle("active", open);
    };
    // Real toggle: a second click closes the pane (it used to re-open and
    // re-render, so the button felt dead).
    sessionsBtn.addEventListener("click", () => {
        if (panelVisible(document.getElementById("session-create-panel"))) closeSessionCreate();
        else openSessionCreate();
    });
    new MutationObserver(syncSessionsBtn).observe(document.getElementById("session-create-panel"), { attributes: true, attributeFilter: ["style"] });
    syncSessionsBtn();
    document.getElementById("sessionClose")?.addEventListener("click", () => {
        sessionPanel.style.display = "none";
        closeSessStream();
        endSessMove();
        clearSessPreview();
        syncSessionsBtn();
        saveUI();
    });
}
// Top-bar Sessions entry: opens the list.
const sessionsTopBtn = document.getElementById("sessionsTopBtn");
if (sessionsTopBtn && sessionPanel) {
    const syncTopBtn = () => {
        const open = sessionPanel.style.display !== "none" && sessionPanel.style.display !== "";
        sessionsTopBtn.classList.toggle("active", open);
    };
    sessionsTopBtn.addEventListener("click", () => { toggleEl("session-panel"); avoidPanelOverlap(sessionPanel); syncTopBtn(); saveUI(); if (panelVisible(sessionPanel)) { openSessStream(); loadSessions(); } else { closeSessStream(); endSessMove(); clearSessPreview(); } });
    new MutationObserver(syncTopBtn).observe(sessionPanel, { attributes: true, attributeFilter: ["style"] });
    // The stream follows visibility, not the open call: loadUI() restores
    // panels directly, bypassing openSessionsPanel entirely.
    new MutationObserver(() => { syncEventStream(); }).observe(sessionPanel, { attributes: true, attributeFilter: ["style"] });
    syncTopBtn();
}
// New-session pane (creation form split out of the list panel).
const sessionCreatePanel = document.getElementById("session-create-panel");
function openSessionCreate() {
    // New session starts from the LIVE feed (like live mode): the old
    // session's frozen tracks drop off and the involved boats show live
    // from the get go. unselectSession() restores full live + redraws.
    unselectSession();
    // The form checks every known boat by default: tick them on the map
    // too, so the live feed covers the whole involved fleet.
    if (lastDevices.length) {
        lastDevices.forEach(d => { if (d && d.deviceId) selectedDeviceIds.add(d.deviceId); });
    }
    // Fresh draft on every open: drop the previous placement so the course
    // lands at the center of the CURRENT map (pickSessCourse anchors a null
    // origin there), not where the last draft was left.
    SESSDRAFT.origin = null;
    // The Course pane stays open — it holds the course library you pick the
    // day's course from. Only the builder stands down: its live map layers
    // would fight the session draft preview.
    if (typeof closeBuilder === "function") closeBuilder();
    if (sessionCreatePanel && !panelVisible(sessionCreatePanel)) toggleEl("session-create-panel");
    if (sessionCreatePanel) avoidPanelOverlap(sessionCreatePanel);
    saveUI();
    renderSessionCreate();
    // Fetch the whole fleet now (unselectSession redrew with the stale
    // selection); no recenter — the draft is placed from this viewport.
    try { refresh(); } catch {}
}
function closeSessionCreate() {
    if (!sessionCreatePanel) return;
    sessionCreatePanel.style.display = "none";
    endSessMove();
    clearSessPreview();
    saveUI();
}
if (sessionCreatePanel) {
    document.getElementById("sessionCreateClose")?.addEventListener("click", closeSessionCreate);
}

let coursesCache = null;
// One list from GET /courses: the five built-ins first (builtinKey set,
// copy-only), then the user's own. The server already sorts that way.
function courseSummary(c) {
    const gates = new Set((c.marks || []).filter(m => m.type === "gate" && m.gate).map(m => m.gate)).size;
    const lineLen = c.startLine ? Math.round(Math.hypot(c.startLine.bx - c.startLine.ax, c.startLine.by - c.startLine.ay)) + "m line" : "no lines";
    return `${c.marks.length} marks · ${lineLen}${gates ? ` · ${gates} gate${gates > 1 ? "s" : ""}` : ""}`;
}
async function loadCourses() {
    const el = document.getElementById("tab-courses");
    try {
        const res = await fetch("/courses");
        coursesCache = await res.json();
        const builtins = coursesCache.filter(c => c.builtinKey);
        const mine = coursesCache.filter(c => !c.builtinKey);
        el.innerHTML = `<div class="device-meta" style="margin-bottom:6px">Placed + rotated on the day.</div>
        <div class="device-meta" style="margin:0 0 4px 0"><b>Built-in courses</b></div>
        <div class="course-grid">` + builtins.map(c => `
            <div class="course-card" data-copy-course="${c.id}" title="Built-in: click to save a copy">
                <b>${escHtml(c.name)}</b>
                <span class="device-meta">${c.desc ? escHtml(c.desc) : escHtml(courseSummary(c))}</span>
            </div>`).join("") + `
            <div class="course-card" data-blank-course>
                <b>Blank</b>
                <span class="device-meta">Start from scratch</span>
            </div></div>` + (mine.length ? `
            <div class="device-meta" style="margin:8px 0 4px 0"><b>My courses</b></div>
            <div class="course-grid">` + mine.map(c => `
            <div class="course-card" data-open-course="${c.id}">
                <b>${escHtml(c.name)}</b>
                <span class="device-meta">${c.desc ? escHtml(c.desc) : escHtml(courseSummary(c))} · v${c.version}</span>
                <button data-del-course="${c.id}" title="Delete course" style="float:right;border:1px solid #d1d5db;background:white;border-radius:4px;cursor:pointer;font-size:11px">×</button>
            </div>`).join("") + `</div>` : "");
        // Built-ins are read-only server-side too (403 on PUT/DELETE): the only
        // action here is "save a copy", which opens the builder with no id so
        // saving POSTs a brand new course.
        el.querySelectorAll("[data-copy-course]").forEach(card => {
            card.addEventListener("click", async () => {
                const c = coursesCache.find(x => String(x.id) === card.getAttribute("data-copy-course"));
                if (c) openBuilder({ name: `${c.name} (copy)`, desc: c.desc, marks: c.marks.map(m => ({ ...m })), startLine: c.startLine ? { ...c.startLine } : null, finishLine: c.finishLine ? { ...c.finishLine } : null });
            });
        });
        el.querySelectorAll("[data-blank-course]").forEach(card => {
            card.addEventListener("click", () => openBuilder({ name: "", marks: [] }));
        });
        el.querySelectorAll("[data-open-course]").forEach(card => {
            card.addEventListener("click", async e => {
                if (e.target.closest("[data-del-course]")) return;
                const res2 = await fetch(`/courses/${card.getAttribute("data-open-course")}`);
                const c = await res2.json();
                if (c && c.marks) openBuilder({ courseId: c.id, name: c.name, desc: c.desc, marks: c.marks.map(m => ({ ...m })), startLine: c.startLine, finishLine: c.finishLine });
            });
        });
        el.querySelectorAll("[data-del-course]").forEach(btn => {
            btn.addEventListener("click", async e => {
                e.stopPropagation();
                if (!confirm("Delete this course? Sessions already frozen keep their copy.")) return;
                await fetch(`/courses/${btn.getAttribute("data-del-course")}`, { method: "DELETE" });
                coursesCache = null;
                loadCourses();
            });
        });
        if (typeof avoidPanelOverlap === "function") avoidPanelOverlap(document.getElementById("course-panel"));
    } catch (e) {
        el.innerHTML = '<div class="boat-info-err">Failed to load courses.</div>';
    }
}

// --- Builder state + preview layers ---
const CB = {
    open: false, courseId: null, name: "", desc: "", marks: [],
    origin: null, windDir: 315, scale: 1, placing: null, // 'marks' | 'move' | 'lineA' | 'lineB' | null
    startLine: null, finishLine: null, // wind-frame {ax,ay,bx,by}; finish may be "start"
    lineA: null, lineTarget: "start", // pending first endpoint (absolute) + which line
    showLabels: true,
};
// Oriented label span: text rotated along the on-screen line, line color.
// a,b are [lat,lng]; north-up map, CSS rotate is clockwise.
function legAngle(a, b) {
    const dE = (b[1] - a[1]) * Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
    const dN = b[0] - a[0];
    let ang = (Math.atan2(-dN, dE) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    return ang;
}
function legSpan(a, b, text, color) {
    const ang = legAngle(a, b);
    return `<span style="display:inline-block;transform:rotate(${ang.toFixed(1)}deg);color:${color};font-weight:bold">${text}</span>`;
}
// Label anchor: midpoint pushed a few px to the side so text runs alongside
// the line instead of covering it.
function legLabelPos(a, b, px = 10) {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const p = map.latLngToContainerPoint(mid);
    const r = ((legAngle(a, b) + 90) * Math.PI) / 180;
    return map.containerPointToLatLng([p.x + Math.cos(r) * px, p.y + Math.sin(r) * px]);
}
// JS mirror of the backend segment resolve (incl. square-to-wind + bias).
function resolveSegJS(seg, o) {
    const t = (o.windDir * Math.PI) / 180;
    const cosLat = Math.cos((o.originLat * Math.PI) / 180);
    const scale = o.scale || 1;
    const pt = (x, y) => {
        const E = x * scale * Math.cos(t) + y * scale * Math.sin(t);
        const N = -x * scale * Math.sin(t) + y * scale * Math.cos(t);
        return { lat: o.originLat + N / 111320, lon: o.originLon + E / (111320 * cosLat) };
    };
    // Lines are always square to the wind (90 deg): fixed center + length,
    // bearing follows the wind. Stored square/bias are ignored leftovers.
    const cx = (seg.ax + seg.bx) / 2, cy = (seg.ay + seg.by) / 2;
    const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) * scale;
    const bdeg = ((((o.windDir + 90) % 360) + 360) % 360);
    const brad = (bdeg * Math.PI) / 180;
    const c = pt(cx, cy);
    const half = len / 2;
    const dLa = (half * Math.cos(brad)) / 111320;
    const dLo = (half * Math.sin(brad)) / (111320 * cosLat);
    return { ...seg, latA: c.lat - dLa, lonA: c.lon - dLo, latB: c.lat + dLa, lonB: c.lon + dLo };
}
let coursePreview = null; // L.layerGroup for resolved preview
let PV = null; // live refs into the preview (route/segments/dots), for in-drag updates
// BUILDER_DRAFT_KEY is declared up with UI_KEY (used by the prefs migration).

function builderInst() {
    return { originLat: CB.origin?.lat, originLon: CB.origin?.lon, windDir: CB.windDir, scale: CB.scale };
}
function builderResolved() {
    if (!CB.origin) return [];
    try { return resolveMarksJS(CB.marks, builderInst()); } catch { return []; }
}
const MARK_COLORS = { start: "#16a34a", finish: "#dc2626", gate: "#984ea3", mark: "#f59e0b" };

function openBuilder(init = {}) {
    CB.courseId = init.courseId ?? null;
    CB.name = init.name || "";
    CB.desc = init.desc || "";
    CB.marks = (init.marks || []).map(m => ({ ...m }));
    CB.origin = init.origin || null;
    CB.windDir = 0; // courses assume N wind — no wind UI in the editor
    CB.scale = init.scale || 1;
    CB.placing = null;
    CB.startLine = init.startLine || null;
    // server form {sameAs:"start"} normalizes to the UI shorthand
    CB.finishLine = init.finishLine && init.finishLine.sameAs === "start" ? "start" : (init.finishLine || null);
    CB.lineA = null;
    CB.open = true;
    pileTops = {};
    // courses arrive without placement: default the origin to the map
    // center so the preview renders immediately (user refines it after)
    if (!CB.origin && CB.marks.length) {
        const c = map.getCenter();
        CB.origin = { lat: Math.round(c.lat * 1e5) / 1e5, lon: Math.round(c.lng * 1e5) / 1e5 };
    }
    document.getElementById("builder-panel").style.display = "block";
    document.getElementById("builder-name").value = CB.name;
    document.getElementById("builder-desc").value = CB.desc;
    document.getElementById("builder-scale").value = CB.scale;
    document.getElementById("builder-msg").textContent = "";
    document.getElementById("builderLabels")?.classList.toggle("arming", CB.showLabels);
    document.getElementById("builder-origin-label").textContent = CB.origin
        ? `Origin: ${CB.origin.lat.toFixed(5)}, ${CB.origin.lon.toFixed(5)}`
        : "Origin: not set (added automatically)";
    updateLineInfo();
    renderBuilderMarks();
    updateBuilderPreview();
    saveBuilderDraft();
}
function closeBuilder() {
    CB.open = false;
    CB.placing = null;
    if (courseMove) { courseMove = null; if (map.dragging) map.dragging.enable(); }
    document.getElementById("builder-panel").style.display = "none";
    if (coursePreview) { map.removeLayer(coursePreview); coursePreview = null; }
    syncBuilderArmButtons();
}
document.getElementById("builderClose")?.addEventListener("click", closeBuilder);
document.getElementById("builder-name")?.addEventListener("input", e => { CB.name = e.target.value; saveBuilderDraft(); });
document.getElementById("builder-desc")?.addEventListener("input", e => { CB.desc = e.target.value; saveBuilderDraft(); });
document.getElementById("builder-scale")?.addEventListener("change", e => {
    // Scale is an editor operation, not course state: bake the factor
    // into the model (marks + line endpoints) and reset to 1. Radii stay
    // absolute meters. Sessions keep their own placement-time scale.
    const f = Math.min(5, Math.max(0.1, Number(e.target.value) || 1));
    e.target.value = 1;
    CB.scale = 1;
    if (f === 1) return;
    CB.marks.forEach(m => { m.x *= f; m.y *= f; });
    for (const role of ["startLine", "finishLine"]) {
        const seg = CB[role];
        if (seg && typeof seg === "object" && !seg.sameAs) {
            seg.ax *= f; seg.ay *= f; seg.bx *= f; seg.by *= f;
        }
    }
    renderBuilderMarks();
    updateBuilderPreview(); saveBuilderDraft();
});
function syncBuilderArmButtons() {
    document.getElementById("builderAddMarks")?.classList.toggle("arming", CB.placing === "marks");
    document.getElementById("builderMoveCourse")?.classList.toggle("arming", CB.placing === "move");
    updateLineInfo();
}
// Move-course drag: armed via the button, then press-drag anywhere on the
// map shifts the origin (marks/lines keep their relative geometry).
let courseMove = null;
function endCourseMove() {
    courseMove = null;
    CB.placing = null;
    CB.suppressClick = true; // swallow the click released after the drag
    if (map.dragging) map.dragging.enable();
    syncBuilderArmButtons();
    saveBuilderDraft();
}
if (typeof map !== "undefined" && map.getContainer) {
    const box = map.getContainer();
    box.addEventListener("pointerdown", e => {
        if (!CB.open || CB.placing !== "move" || !CB.origin) return;
        if (e.target.closest(".leaflet-marker-icon, .leaflet-tooltip, .leaflet-control, button, input, select, a")) return;
        e.stopPropagation();
        e.preventDefault();
        if (map.dragging) map.dragging.disable();
        const p = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
        courseMove = { lastLat: p.lat, lastLon: p.lng };
        try { box.setPointerCapture(e.pointerId); } catch {}
    });
    box.addEventListener("pointermove", e => {
        if (!courseMove || !coursePreview) return;
        const p = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
        const dy = p.lat - courseMove.lastLat, dx = p.lng - courseMove.lastLon;
        if (!dy && !dx) return;
        courseMove.lastLat = p.lat; courseMove.lastLon = p.lng;
        CB.origin = { lat: CB.origin.lat + dy, lon: CB.origin.lon + dx };
        // shift every preview layer in place — no rebuild, labels don't bump.
        // (getLatLngs returns LatLng objects, not arrays — handle both)
        const shiftLL = x => {
            if (Array.isArray(x)) {
                if (x.length === 2 && typeof x[0] === "number") return [x[0] + dy, x[1] + dx];
                return x.map(shiftLL);
            }
            if (x && typeof x.lat === "number") return [x.lat + dy, x.lng + dx];
            return x;
        };
        coursePreview.eachLayer(l => {
            if (l.setLatLngs && l.getLatLngs) { try { l.setLatLngs(shiftLL(l.getLatLngs())); } catch {} }
            else if (l.setLatLng && l.getLatLng) { const q = l.getLatLng(); l.setLatLng([q.lat + dy, q.lng + dx]); }
        });
        document.getElementById("builder-origin-label").textContent =
            `Origin: ${CB.origin.lat.toFixed(5)}, ${CB.origin.lon.toFixed(5)}`;
    });
    const upMove = () => { if (courseMove) endCourseMove(); };
    box.addEventListener("pointerup", upMove);
    box.addEventListener("pointercancel", upMove);
}
document.getElementById("builderAddMarks")?.addEventListener("click", () => {
    CB.placing = CB.placing === "marks" ? null : "marks";
    syncBuilderArmButtons();
});
document.getElementById("builderLabels")?.addEventListener("click", () => {
    CB.showLabels = !CB.showLabels;
    document.getElementById("builderLabels")?.classList.toggle("arming", CB.showLabels);
    updateBuilderPreview(); saveBuilderDraft();
});
document.getElementById("builderMoveCourse")?.addEventListener("click", () => {
    if (CB.placing === "move") { endCourseMove(); return; }
    if (!CB.origin) {
        const c = map.getCenter();
        CB.origin = { lat: Math.round(c.lat * 1e5) / 1e5, lon: Math.round(c.lng * 1e5) / 1e5 };
        document.getElementById("builder-origin-label").textContent =
            `Origin: ${CB.origin.lat.toFixed(5)}, ${CB.origin.lon.toFixed(5)}`;
        updateBuilderPreview();
    }
    CB.placing = "move";
    syncBuilderArmButtons();
});
// Start/finish line rows: rendered as the first/last entries of the course
// sequence (WS order: start line → marks/gates → finish line), not a side
// section. renderLinesBox refreshes both ends around the marks list.
function renderLinesBox() {
    renderLineRow("start", document.getElementById("seq-start"));
    renderLineRow("finish", document.getElementById("seq-finish"));
}
function renderLineRow(role, el) {
    if (!el) return;
    const segLen = seg => Math.round(Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) * (CB.scale || 1));
    const isSame = role === "finish" && CB.finishLine === "start";
    const seg = role === "start" ? CB.startLine : (isSame ? null : CB.finishLine);
    el.innerHTML = `
        <div class="mark-row" data-line="${role}">
            <div class="mark-head">
                <b>${role === "start" ? "Start line" : "Finish line"}</b>
                <span class="device-meta">${isSame ? "same as start" : seg ? `${segLen(seg)}m · ≤ wind` : "radius circle"}</span>
            </div>
            <div class="mark-head" style="margin-top:4px">
                <button class="mini" data-lact="define">Define</button>
                ${role === "finish" && !isSame ? `<button class="mini" data-lact="same">Same as start</button>` : ""}
                ${(seg || isSame) ? `<button class="mini" data-lact="clear">Clear</button>` : ""}
            </div>
        </div>`;
    el.querySelectorAll("[data-line]").forEach(box => {
        const set = seg => { if (role === "start") CB.startLine = seg; else CB.finishLine = seg; };
        box.querySelectorAll("[data-lact]").forEach(btn => btn.addEventListener("click", () => {
            const act = btn.getAttribute("data-lact");
            if (act === "define") {
                CB.lineTarget = role; CB.lineA = null;
                CB.placing = "lineA";
            } else if (act === "same") {
                if (!CB.startLine) { document.getElementById("builder-msg").textContent = "Set the start line first."; return; }
                CB.finishLine = "start";
            } else if (act === "clear") {
                set(null);
                CB.lineA = null;
                if (CB.placing === "lineA" || CB.placing === "lineB") CB.placing = null;
            }
            afterLineEdit();
        }));
        box.querySelectorAll('[data-lact="define"]').forEach(btn => {
            btn.classList.toggle("arming", (CB.placing === "lineA" || CB.placing === "lineB") && CB.lineTarget === role);
        });
    });
}
function afterLineEdit() {
    document.getElementById("builder-msg").textContent = "";
    syncBuilderArmButtons();
    renderLinesBox();
    updateBuilderPreview();
    saveBuilderDraft();
}
function updateLineInfo() {
    renderLinesBox();
}
// Consumed by the map click handler (registered earlier): true = handled.
function builderMapClick(e) {
    if (CB.suppressClick) { CB.suppressClick = false; return true; }
    if (!CB.open || !CB.placing) return false;
    if (CB.placing === "lineA" || CB.placing === "lineB") {
        const msg = document.getElementById("builder-msg");
        if (CB.placing === "lineA") {
            if (!CB.origin) {
                CB.origin = { lat: e.latlng.lat, lon: e.latlng.lng };
                document.getElementById("builder-origin-label").textContent =
                    `Origin: ${CB.origin.lat.toFixed(5)}, ${CB.origin.lon.toFixed(5)} (from line start)`;
            }
            CB.lineA = { lat: e.latlng.lat, lon: e.latlng.lng };
            CB.placing = "lineB";
            msg.textContent = "";
            updateBuilderPreview();
        } else {
            const a = offsetsFromLatLon(CB.lineA.lat, CB.lineA.lon, builderInst());
            const b = offsetsFromLatLon(e.latlng.lat, e.latlng.lng, builderInst());
            const seg = {
                ax: Math.round(a.x * 10) / 10, ay: Math.round(a.y * 10) / 10,
                bx: Math.round(b.x * 10) / 10, by: Math.round(b.y * 10) / 10,
            };
            const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay);
            if (len < 5) { msg.textContent = "Line too short (min 5m) — click two farther points."; return true; }
            if (CB.lineTarget === "start") CB.startLine = seg;
            else CB.finishLine = seg;
            CB.lineA = null;
            CB.placing = null;
            msg.textContent = "";
            updateLineInfo(); updateBuilderPreview(); saveBuilderDraft();
        }
        syncBuilderArmButtons();
        return true;
    }
    if (CB.placing === "marks") {
        if (!CB.origin) {
            CB.origin = { lat: e.latlng.lat, lon: e.latlng.lng };
            document.getElementById("builder-origin-label").textContent =
                `Origin: ${CB.origin.lat.toFixed(5)}, ${CB.origin.lon.toFixed(5)} (from first mark)`;
        }
        const off = offsetsFromLatLon(e.latlng.lat, e.latlng.lng, builderInst());
        CB.marks.push({
            x: Math.round(off.x * 10) / 10, y: Math.round(off.y * 10) / 10,
            r: 30, side: "P", type: "mark",
        });
        renderBuilderMarks();
        updateBuilderPreview(); saveBuilderDraft();
        // stay armed for the next mark
    }
    syncBuilderArmButtons();
    return true;
}

// Gate buoys only ever come in pairs — an orphaned single demotes to mark.
function normalizeGates() {
    const groups = {};
    CB.marks.forEach((m, i) => { if (m.type === "gate" && m.gate) { (groups[m.gate] = groups[m.gate] || []).push(i); } });
    Object.values(groups).forEach(g => {
        if (g.length === 1) {
            const m = CB.marks[g[0]];
            m.type = "mark";
            delete m.gate;
        }
    });
}
function renderBuilderMarks() {
    const el = document.getElementById("builder-marks");
    const gateCounts = {};
    CB.marks.forEach(m => { if (m.type === "gate" && m.gate) gateCounts[m.gate] = (gateCounts[m.gate] || 0) + 1; });
    if (!CB.marks.length) {
            el.innerHTML = '<div class="device-meta">No marks — click "+ Add marks" then click the map.</div>';
        return;
    }
    el.innerHTML = CB.marks.map((m, i) => {
        // Ends are lines now: only mark/gate are offered (legacy start/finish
        // points still render for old courses, just can't be re-picked).
        const typeOpts = ["mark", "gate"];
        if (!typeOpts.includes(m.type)) typeOpts.unshift(m.type);
        return `
        <div class="mark-row" data-mark="${i}">
            <div class="mark-head">
                <b>#${i + 1}</b>
                <select data-f="type" title="Mark type">
                    ${typeOpts.map(t => `<option ${m.type === t ? "selected" : ""}>${t}</option>`).join("")}
                </select>
                <select data-f="side" title="Required side" ${m.type !== "mark" ? 'style="display:none"' : ""}>
                    ${["P", "S", "G"].map(s => `<option ${m.side === s ? "selected" : ""}>${s}</option>`).join("")}
                </select>
                <input data-f="r" type="number" min="5" max="200" value="${m.r}" title="Radius (m)">
                <button class="mini" data-up title="Move earlier">↑</button>
                <button class="mini" data-down title="Move later">↓</button>
                <button class="mini" data-del title="Delete mark">×</button>
            </div>
            <div class="device-meta">${Math.round(m.x)}m E, ${Math.round(m.y)}m N (wind frame)${m.sourceUid ? ` · from ${escHtml(m.sourceUid)}` : ""}${m.gate ? ` · gate ${escHtml(m.gate)}${gateCounts[m.gate] === 2 ? "" : " (needs partner)"}` : ""}</div>
        </div>`;
    }).join("");
    el.querySelectorAll("[data-mark]").forEach(row => {
        const i = Number(row.getAttribute("data-mark"));
        row.querySelector("[data-f=type]").addEventListener("change", e => {
            const m = CB.marks[i];
            m.type = e.target.value;
            if (m.type === "gate") {
                // join an open single-buoy group, else start a new pair
                const counts = {};
                CB.marks.forEach((x, xi) => { if (xi !== i && x.type === "gate" && x.gate) counts[x.gate] = (counts[x.gate] || 0) + 1; });
                const open = Object.keys(counts).find(g => counts[g] === 1);
                if (open) {
                    m.gate = open;
                    if (!m.side || m.side === "P" || m.side === "S") m.side = "G";
                } else {
                    let n = 1;
                    while (counts["g" + n]) n++;
                    m.gate = "g" + n;
                    m.side = "G";
                }
            } else {
                delete m.gate;
            }
            renderBuilderMarks(); updateBuilderPreview(); saveBuilderDraft();
        });
        row.querySelector("[data-f=side]").addEventListener("change", e => { CB.marks[i].side = e.target.value; updateBuilderPreview(); saveBuilderDraft(); });
        row.querySelector("[data-f=r]").addEventListener("change", e => {
            CB.marks[i].r = Math.min(200, Math.max(5, Number(e.target.value) || 30));
            e.target.value = CB.marks[i].r;
            updateBuilderPreview(); saveBuilderDraft();
        });
        row.querySelector("[data-up]").addEventListener("click", () => {
            if (i > 0) { [CB.marks[i - 1], CB.marks[i]] = [CB.marks[i], CB.marks[i - 1]]; renderBuilderMarks(); updateBuilderPreview(); saveBuilderDraft(); }
        });
        row.querySelector("[data-down]").addEventListener("click", () => {
            if (i < CB.marks.length - 1) { [CB.marks[i + 1], CB.marks[i]] = [CB.marks[i], CB.marks[i + 1]]; renderBuilderMarks(); updateBuilderPreview(); saveBuilderDraft(); }
        });
        row.querySelector("[data-del]").addEventListener("click", () => {
            CB.marks.splice(i, 1);
            normalizeGates();
            renderBuilderMarks(); updateBuilderPreview(); saveBuilderDraft();
        });
    });
}

// Live preview refresh DURING drags: moves polylines/circles/tooltips in
// place. A full rebuild would destroy the marker being dragged, so drag
// handlers call this; dragend commits to CB and rebuilds.
function refreshRouteLive() {
    if (!PV || !coursePreview) return;
    const P = m => { const p = m.getLatLng(); return [p.lat, p.lng]; };
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dist = (a, b, color) => legSpan(a, b, Math.round(map.distance(a, b)) + " m", color || "#3b82f6");
    let startC = null, startLen = "";
    if (PV.startDots.length === 2) {
        const a = P(PV.startDots[0]), b = P(PV.startDots[1]);
        startC = mid(a, b);
        startLen = Math.round(map.distance(a, b)) + " m";
        if (PV.startSeg) PV.startSeg.setLatLngs([a, b]);
        if (PV.startMove) PV.startMove.setLatLng(startC);
        if (PV.startLenTip) PV.startLenTip.setLatLng(legLabelPos(a, b)).setContent(legSpan(a, b, startLen, "#16a34a"));
    }
    PV.marks.forEach((m, i) => { if (PV.circles[i]) PV.circles[i].setLatLng(m.getLatLng()); });
    (PV.arrows || []).forEach(a => {
        const p = PV.marks[a.i] ? PV.marks[a.i].getLatLng() : null;
        const cm = CB.marks[a.i];
        if (!p || !cm) return;
        const arr = roundingArc(p.lat, p.lng, cm.r, a.side);
        if (arr) { a.arc.setLatLngs(arr.arc); a.head.setLatLngs(arr.head); }
        else { a.arc.setLatLngs([]); a.head.setLatLngs([]); }
    });
    let finishC = null;
    if (CB.finishLine === "start" && startC) {
        finishC = startC;
        if (PV.finishSeg && PV.startDots.length === 2) {
            PV.finishSeg.setLatLngs([P(PV.startDots[0]), P(PV.startDots[1])]);
        }
        if (PV.finishLenTip && PV.startDots.length === 2) {
            const a = P(PV.startDots[0]), b = P(PV.startDots[1]);
            PV.finishLenTip.setLatLng(legLabelPos(a, b)).setContent(legSpan(a, b, startLen, "#dc2626"));
        }
    } else if (PV.finishDots.length === 2) {
        const a = P(PV.finishDots[0]), b = P(PV.finishDots[1]);
        finishC = mid(a, b);
        if (PV.finishSeg) PV.finishSeg.setLatLngs([a, b]);
        if (PV.finishMove) PV.finishMove.setLatLng(finishC);
        if (PV.finishLenTip) PV.finishLenTip.setLatLng(legLabelPos(a, b)).setContent(legSpan(a, b, Math.round(map.distance(a, b)) + " m", "#dc2626"));
    }
    const live = PV.marks.map((m, i) => { const p = m.getLatLng(); const cm = CB.marks[i] || {}; return { lat: p.lat, lon: p.lng, type: cm.type, gate: cm.gate, src: i }; });
    const pts = [...(startC ? [startC] : []),
        ...routeThread(live).map(r => r.pt),
        ...(finishC ? [finishC] : [])];
    if (PV.route) PV.route.setLatLngs(pts);
    (PV.legs || []).forEach(leg => {
        if (pts[leg.a] && pts[leg.b]) leg.tip.setLatLng(legLabelPos(pts[leg.a], pts[leg.b])).setContent(dist(pts[leg.a], pts[leg.b], "#3b82f6"));
    });
    (PV.gateSegs || []).forEach(g => {
        if (!PV.marks[g.i] || !PV.marks[g.j]) return;
        const pa = PV.marks[g.i].getLatLng(), pb = PV.marks[g.j].getLatLng();
        const A = [pa.lat, pa.lng], B = [pb.lat, pb.lng];
        g.seg.setLatLngs([A, B]);
        if (g.tip) g.tip.setLatLng(legLabelPos(A, B)).setContent(legSpan(A, B, Math.round(map.distance(A, B)) + " m", "#984ea3"));
    });
}
function updateBuilderPreview() {
    if (!CB.open) return;
    if (coursePreview) { map.removeLayer(coursePreview); coursePreview = null; }
    PV = null;
    if (!CB.origin || (!CB.marks.length && !CB.startLine && !CB.finishLine && !CB.lineA)) return;
    coursePreview = L.layerGroup().addTo(map);
    PV = { marks: [], circles: [], arrows: [], route: null, legs: [], startSeg: null, finishSeg: null, startDots: [], finishDots: [], startMove: null, finishMove: null, startLenTip: null, finishLenTip: null, gateSegs: [] };
    const resolved = builderResolved();
    // route runs line-center → marks → line-center when lines replace points
    const segCenter = seg => {
        const r = resolveSegJS(seg, builderInst());
        return [(r.latA + r.latB) / 2, (r.lonA + r.lonB) / 2];
    };
    const latlngs = [];
    // route point sources (mark index or -1 for line centers) — legs inside
    // one gate pair get no leg label (the gate connector already labels them)
    const routeSrc = [];
    routeThread(resolved.map((m, i) => ({ ...m, src: i }))).forEach(r => {
        latlngs.push(r.pt);
        routeSrc.push(r.src);
    });
    if (CB.startLine) { latlngs.unshift(segCenter(CB.startLine)); routeSrc.unshift(-1); }
    const effFinish = CB.finishLine === "start" ? CB.startLine : CB.finishLine;
    if (effFinish && typeof effFinish === "object") { latlngs.push(segCenter(effFinish)); routeSrc.push(-1); }
    PV.route = L.polyline(latlngs, { color: "#3b82f6", weight: 2, dashArray: "6 4", opacity: 0.9 }).addTo(coursePreview);
    // per-leg distance labels (alongside the leg, live-updated)
    const legMid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const gateOf = mi => (mi >= 0 && CB.marks[mi] && CB.marks[mi].type === "gate" && CB.marks[mi].gate) || null;
    if (CB.showLabels) {
        for (let li = 0; li + 1 < latlngs.length; li++) {
            const gA = gateOf(routeSrc[li]), gB = gateOf(routeSrc[li + 1]);
            if (gA && gA === gB) continue;
            PV.legs.push({
                tip: L.tooltip({ permanent: true, direction: "center", className: "dist-label" })
                    .setLatLng(legLabelPos(latlngs[li], latlngs[li + 1]))
                    .setContent(legSpan(latlngs[li], latlngs[li + 1], Math.round(map.distance(latlngs[li], latlngs[li + 1])) + " m", "#3b82f6"))
                    .addTo(coursePreview),
                a: li, b: li + 1,
            });
        }
    }
    // relaxed stacking: any marks whose radius circles collide belong to one
    // pile (union-find over pairwise circle overlap) — catches exact stacks
    // and near-misses alike
    const parent = resolved.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < resolved.length; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
            const a = resolved[i], b = resolved[j];
            if (map.distance([a.lat, a.lon], [b.lat, b.lon]) < a.r + b.r) parent[find(i)] = find(j);
        }
    }
    const buckets = {};
    resolved.forEach((_, i) => { const k = find(i); (buckets[k] = buckets[k] || []).push(i); });
    const pileOf = i => buckets[find(i)];
    const pileKeyOf = i => pileOf(i).join(",");
    resolved.forEach((m, i) => {
        PV.circles.push(L.circle([m.lat, m.lon], { radius: m.r, color: MARK_COLORS[m.type] || "#f59e0b", weight: 2, fillOpacity: 0.08 }).addTo(coursePreview));
        const col = MARK_COLORS[m.type] || "#f59e0b";
        arrowSides(m, i, resolved).forEach(sd => {
            const arr = roundingArc(m.lat, m.lon, m.r, sd);
            if (!arr) return;
            PV.arrows.push({
                i, side: sd,
                arc: L.polyline(arr.arc, { color: col, weight: 2, opacity: 0.9 }).addTo(coursePreview),
                head: L.polygon(arr.head, { color: col, fillColor: col, fillOpacity: 0.9, weight: 1 }).addTo(coursePreview),
            });
        });
        const pile = pileOf(i);
        const pkey = pileKeyOf(i);
        const topIdx = pile[(pileTops[pkey] || 0) % pile.length];
        const isTop = i === topIdx;
        const marker = L.marker([m.lat, m.lon], {
            draggable: true,
            zIndexOffset: isTop ? 1000 : 0,
            icon: L.divIcon({
                html: `<div class="builder-mark-label" style="background:${MARK_COLORS[m.type] || "#f59e0b"};position:relative">${i + 1}` +
                    (isTop && pile.length > 1 ? `<span class="pile-count">×${pile.length}</span>` : "") + `</div>`,
                className: "", iconSize: [22, 22], iconAnchor: [11, 11],
            }),
        }).addTo(coursePreview);
        // click a pile cycles which mark is on top (course order untouched)
        marker.on("click", () => {
            if (pile.length < 2) return;
            pileTops[pkey] = ((pileTops[pkey] || 0) + 1) % pile.length;
            updateBuilderPreview();
        });
        marker.bindTooltip(`#${i + 1} ${m.type} ${m.side}` + (pile.length > 1 ? ` · pile: ${pile.map(x => x + 1).join(", ")} (click cycles)` : ""));
        PV.marks.push(marker);
        // Magnetic stacking while dragging: snap onto another mark within
        // 12m, hold until dragged 18m away (hysteresis kills jitter), then
        // release back to the cursor. Already-stacked marks stick on grab.
        marker.on("dragstart", () => {
            marker._snapTo = null;
            marker._snapFrom = null;
            const p0 = marker.getLatLng();
            const off0 = offsetsFromLatLon(p0.lat, p0.lng, builderInst());
            CB.marks.forEach((m, mi) => {
                if (mi === i) return;
                if (Math.hypot(m.x - off0.x, m.y - off0.y) < 1) marker._snapFrom = mi;
            });
        });
        marker.on("drag", () => {
            const p = marker.getLatLng();
            const off = offsetsFromLatLon(p.lat, p.lng, builderInst());
            const stick = marker._snapTo != null ? marker._snapTo : marker._snapFrom;
            let target = null;
            if (stick != null) {
                const m = CB.marks[stick];
                if (m && Math.hypot(m.x - off.x, m.y - off.y) < 18) {
                    target = m;
                    marker._snapTo = stick;
                } else {
                    marker._snapTo = null;
                    marker._snapFrom = null;
                }
            }
            if (!target) {
                let bd = 12;
                CB.marks.forEach((m, mi) => {
                    if (mi === i) return;
                    const d = Math.hypot(m.x - off.x, m.y - off.y);
                    if (d < bd) { bd = d; target = m; marker._snapTo = mi; }
                });
                if (!target) marker._snapTo = null;
            }
            if (target) {
                const r = resolveMarksJS([{ x: target.x, y: target.y }], builderInst())[0];
                marker.setLatLng([r.lat, r.lon]);
            }
            refreshRouteLive();
        });
        marker.on("dragend", () => {
            const ll = marker.getLatLng();
            const off = offsetsFromLatLon(ll.lat, ll.lng, builderInst());
            // snap-to-stack: dropped within 12m of another mark → coincide
            // exactly (piles: repeated roundings, shared windward mark).
            let best = null, bd = 12;
            CB.marks.forEach((m, mi) => {
                if (mi === i) return;
                const d = Math.hypot(m.x - off.x, m.y - off.y);
                if (d < bd) { bd = d; best = m; }
            });
            const r1 = v => Math.round(v * 10) / 10;
            CB.marks[i].x = r1(best ? best.x : off.x);
            CB.marks[i].y = r1(best ? best.y : off.y);
            renderBuilderMarks();
            updateBuilderPreview(); saveBuilderDraft();
        });
    });
    // start/finish line segments (green/red); shared finish drawn dashed over start.
    // endpoints are draggable dots — drag adjusts the line on the chart.
    const lineEndDrag = (role, end, marker) => {
        const ll = marker.getLatLng();
        const off = offsetsFromLatLon(ll.lat, ll.lng, builderInst());
        const r1 = v => Math.round(v * 10) / 10;
        const seg = { ...(role === "start" ? CB.startLine : CB.finishLine) };
        if (end === "A") { seg.ax = r1(off.x); seg.ay = r1(off.y); }
        else { seg.bx = r1(off.x); seg.by = r1(off.y); }
        if (Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) < 5) { updateBuilderPreview(); return; } // snap back
        if (role === "start") CB.startLine = seg; else CB.finishLine = seg;
        updateLineInfo(); updateBuilderPreview(); saveBuilderDraft();
    };
    const endDot = (lat, lon, color, role, end, dots) => {
        const mk = L.marker([lat, lon], {
            draggable: true,
            icon: L.divIcon({ html: `<div class="line-end-dot" style="border-color:${color}"></div>`, className: "", iconSize: [12, 12], iconAnchor: [6, 6] }),
        }).addTo(coursePreview);
        mk.bindTooltip(`${role} line end ${end} (drag)`);
        mk.on("drag", refreshRouteLive);
        mk.on("dragend", () => lineEndDrag(role, end, mk));
        dots.push(mk);
        return mk;
    };
    let resStart = null;
    // dragging the square handle moves the whole line (both ends shift)
    const moveLine = (role, seg, marker) => {
        const ll = marker.getLatLng();
        const off = offsetsFromLatLon(ll.lat, ll.lng, builderInst());
        const dx = off.x - (seg.ax + seg.bx) / 2;
        const dy = off.y - (seg.ay + seg.by) / 2;
        const r1 = v => Math.round(v * 10) / 10;
        const moved = { ax: r1(seg.ax + dx), ay: r1(seg.ay + dy), bx: r1(seg.bx + dx), by: r1(seg.by + dy) };
        if ([moved.ax, moved.ay, moved.bx, moved.by].some(v => Math.abs(v) > 5000)) { updateBuilderPreview(); return; } // snap back
        if (role === "start") CB.startLine = moved; else CB.finishLine = moved;
        updateLineInfo(); updateBuilderPreview(); saveBuilderDraft();
    };
    const moveDot = (lat, lon, color, role, seg) => {
        const mk = L.marker([lat, lon], {
            draggable: true,
            icon: L.divIcon({ html: `<div class="line-move-dot" style="border-color:${color}"></div>`, className: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
        }).addTo(coursePreview);
        mk.bindTooltip(`drag to move ${role} line`);
        // live: shift both ends by the handle displacement, then refresh
        mk.on("drag", () => {
            const dots = role === "start" ? PV.startDots : PV.finishDots;
            if (!PV || dots.length !== 2) return;
            const c = mk.getLatLng();
            const a = dots[0].getLatLng(), b = dots[1].getLatLng();
            const dy = c.lat - (a.lat + b.lat) / 2, dx = c.lng - (a.lng + b.lng) / 2;
            dots[0].setLatLng([a.lat + dy, a.lng + dx]);
            dots[1].setLatLng([b.lat + dy, b.lng + dx]);
            refreshRouteLive();
        });
        mk.on("dragend", () => moveLine(role, seg, mk));
        return mk;
    };
    const lenTip = (a, b, text, color) => {
        if (!CB.showLabels) return null;
        return L.tooltip({ permanent: true, direction: "center", className: "dist-label" })
            .setLatLng(legLabelPos(a, b))
            .setContent(legSpan(a, b, text + Math.round(map.distance(a, b)) + " m", color))
            .addTo(coursePreview);
    };
    if (CB.startLine) {
        resStart = resolveSegJS(CB.startLine, builderInst());
        const A = [resStart.latA, resStart.lonA], B = [resStart.latB, resStart.lonB];
        PV.startSeg = L.polyline([A, B], { color: "#16a34a", weight: 5 }).addTo(coursePreview)
            .bindTooltip("start line", { permanent: false });
        PV.startLenTip = lenTip(A, B, "", "#16a34a");
        endDot(resStart.latA, resStart.lonA, "#16a34a", "start", "A", PV.startDots);
        endDot(resStart.latB, resStart.lonB, "#16a34a", "start", "B", PV.startDots);
        PV.startMove = moveDot((resStart.latA + resStart.latB) / 2, (resStart.lonA + resStart.lonB) / 2, "#16a34a", "start", CB.startLine);
    }
    if (CB.finishLine === "start" && resStart) {
        const A = [resStart.latA, resStart.lonA], B = [resStart.latB, resStart.lonB];
        PV.finishSeg = L.polyline([A, B], { color: "#dc2626", weight: 2, dashArray: "6 4" }).addTo(coursePreview)
            .bindTooltip("finish = start line", { permanent: false });
        PV.finishLenTip = lenTip(A, B, "", "#dc2626");
    } else if (CB.finishLine && typeof CB.finishLine === "object") {
        const r = resolveSegJS(CB.finishLine, builderInst());
        const A = [r.latA, r.lonA], B = [r.latB, r.lonB];
        PV.finishSeg = L.polyline([A, B], { color: "#dc2626", weight: 5 }).addTo(coursePreview)
            .bindTooltip("finish line", { permanent: false });
        PV.finishLenTip = lenTip(A, B, "", "#dc2626");
        endDot(r.latA, r.lonA, "#dc2626", "finish", "A", PV.finishDots);
        endDot(r.latB, r.lonB, "#dc2626", "finish", "B", PV.finishDots);
        PV.finishMove = moveDot((r.latA + r.latB) / 2, (r.lonA + r.lonB) / 2, "#dc2626", "finish", CB.finishLine);
    }
    // gate connectors: dashed purple segment between paired buoys + short label
    const gateGroups = {};
    resolved.forEach((m, i) => {
        const src = CB.marks[i];
        if (src && src.type === "gate" && src.gate) { (gateGroups[src.gate] = gateGroups[src.gate] || []).push(i); }
    });
    Object.values(gateGroups).forEach(g => {
        if (g.length !== 2) return;
        const A = [resolved[g[0]].lat, resolved[g[0]].lon], B = [resolved[g[1]].lat, resolved[g[1]].lon];
        const seg = L.polyline([A, B], { color: "#984ea3", weight: 2, dashArray: "6 4" }).addTo(coursePreview);
        const tip = CB.showLabels ? L.tooltip({ permanent: true, direction: "center", className: "dist-label" })
            .setLatLng(legLabelPos(A, B))
            .setContent(legSpan(A, B, Math.round(map.distance(A, B)) + " m", "#984ea3"))
            .addTo(coursePreview) : null;
        PV.gateSegs.push({ seg, tip, i: g[0], j: g[1] });
    });
    // pending first endpoint while defining a line
    if (CB.lineA) {
        L.circleMarker([CB.lineA.lat, CB.lineA.lon], { radius: 6, color: "#0f172a", fillOpacity: 1 }).addTo(coursePreview)
            .bindTooltip(`line ${CB.lineTarget}: click second end`);
    }
    // (wind lives in the bottom-left dial, not on the chart)
}

// --- Save course (shape library only; sessions are born in Sessions) ---
// Save as course (the only shape library — sessions freeze from here).
async function builderSaveCourse() {
    const msg = document.getElementById("builder-msg");
    const name = document.getElementById("builder-name").value.trim() || "Untitled course";
    const desc = document.getElementById("builder-desc").value.trim() || null;
    // UI shorthand "start" → server form {sameAs:"start"}
    const finishOut = CB.finishLine === "start" ? { sameAs: "start" } : CB.finishLine;
    try {
        let res;
        if (CB.courseId) {
            res = await fetch(`/courses/${CB.courseId}`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, desc, marks: CB.marks, startLine: CB.startLine, finishLine: finishOut }),
            });
        } else {
            res = await fetch("/courses", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, desc, marks: CB.marks, startLine: CB.startLine, finishLine: finishOut }),
            });
        }
        const j = await res.json();
        if (!res.ok) { msg.textContent = j.error || "Save failed."; msg.className = "boat-info-err"; return null; }
        CB.courseId = j.id;
        CB.name = j.name;
        CB.desc = j.desc || "";
        document.getElementById("builder-name").value = j.name;
        document.getElementById("builder-desc").value = CB.desc;
        msg.textContent = "Course saved.";
        msg.className = "boat-info-ok";
        return j;
    } catch {
        msg.textContent = "Network error.";
        msg.className = "boat-info-err";
        return null;
    }
}
document.getElementById("builderSave")?.addEventListener("click", async () => {
    const j = await builderSaveCourse();
    if (j && panelVisible(document.getElementById("course-panel"))) loadCourses();
});
function saveBuilderDraft() {
    try {
        localStorage.setItem(BUILDER_DRAFT_KEY, JSON.stringify({
            courseId: CB.courseId, name: document.getElementById("builder-name")?.value || "",
            desc: document.getElementById("builder-desc")?.value || "",
            marks: CB.marks, origin: CB.origin, windDir: CB.windDir, scale: CB.scale,
            startLine: CB.startLine, finishLine: CB.finishLine,
        }));
    } catch {}
}
// Show the sessions panel (used after freezing a session from the builder).
function openSessionsPanel(selectId) {
    const panel = document.getElementById("session-panel");
    if (panel && !panelVisible(panel)) toggleEl("session-panel");
    if (panel) avoidPanelOverlap(panel);
    const sb = document.getElementById("sessionsTopBtn");
    if (sb && panel) sb.classList.toggle("active", panelVisible(panel));
    saveUI();
    openSessStream();
    return loadSessions(selectId);
}

// --- Live event stream (todo 2): one connection, panes subscribe by topic
// (?topics=session,signal,boat,device). Reload-on-event (not patch-level):
// payloads are small and the full fetch is the fallback anyway. Polls pause
// per-topic while subscribed and resume on drop (EventSource reconnects).
let sessEventSrc = null;
let sessTopics = new Set(); // topics of the live connection
function sessToast(msg) {
    const t = document.getElementById("sess-toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(sessToast._t);
    sessToast._t = setTimeout(() => { t.style.display = "none"; }, 6000);
}
function sessWantTopics() {
    // Baseline is always signal+device (rare, cheap); panes add their own.
    // Resubscribing reconnects the single connection — never a second one.
    const t = new Set(["signal", "device"]);
    if (panelVisible(document.getElementById("session-panel"))) t.add("session");
    if (panelVisible(document.getElementById("device-panel"))) t.add("boat");
    return t;
}
function sessSubbed(topic) {
    return !!(sessEventSrc && sessEventSrc.readyState === 1 && sessTopics.has(topic));
}
function closeSessStream() {
    if (sessEventSrc) {
        try { sessEventSrc.close(); } catch {}
        sessEventSrc = null;
    }
    sessTopics = new Set();
}
function syncEventStream() {
    const want = sessWantTopics();
    const same = sessEventSrc && want.size === sessTopics.size && [...want].every(x => sessTopics.has(x));
    if (same && sessEventSrc.readyState !== 2) return; // 2 = CLOSED; connecting/open stays
    closeSessStream();
    if (typeof EventSource === "undefined") return;
    sessTopics = want;
    const src = new EventSource("/events?topics=" + [...want].join(","));
    sessEventSrc = src;
    const reloadList = () => {
        if (panelVisible(document.getElementById("session-panel"))) loadSessions();
    };
    src.addEventListener("session.created", reloadList);
    src.addEventListener("session.updated", reloadList);
    src.addEventListener("session.deleted", reloadList);
    src.addEventListener("session.boats", reloadList);
    src.addEventListener("session.runs", () => {
        if (panelVisible(document.getElementById("session-detail-panel"))) loadSessions(UI.selectedSessionId);
    });
    src.addEventListener("session.status", e => {
        try {
            const d = JSON.parse(e.data || "{}");
            if (d.id) loadSessions(d.id === UI.selectedSessionId ? d.id : undefined);
            else reloadList();
        } catch { reloadList(); }
    });
    src.addEventListener("signal.raised", e => {
        try {
            const d = JSON.parse(e.data || "{}");
            if (panelVisible(document.getElementById("session-detail-panel"))) loadSessions(UI.selectedSessionId);
            else reloadList();
            if (d.kind === "ABANDON") sessToast(`ABANDON — session ${d.sessionId}`);
            else if (d.kind === "RECALL") sessToast(`RECALL — session ${d.sessionId}`);
        } catch {}
    });
    src.addEventListener("boat.mock", e => {
        try {
            const d = JSON.parse(e.data || "{}");
            if (d.deviceId && !patchBoat(d.deviceId, { mock: !!d.mock })) refreshDevices();
        } catch {}
    });
    src.addEventListener("boat.created", () => { try { refreshDevices(); } catch {} }); // full row needed
    src.addEventListener("boat.deleted", e => {
        try {
            const d = JSON.parse(e.data || "{}");
            if (d.deviceId) {
                lastDevices = lastDevices.filter(x => x.deviceId !== d.deviceId);
                selectedDeviceIds.delete(d.deviceId);
                renderDevices();
            }
        } catch {}
    });
    src.addEventListener("device.status", e => {
        try {
            const d = JSON.parse(e.data || "{}");
            if (!d.deviceId) { refreshDevices(); return; }
            const patch = { status: d.status };
            if (d.lastSeen) patch.lastSeen = d.lastSeen;
            if (!patchBoat(d.deviceId, patch)) refreshDevices();
        } catch {}
    });
    src.onerror = () => { /* EventSource reconnects; polls cover the gap */ };
}
function openSessStream() { syncEventStream(); }

// Session editor pane (detail for the selected session, split from the list).
const sessionDetailPanel = document.getElementById("session-detail-panel");
function openSessionDetail() {
    if (sessionDetailPanel && !panelVisible(sessionDetailPanel)) toggleEl("session-detail-panel");
    if (sessionDetailPanel) avoidPanelOverlap(sessionDetailPanel);
    saveUI();
    renderSessionDetail();
}
if (sessionDetailPanel) {
    document.getElementById("sessionDetailClose")?.addEventListener("click", () => {
        sessionDetailPanel.style.display = "none";
        saveUI();
    });
}

// --- Sessions tab: list + create + committee controls ---
// (The selection lives on the UI store — UI.selectedSessionId — declared up top.)
let sessionsCache = [];

// --- Session creation draft: course + placement previewed on the chart ---
// Courses are N-wind shapes (+y = upwind = north at windDir 0), so the
// draft also assumes 0° until Align upwind (or the hand) sets the day's wind.
const SESSDRAFT = { course: null, sel: null, origin: null, windDir: 0, windSpeed: 0, scale: 1, gunSec: 60 };
let sessPreview = null;
let sessMove = null;
let sessSuppressClick = false;
// The draft course is directly draggable on the map while the create pane is
// open — no arming button (todo 20). The grab region is a padded box around
// the preview geometry: a press inside grabs the course (cursor: move),
// anywhere else the map pans as normal. Create freezes the snapshot.
const SESS_BOX_PAD_PX = 20;
function sessPreviewBox() {
    if (!sessPreview) return null;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0;
    const eat = (ll) => {
        const p = map.latLngToContainerPoint(ll);
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        n++;
    };
    sessPreview.eachLayer(layer => {
        if (typeof layer.getLatLngs === "function") {
            const g = layer.getLatLngs();
            (Array.isArray(g[0]) ? g.flat() : g).forEach(eat);
        } else if (typeof layer.getLatLng === "function") {
            const c = layer.getLatLng();
            eat(c);
            if (typeof layer.getRadius === "function") {
                // include the mark circle edge in the box
                const dLat = layer.getRadius() / 111320;
                const dLon = layer.getRadius() / (111320 * Math.max(0.2, Math.cos(c.lat * Math.PI / 180)));
                eat(L.latLng(c.lat + dLat, c.lng)); eat(L.latLng(c.lat - dLat, c.lng));
                eat(L.latLng(c.lat, c.lng + dLon)); eat(L.latLng(c.lat, c.lng - dLon));
            }
        }
    });
    if (!n) return null;
    return { x0: minX - SESS_BOX_PAD_PX, y0: minY - SESS_BOX_PAD_PX, x1: maxX + SESS_BOX_PAD_PX, y1: maxY + SESS_BOX_PAD_PX };
}
function sessBoxActive() {
    return !!SESSDRAFT.origin && !!sessPreview &&
        panelVisible(document.getElementById("session-create-panel"));
}
function endSessMove() {
    sessMove = null;
    if (map.dragging) map.dragging.enable();
    try {
        const c = map.getContainer();
        if (c && c.style.cursor === "move") c.style.cursor = "";
        document.body.classList.remove("sess-placing");
    } catch {}
}
if (typeof map !== "undefined" && map.getContainer) {
    const sessBox = map.getContainer();
    sessBox.addEventListener("pointerdown", e => {
        if (!sessBoxActive()) { if (!panelVisible(document.getElementById("session-create-panel"))) endSessMove(); return; }
        // The course's own mark labels are markers too — they grab like the
        // rest of the preview. Every other marker/icon keeps map behavior.
        if (e.target.closest(".leaflet-tooltip, .leaflet-control, button, input, select, a")) return;
        if (e.target.closest(".leaflet-marker-icon") && !e.target.closest(".builder-mark-label")) return;
        // Grab the course only inside its box — elsewhere the map pans.
        const pt = map.mouseEventToContainerPoint(e);
        const box = sessPreviewBox();
        if (!box || pt.x < box.x0 || pt.x > box.x1 || pt.y < box.y0 || pt.y > box.y1) return;
        e.stopPropagation();
        e.preventDefault();
        if (map.dragging) map.dragging.disable();
        const p = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
        sessMove = { lastLat: p.lat, lastLon: p.lng };
        try { sessBox.setPointerCapture(e.pointerId); } catch {}
    });
    sessBox.addEventListener("pointermove", e => {
        if (sessMove || e.buttons) return; // dragging (or pressed): leave the cursor alone
        // Body flag drives the mark-label cursor (labels are markers: the
        // container cursor alone doesn't reach them).
        document.body.classList.toggle("sess-placing", sessBoxActive());
        if (!sessBoxActive()) { if (sessBox.style.cursor) sessBox.style.cursor = ""; return; }
        const pt = map.mouseEventToContainerPoint(e);
        const box = sessPreviewBox();
        const inside = box && pt.x >= box.x0 && pt.x <= box.x1 && pt.y >= box.y0 && pt.y <= box.y1;
        sessBox.style.cursor = inside ? "move" : "";
    });
    sessBox.addEventListener("pointermove", e => {
        if (!sessMove) return;
        const p = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
        const dy = p.lat - sessMove.lastLat, dx = p.lng - sessMove.lastLon;
        if (!dy && !dx) return;
        sessMove.lastLat = p.lat; sessMove.lastLon = p.lng;
        SESSDRAFT.origin = { lat: SESSDRAFT.origin.lat + dy, lon: SESSDRAFT.origin.lon + dx };
        syncSessForm();
        renderSessPreview();
    });
    const sessUp = () => {
        if (!sessMove) return;
        sessMove = null;
        sessSuppressClick = true;
        if (map.dragging) map.dragging.enable();
    };
    sessBox.addEventListener("pointerup", sessUp);
    sessBox.addEventListener("pointercancel", sessUp);
}
function clearSessPreview() {
    if (sessPreview) { map.removeLayer(sessPreview); sessPreview = null; }
}
let selPreview = null; // selected session's frozen course (read-only)
function clearSelPreview() {
    if (selPreview) { map.removeLayer(selPreview); selPreview = null; }
}
// Selected session's course on the chart: resolved marks + start/finish
// lines + dashed route + gate connectors. Absolute coords from the session
// (no wind-frame resolve needed) — this is what the devices sail.
function renderSelectedPreview(s) {
    clearSelPreview();
    if (!s || !Array.isArray(s.marks) || !s.marks.length) return;
    selPreview = L.layerGroup().addTo(map);
    const segCenter = g => [(g.latA + g.latB) / 2, (g.lonA + g.lonB) / 2];
    const latlngs = [];
    if (s.startLine && s.startLine.latA !== undefined) {
        latlngs.push(segCenter(s.startLine));
        L.polyline([[s.startLine.latA, s.startLine.lonA], [s.startLine.latB, s.startLine.lonB]], { color: "#16a34a", weight: 5 }).addTo(selPreview);
    }
    const effFinish = s.finishLine && s.finishLine.sameAs === "start" ? s.startLine : s.finishLine;
    routeThread(s.marks.map((m, i) => ({ ...m, src: i }))).forEach(r => latlngs.push(r.pt));
    if (effFinish && effFinish.latA !== undefined) {
        latlngs.push(segCenter(effFinish));
        const same = effFinish === s.startLine;
        L.polyline([[effFinish.latA, effFinish.lonA], [effFinish.latB, effFinish.lonB]], same
            ? { color: "#dc2626", weight: 2, dashArray: "6 4" }
            : { color: "#dc2626", weight: 5 }).addTo(selPreview);
    }
    L.polyline(latlngs, { color: "#3b82f6", weight: 2, dashArray: "6 4", opacity: 0.9 }).addTo(selPreview);
    s.marks.forEach((m, i) => {
        L.circle([m.lat, m.lon], { radius: m.r || 30, color: MARK_COLORS[m.type] || "#f59e0b", weight: 2, fillOpacity: 0.08 }).addTo(selPreview);
        const col = MARK_COLORS[m.type] || "#f59e0b";
        arrowSides(m, i, s.marks).forEach(sd => {
            const arr = roundingArc(m.lat, m.lon, m.r || 30, sd);
            if (!arr) return;
            L.polyline(arr.arc, { color: col, weight: 2, opacity: 0.9 }).addTo(selPreview);
            L.polygon(arr.head, { color: col, fillColor: col, fillOpacity: 0.9, weight: 1 }).addTo(selPreview);
        });
        L.marker([m.lat, m.lon], {
            icon: L.divIcon({
                html: `<div class="builder-mark-label" style="background:${MARK_COLORS[m.type] || "#f59e0b"}">${i + 1}</div>`,
                className: "", iconSize: [22, 22], iconAnchor: [11, 11],
            }),
        }).addTo(selPreview);
    });
    const gg = {};
    s.marks.forEach((m, i) => { if (m.type === "gate" && m.gate) { (gg[m.gate] = gg[m.gate] || []).push(i); } });
    Object.values(gg).forEach(g => {
        if (g.length !== 2) return;
        L.polyline([[s.marks[g[0]].lat, s.marks[g[0]].lon], [s.marks[g[1]].lat, s.marks[g[1]].lon]],
            { color: "#984ea3", weight: 2, dashArray: "6 4" }).addTo(selPreview);
    });
}
function sessDraftInst() {
    return { originLat: SESSDRAFT.origin.lat, originLon: SESSDRAFT.origin.lon, windDir: SESSDRAFT.windDir, scale: SESSDRAFT.scale };
}
function renderSessPreview() {
    clearSessPreview();
    // a course fetch may resolve after the panel was closed — stay buried
    if (!panelVisible(document.getElementById("session-create-panel"))) return;
    const t = SESSDRAFT.course;
    if (!t || !SESSDRAFT.origin) return;
    const o = sessDraftInst();
    sessPreview = L.layerGroup().addTo(map);
    const marks = resolveMarksJS(t.marks, o);
    const latlngs = routeThread(marks.map((m, i) => ({ ...m, src: i }))).map(r => r.pt);
    if (t.startLine) {
        const r = resolveSegJS(t.startLine, o);
        latlngs.unshift([(r.latA + r.latB) / 2, (r.lonA + r.lonB) / 2]);
        L.polyline([[r.latA, r.lonA], [r.latB, r.lonB]], { color: "#16a34a", weight: 5 }).addTo(sessPreview);
    }
    // finishLine arrives as "start" (builder shorthand) or {sameAs:"start"}
    // (presets / DB rows) — both mean "mirror the start line". Anything else
    // must be a real segment; resolving {sameAs} as geometry yields NaN and
    // aborts the whole preview (leaving just the start line behind).
    const sameAsStart = t.finishLine === "start" || (t.finishLine && t.finishLine.sameAs === "start");
    const effFinish = sameAsStart ? t.startLine : t.finishLine;
    if (effFinish && typeof effFinish === "object") {
        const r = resolveSegJS(effFinish, o);
        latlngs.push([(r.latA + r.latB) / 2, (r.lonA + r.lonB) / 2]);
        const same = sameAsStart;
        L.polyline([[r.latA, r.lonA], [r.latB, r.lonB]], same
            ? { color: "#dc2626", weight: 2, dashArray: "6 4" }
            : { color: "#dc2626", weight: 5 }).addTo(sessPreview);
    }
    L.polyline(latlngs, { color: "#3b82f6", weight: 2, dashArray: "6 4", opacity: 0.9 }).addTo(sessPreview);
    marks.forEach((m, i) => {
        L.circle([m.lat, m.lon], { radius: m.r, color: MARK_COLORS[m.type] || "#f59e0b", weight: 2, fillOpacity: 0.08 }).addTo(sessPreview);
        const col = MARK_COLORS[m.type] || "#f59e0b";
        arrowSides(m, i, marks).forEach(sd => {
            const arr = roundingArc(m.lat, m.lon, m.r, sd);
            if (!arr) return;
            L.polyline(arr.arc, { color: col, weight: 2, opacity: 0.9 }).addTo(sessPreview);
            L.polygon(arr.head, { color: col, fillColor: col, fillOpacity: 0.9, weight: 1 }).addTo(sessPreview);
        });
        L.marker([m.lat, m.lon], {
            icon: L.divIcon({
                html: `<div class="builder-mark-label" style="background:${MARK_COLORS[m.type] || "#f59e0b"}">${i + 1}</div>`,
                className: "", iconSize: [22, 22], iconAnchor: [11, 11],
            }),
        }).addTo(sessPreview);
    });
    // gate connectors
    const gg = {};
    marks.forEach((m, i) => {
        const src = t.marks[i];
        if (src && src.type === "gate" && src.gate) { (gg[src.gate] = gg[src.gate] || []).push(i); }
    });
    Object.values(gg).forEach(g => {
        if (g.length !== 2) return;
        L.polyline([[marks[g[0]].lat, marks[g[0]].lon], [marks[g[1]].lat, marks[g[1]].lon]],
            { color: "#984ea3", weight: 2, dashArray: "6 4" }).addTo(sessPreview);
    });
}
async function pickSessCourse(value) {
    try {
        let c = null;
        // Every course — built-in or user — is a row with an id now, so one
        // fetch by id covers both (GET /courses returns all of them).
        const res = await fetch(`/courses/${String(value).replace(/^c:/, "")}`);
        c = await res.json();
        if (!c || !c.marks) return;
        SESSDRAFT.course = c;
        SESSDRAFT.sel = String(value);
        if (!SESSDRAFT.origin) {
            const m = map.getCenter();
            SESSDRAFT.origin = { lat: Math.round(m.lat * 1e5) / 1e5, lon: Math.round(m.lng * 1e5) / 1e5 };
        }
        syncSessForm();
        renderSessPreview();
    } catch {}
}
function syncSessForm() {
    const w = document.getElementById("sess-wind");
    if (w) w.value = SESSDRAFT.windDir;
    const sc = document.getElementById("sess-scale");
    if (sc) sc.value = SESSDRAFT.scale;
    const o = document.getElementById("sess-origin");
    if (o) o.textContent = "Origin: " + (SESSDRAFT.origin
        ? `${SESSDRAFT.origin.lat.toFixed(5)}, ${SESSDRAFT.origin.lon.toFixed(5)}` : "—");
}
async function renderSessionCreate() {
    const el = document.getElementById("tab-session-create");
    if (!el) return;
    try {
        const courseRes = await fetch("/courses");
        const courses = await courseRes.json();
        coursesCache = courses;
        if (!lastDevices.length) await refreshDevices();
        const boatChecks = lastDevices.map(d => `<label style="display:inline-block;margin-right:8px;font-weight:normal;font-size:12px">
            <input type="checkbox" data-sb="${escHtml(d.deviceId)}" checked> ${escHtml(d.username || d.deviceId.slice(-5))}</label>`).join("");
        el.innerHTML = `
            <div class="device-meta" style="margin-bottom:6px">Pick a course, place it on the chart, set the wind</div>
            <div class="builder-row"><select id="sess-course">${courses.map(c => `<option value="c:${c.id}">${escHtml(c.name)}${c.builtinKey ? " (built-in)" : ""}</option>`).join("")}</select></div>
            <div class="builder-row">
                <span id="sess-origin" class="device-meta" style="flex:2">Origin: —</span>
                <span class="device-meta" title="Press-drag the course itself to place it; drag anywhere else to pan">drag course to place</span>
            </div>
            <div class="builder-row">
                <label class="device-meta" style="flex:1">Bearing <input id="sess-wind" type="number" min="0" max="359" step="1" style="max-width:64px" title="Bearing the wind comes from (deg)"></label>
                <label class="device-meta" style="flex:1">Scale <input id="sess-scale" type="number" min="0.1" max="5" step="0.1" style="max-width:64px"></label>
                <button id="sess-wind-suggest" title="Align the draft course upwind from nearby stations">Align upwind</button>
            </div>
            <div class="device-meta" id="sess-wind-src"></div>
            <div class="builder-row">
                <select id="sess-mode"><option value="practice">Practice</option><option value="race">Race</option></select>
            </div>
            <div class="builder-row" id="sess-gun-row">
                <span class="device-meta" title="Gun fires this long after Create session is pressed">Gun</span>
                <button data-gun="10" title="Gun 10 seconds after Create">0:10</button>
                <button data-gun="30" title="Gun 30 seconds after Create">0:30</button>
                <button data-gun="60" title="Gun 1 minute after Create">1:00</button>
                <button data-gun="120" title="Gun 2 minutes after Create">2:00</button>
                <button data-gun="300" title="Gun 5 minutes after Create">5:00</button>
            </div>
            <div style="margin:4px 0">${boatChecks || '<span class="device-meta">No boats known yet.</span>'}</div>
            <div class="builder-row"><button id="sess-create" class="primary">Create session</button></div>
            <div id="sess-create-err" class="boat-info-err"></div>`;
        document.getElementById("sess-course").addEventListener("change", e => pickSessCourse(e.target.value));
        const sessSel = document.getElementById("sess-course");
        const hasSel = opt => [...sessSel.options].some(o => o.value === opt);
        if (SESSDRAFT.sel && hasSel(SESSDRAFT.sel)) sessSel.value = SESSDRAFT.sel;
        pickSessCourse(sessSel.value);
        document.getElementById("sess-wind").addEventListener("change", e => {
            SESSDRAFT.windDir = Math.min(359, Math.max(0, Math.round(Number(e.target.value) || 0)));
            e.target.value = SESSDRAFT.windDir;
            renderSessPreview();
        });
        document.getElementById("sess-scale").addEventListener("change", e => {
            SESSDRAFT.scale = Math.min(5, Math.max(0.1, Number(e.target.value) || 1));
            e.target.value = SESSDRAFT.scale;
            renderSessPreview();
        });
        document.querySelectorAll("#sess-gun-row button[data-gun]").forEach(b => {
            if (Number(b.getAttribute("data-gun")) === (SESSDRAFT.gunSec || 60)) b.classList.add("active");
            b.addEventListener("click", () => {
                SESSDRAFT.gunSec = Number(b.getAttribute("data-gun")) || 60;
                document.querySelectorAll("#sess-gun-row button[data-gun]").forEach(x =>
                    x.classList.toggle("active", x === b));
            });
        });
        document.getElementById("sess-wind-suggest").addEventListener("click", async () => {
            const src = document.getElementById("sess-wind-src");
            const at = SESSDRAFT.origin || (() => { const m = map.getCenter(); return { lat: m.lat, lon: m.lng }; })();
            src.textContent = "asking…";
            try {
                const res = await fetch(`/wind?lat=${at.lat}&lon=${at.lon}&provider=${windProvider}`);
                if (!res.ok) throw new Error();
                const w = await res.json();
                SESSDRAFT.windDir = ((Math.round(w.dir) % 360) + 360) % 360;
                SESSDRAFT.windSpeed = Math.max(0, Math.round(Number(w.speedKn) || 0));
                syncSessForm();
                src.textContent = `${escHtml(w.source)} · ${w.distKm != null ? w.distKm + "km" : "model"} · ${w.ageMin}min ago · ${w.speedKn}kn`;
                renderSessPreview();
            } catch {
                src.textContent = "no wind source available";
            }
        });
        document.getElementById("sess-create").addEventListener("click", async () => {
            const errEl = document.getElementById("sess-create-err");
            const date = todayStr();
            const mode = document.getElementById("sess-mode").value;
            // Gun countdown: the gun fires gunSec after THIS press, so the
            // start is always anchored at creation, never a stale clock time.
            const startISO = new Date(Date.now() + (SESSDRAFT.gunSec || 60) * 1000).toISOString();
            const t0 = SESSDRAFT.course;
            if (!t0) { errEl.textContent = "Pick a course first."; return; }
            if (!SESSDRAFT.origin) { errEl.textContent = "Drag the map to place the course first."; return; }
            // Sessions encapsulate: every course is a DB row now (built-ins included),
            // so lineage always passes courseId.
            const shapeBody = { courseId: t0.id };
            // One round trip: the checked boats ride along with the create
            // call (server applies the same 409 guard and mock auto-sim).
            const ids = [...document.querySelectorAll("#tab-session-create input[data-sb]:checked")].map(x => x.getAttribute("data-sb"));
            try {
                const res = await fetch("/sessions", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...shapeBody,
                        boats: ids.map((deviceId) => ({ deviceId })),
                        name: `${t0.name} — ${date}`, date, mode,
                        originLat: SESSDRAFT.origin.lat, originLon: SESSDRAFT.origin.lon,
                        windDir: SESSDRAFT.windDir, windSpeed: SESSDRAFT.windSpeed, scale: SESSDRAFT.scale,
                        startTime: startISO,
                    }),
                });
                const j = await res.json();
                if (!res.ok) { errEl.textContent = j.error || "Create failed."; return; }
                if (sessionCreatePanel) sessionCreatePanel.style.display = "none";
                endSessMove();
                clearSessPreview();
                // A fresh session is scheduled: watch it live (full trace since
                // creation + flowing feed), like clicking its row.
                await openSessionsPanel(j.id);
                enterLiveWatch(j.id, "session-create");
            } catch { errEl.textContent = "Network error."; }
        });
        if (typeof avoidPanelOverlap === "function") avoidPanelOverlap(document.getElementById("session-create-panel"));
avoidPanelOverlap(document.getElementById("settings-panel"));
    } catch (e) {
        el.innerHTML = '<div class="boat-info-err">Failed to load courses.</div>';
    }
}
// --------------------------------------------------
// Sessions filter (todo 10)
//
// RAM-only and deliberately NOT persisted: a reload always shows every
// session. The marker on the topbar button is the only cue that a filter
// is on, which is exactly why the reset must be obvious.
//
// Filtering is client-side against the full list — the API grew
// ?from=&to=&status= for paging later, but the calendar day counts need
// the UNFILTERED set, so narrowing server-side would mean a second
// request per change. The list is now geometry-free and cheap to hold.
// --------------------------------------------------
const SESS_STATUSES = ["scheduled", "live", "finished", "abandoned"];
const sessFilter = { statuses: new Set(), modes: new Set(), from: "", to: "" };

function sessFilterActive() {
    return sessFilter.statuses.size > 0 || sessFilter.modes.size > 0 ||
        !!sessFilter.from || !!sessFilter.to;
}

function sessFilterApply(list) {
    return list.filter(s => {
        if (sessFilter.statuses.size && !sessFilter.statuses.has(s.status)) return false;
        if (sessFilter.modes.size && !sessFilter.modes.has(s.mode || "practice")) return false;
        if (sessFilter.from && s.date < sessFilter.from) return false;
        if (sessFilter.to && s.date > sessFilter.to) return false;
        return true;
    });
}

function sessFilterSyncChips() {
    document.querySelectorAll("[data-sess-status]").forEach(b => {
        b.classList.toggle("active", sessFilter.statuses.has(b.getAttribute("data-sess-status")));
    });
    document.querySelectorAll("[data-sess-mode]").forEach(b => {
        b.classList.toggle("active", sessFilter.modes.has(b.getAttribute("data-sess-mode")));
    });
    const from = document.getElementById("sess-filter-from");
    const to = document.getElementById("sess-filter-to");
    if (from) from.classList.toggle("active", !!sessFilter.from);
    if (to) to.classList.toggle("active", !!sessFilter.to);
    const btn = document.getElementById("sessionsToggleBtn");
    if (btn) btn.classList.toggle("filtered", sessFilterActive());
}

// Day strip derived from the FULL list (not the filtered one), so the
// counts do not move as you filter — it doubles as a one-click picker.
function sessFilterRenderDays() {
    const box = document.getElementById("sess-filter-days");
    if (!box) return;
    const counts = new Map();
    for (const s of sessionsCache) counts.set(s.date, (counts.get(s.date) || 0) + 1);
    const days = [...counts.keys()].sort().reverse().slice(0, 12);
    if (!days.length) { box.innerHTML = '<span class="sess-filter-none">no sessions yet</span>'; return; }
    box.innerHTML = days.map(d =>
        `<button class="sess-day${sessFilter.from === d && sessFilter.to === d ? " active" : ""}" data-sess-day="${d}" title="${d}">${d.slice(5)} <b>${counts.get(d)}</b></button>`
    ).join("");
    box.querySelectorAll("[data-sess-day]").forEach(b => {
        b.addEventListener("click", () => {
            const d = b.getAttribute("data-sess-day");
            // Clicking the active day clears it; otherwise select just it.
            if (sessFilter.from === d && sessFilter.to === d) {
                sessFilter.from = ""; sessFilter.to = "";
            } else {
                sessFilter.from = d; sessFilter.to = d;
            }
            const f = document.getElementById("sess-filter-from");
            const t = document.getElementById("sess-filter-to");
            if (f) f.value = sessFilter.from;
            if (t) t.value = sessFilter.to;
            sessFilterSyncChips();
            renderSessionsList();
        });
    });
}

function renderSessionsList() {
    const el = document.getElementById("tab-sessions");
    if (!el) return;
    const rows = sessFilterApply(sessionsCache);
    el.innerHTML = `
        <div id="sess-list">` + (rows.length ? rows.map(s => `
            <div class="device-item ${String(s.id) === String(UI.selectedSessionId) ? "active" : ""}" data-sess="${s.id}" style="cursor:pointer">
                <div style="overflow:hidden;flex:1">
                    <span class="device-name">${escHtml(s.name || ("Session " + s.id))}</span>
                    <div class="device-meta">${escHtml(s.date)} · ${s.boats.length} boat${s.boats.length === 1 ? "" : "s"}</div>
                </div>
                <div style="text-align:right">
                    <div><span class="mode-badge ${s.mode}">${s.mode}</span>
                    </div>
                    <div style="margin-top:2px"><span class="status-badge ${s.status}">${s.status}</span></div>
                </div>
            </div>`).join("") : `<div class="device-meta">${sessionsCache.length ? "No sessions match the filter." : "No sessions yet."}</div>`) + `</div>`;
    wireSessionRows(el);
    sessFilterRenderDays();
    sessFilterSyncChips();
}

// Re-binds the row handlers after a re-render (the previous listeners
// went with the innerHTML).
// Legacy alias: everything that "clears the session" is entering live.
// (Canonical body lives in enterLiveMode, next to setMode.)
function unselectSession(reason) { enterLiveMode(reason || "unselect"); }
// Replay window for a closed session: span the WHOLE recorded run, not a
// fixed slice. It used to be gun±60s, widened only by finish splits — an
// abandoned race uploads no run rows yet, so that window dropped everything
// after the first minute. The 90-min ceiling matches
// selectedSessionEndMs(); the floor is the session creation time, because the
// pre-gun stretch is part of what was watched live.
// Returns [fromMs, toMs].
async function closedSessionWindow(s) {
    const gun = s && s.startTime ? new Date(s.startTime) : new Date();
    const createdAtMs = (s && s.createdAt) ? new Date(s.createdAt).getTime() : NaN;
    let fromMs = isNaN(createdAtMs) ? gun.getTime() - 120000 : Math.min(gun.getTime() - 120000, createdAtMs);
    let toMs = gun.getTime() + 90 * 60 * 1000;
    try {
        const rr = await (await fetch(`/sessions/${s.id}/runs`)).json();
        const splits = rr && rr.length ? (rr[0].splits || []) : [];
        const last = splits.length ? splits[splits.length - 1] : 0;
        if (last > 0) toMs = Math.max(toMs, gun.getTime() + (last + 60) * 1000);
    } catch {}
    return [fromMs, toMs];
}
function wireSessionRows(el) {
    el.querySelectorAll("[data-sess-x]").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            e.preventDefault();
            unselectSession();
            const root = document.getElementById("tab-sessions");
            if (root) renderSessionsList();
        });
    });
    el.querySelectorAll("[data-sess-r]").forEach(btn => {
        btn.addEventListener("click", async e => {
            e.stopPropagation();
            e.preventDefault();
            const sid = btn.getAttribute("data-sess-r");
            try {
                const s = await (await fetch(`/sessions/${sid}`)).json();
                const [fromMs, toMs] = await closedSessionWindow(s);
                // Explicit replay action: frozen window even for open sessions.
                enterFrozenReplay(Number(sid), fromMs, toMs, "row-replay");
            } catch {}
        });
    });
    el.querySelectorAll("[data-sess]").forEach(row => {
        row.addEventListener("click", async () => {
            const id = Number(row.getAttribute("data-sess"));
            if (id === UI.selectedSessionId) {
                // toggle off: back to plain live mode.
                enterLiveMode("row-toggle");
            } else {
                const s = sessionsCache.find(x => String(x.id) === String(id));
                if (s && !["finished", "abandoned"].includes(s.status)) {
                    // Scheduled/live: watch the LIVE feed scoped to this
                    // session (today's tracks + live mock arrows), not a
                    // frozen slice of stored data.
                    enterLiveWatch(id, "row-select");
                } else {
                    // Closed session: frozen replay of the recorded run.
                    const [fromMs, toMs] = await closedSessionWindow(s);
                    enterFrozenReplay(id, fromMs, toMs, "row-select");
                }
            }
        });
    });
    el.querySelectorAll("[data-sedit]").forEach(a => {
        a.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            UI.selectedSessionId = Number(a.getAttribute("data-sedit"));
            renderSessionsList();
            openSessionDetail();
        });
    });
}

function wireSessionFilters() {
    document.querySelectorAll("[data-sess-status]").forEach(b => {
        b.addEventListener("click", () => {
            const s = b.getAttribute("data-sess-status");
            if (sessFilter.statuses.has(s)) sessFilter.statuses.delete(s);
            else sessFilter.statuses.add(s);
            sessFilterSyncChips();
            renderSessionsList();
        });
    });
    document.querySelectorAll("[data-sess-mode]").forEach(b => {
        b.addEventListener("click", () => {
            const m = b.getAttribute("data-sess-mode");
            if (sessFilter.modes.has(m)) sessFilter.modes.delete(m);
            else sessFilter.modes.add(m);
            sessFilterSyncChips();
            renderSessionsList();
        });
    });
    const onDate = () => {
        const f = document.getElementById("sess-filter-from");
        const t = document.getElementById("sess-filter-to");
        let from = f && f.value ? f.value : "";
        let to = t && t.value ? t.value : "";
        // A single date typed in "from" means that day, not an open range.
        if (from && !to) to = from;
        if (to && !from) from = to;
        if (from && to && from > to) { const x = from; from = to; to = x; }
        sessFilter.from = from; sessFilter.to = to;
        sessFilterSyncChips();
        renderSessionsList();
    };
    const f = document.getElementById("sess-filter-from");
    const t = document.getElementById("sess-filter-to");
    if (f) f.addEventListener("change", onDate);
    if (t) t.addEventListener("change", onDate);
    const reset = document.getElementById("sess-filter-reset");
    if (reset) {
        reset.addEventListener("click", () => {
            sessFilter.statuses.clear();
            sessFilter.modes.clear();
            sessFilter.from = ""; sessFilter.to = "";
            if (f) f.value = "";
            if (t) t.value = "";
            sessFilterSyncChips();
            renderSessionsList();
        });
    }
}

async function loadSessions(selectId) {
    const el = document.getElementById("tab-sessions");
    try {
        const sessRes = await fetch("/sessions");
        sessionsCache = await sessRes.json();
        if (!lastDevices.length) await refreshDevices();
        if (selectId) UI.selectedSessionId = selectId;
        // A selected session can disappear under us (deleted via the API or
        // another client). Back to full live rather than stranding the map
        // on a ghost: no overlay, no tracks, no traffic.
        if (UI.selectedSessionId && !sessionsCache.some(s => String(s.id) === String(UI.selectedSessionId))) {
            unselectSession("ghost-drop");
        }
        // A watched session that just terminated (finished on the last run
        // upload, or ABANDON) hands over to its own replay: the page stops
        // being a live watch on a race nobody can sail any more, and the
        // timeline becomes usable without unselect/reselect. loadSessions is
        // the single funnel for status refreshes (SSE + focus reload), so the
        // handover happens wherever the status change was observed.
        if (UI.selectedSessionId && UI.isLive) {
            const sel = sessionsCache.find(s => String(s.id) === String(UI.selectedSessionId));
            if (sel && ["finished", "abandoned"].includes(sel.status)) {
                const [fromMs, toMs] = await closedSessionWindow(sel);
                enterFrozenReplay(sel.id, fromMs, toMs, "session-closed");
            }
        }
        renderSessionsList();
        if (UI.selectedSessionId) openSessionDetail();
        else {
            // Detail pane restored visible by loadUI() with nothing selected:
            // an empty "Session details" box is just noise — hide it.
            clearSessDetailTimers();
            document.getElementById("tab-session-detail").innerHTML = "";
            document.getElementById("session-detail-panel").style.display = "none";
        }
        if (typeof avoidPanelOverlap === "function") avoidPanelOverlap(document.getElementById("session-panel"));
    } catch (e) {
        el.innerHTML = '<div class="boat-info-err">Failed to load sessions.</div>';
    }
}

function sessLinesText(s) {
    const len = seg => (seg && seg.latA !== undefined)
        ? Math.round(map.distance([seg.latA, seg.lonA], [seg.latB, seg.lonB])) + "m" : "";
    const parts = [];
    if (s.startLine) parts.push(`start ${len(s.startLine)}`);
    if (s.finishLine && s.finishLine.sameAs === "start") parts.push("finish = start");
    else if (s.finishLine) parts.push(`finish ${len(s.finishLine)}`);
    return parts.length ? parts.join(" · ") : "radius circles";
}

// Session-detail live timers (gun countdown) + sim map overlay (scripted
// boat preview + moving dot for indoor testing). Timers die on re-render.
let sessDetailTimers = [];
function clearSessDetailTimers() {
    sessDetailTimers.forEach(t => clearInterval(t));
    sessDetailTimers = [];
}
let simOverlay = null;
let simOverlayRun = null;
function clearSimOverlay() {
    if (simOverlay) { map.removeLayer(simOverlay); simOverlay = null; }
    simOverlayRun = null;
}
// The scripted route a session's mock boat sailed, drawn as a dashed
// preview only (the live boat triangle already marks the fed position — no
// second dot).
//
// One call, keyed by SESSION. It used to be two calls by RUN id
// (/sim/runs?sessionId= then /sim/runs/:id/points), and that worked while
// the race was live and failed once it was over: runs are pruned 10 minutes
// after they end and mock uploads never reach gps_points, so a FINISHED
// session had no track to draw at all — selecting one showed an empty map.
// The route is persisted per session and read back here.
async function renderSimOverlay(fit) {
    clearSimOverlay();
    if (!showSimPreview) return;
    const box = document.getElementById("tab-session-detail");
    if (!box || !UI.selectedSessionId) return;
    const sid = UI.selectedSessionId;
    let pts;
    try {
        const res = await fetch(`/sim/routes/${encodeURIComponent(sid)}`);
        if (!res.ok) return;              // no scripted route for this session
        pts = await res.json();
        if (!pts.points || !pts.points.length) return;
    } catch { return; }
    // A newer selection may have landed while this was in flight.
    if (String(UI.selectedSessionId) !== String(sid)) return;
    if (!document.getElementById("tab-session-detail")) return;
    simOverlay = L.layerGroup().addTo(map);
    simOverlayRun = pts.runId;
    const latlngs = pts.points.map(p => [p.lat, p.lon]);
    L.polyline(latlngs, { color: "#f97316", weight: 2, dashArray: "6 4", opacity: 0.9 }).addTo(simOverlay);
    if (fit) map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
}
// Centre the map on a session's course when it is picked from the list.
// Uses the marks AND both lines: a W/L's interesting extent is the start
// and finish line plus the marks between them, and fitting the marks alone
// would cut the line off screen.
function fitMapToSession(s) {
    if (!s) return;
    const pts = [];
    (s.marks || []).forEach(m => {
        if (typeof m.lat === "number" && typeof m.lon === "number") pts.push([m.lat, m.lon]);
    });
    for (const seg of [s.startLine, s.finishLine]) {
        if (!seg) continue;
        if (typeof seg.latA === "number" && typeof seg.lon === "number") pts.push([seg.latA, seg.lonA]);
        if (typeof seg.latB === "number" && typeof seg.lon === "number") pts.push([seg.latB, seg.lonB]);
    }
    if (pts.length < 2) return;
    try { map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 }); } catch {}
}

async function renderSessionDetail() {
    const el = document.getElementById("tab-session-detail");
    if (!el) return;    clearSessDetailTimers();
    clearSimOverlay();
    try {
        const res = await fetch(`/sessions/${UI.selectedSessionId}`);
        if (!res.ok) { el.innerHTML = ""; return; }
        const s = await res.json();
        // Keep the previous selection alone — the map should keep showing
        // every boat's track as on the live view, even inside a session.
        // (Future: add a toggle to narrow this to the session's boats.)
        // Session open → no live feed on top of the race's view.
        try { hideLiveSimTrace(); } catch {}
        renderSelectedPreview(s);
        fitMapToSession(s);
        el.innerHTML = `
            <div class="sess-detail">
                <b>${escHtml(s.name || ("Session " + s.id))}</b>
                <table>
                    <tr><td>Date</td><td>${escHtml(s.date)}</td></tr>
                    <tr><td>Mode</td><td><span class="mode-badge ${s.mode}">${s.mode}</span></td></tr>
                    <tr><td>Status</td><td><span class="status-badge ${s.status}">${s.status}</span></td></tr>
                    <tr><td>Course</td><td>v${s.courseVersion} · ${s.marks.length} marks · wind ${Math.round(s.windDir)}&deg; · scale ${s.scale}</td></tr>
                    <tr><td>Lines</td><td>${sessLinesText(s)}</td></tr>
                    <tr><td>Start</td><td>${s.startTime ? escHtml(new Date(s.startTime).toLocaleString()) : "—"}</td></tr>
                    <tr><td>Gun</td><td id="sess-countdown">—</td></tr>
                    <tr><td>Boats</td><td>${s.boats.length ? s.boats.map(b => `${escHtml((lastDevices.find(d => d.deviceId === b.deviceId) || {}).username || b.deviceId.slice(-5))}${b.startOffsetSec ? ` (+${b.startOffsetSec}s)` : ""} <a href="#" data-unboat="${escHtml(b.deviceId)}" style="color:#dc2626">×</a>`).join(", ") : "—"}</td></tr>
                </table>
                ${s.status !== "abandoned" && (!s.startTime || Date.now() < new Date(s.startTime).getTime()) ? `
                <div class="builder-row" id="sess-post-row">
                    <input id="sess-post-mins" type="number" value="5" min="1" max="120" title="Minutes to push the gun" style="max-width:70px">
                    <button id="sess-post" title="Push the gun later by this many minutes (pre-start only)">Postpone</button>
                </div>` : ""}
                <div class="builder-row">
                    <select id="sess-add-boat">${lastDevices.map(d => `<option value="${escHtml(d.deviceId)}">${escHtml(d.username || d.deviceId.slice(-5))}</option>`).join("")}</select>
                    <input id="sess-add-off" type="number" value="0" title="Pursuit offset (s)" style="max-width:70px">
                    <button id="sess-add-btn">Add</button>
                </div>
                ${["finished", "abandoned"].includes(s.status) ? "" : `
                <div class="builder-row">
                    <button id="sess-sim-preview" title="Show/hide the scripted mock traces on the map">Mock traces</button>
                </div>`}
                ${s.status === "live" ? `
                <div class="builder-row"><b>Committee</b></div>
                <div class="builder-row">
                    <select id="sess-sig-boat">${s.boats.length ? s.boats.map(b => `<option value="${escHtml(b.deviceId)}">${escHtml((lastDevices.find(d => d.deviceId === b.deviceId) || {}).username || b.deviceId.slice(-5))}</option>`).join("") : ""}</select>
                    <button data-sig="OCS" title="Confirm OCS for this boat">OCS</button>
                    <button data-sig="DSQ" title="Disqualify this boat">DSQ</button>
                    <button data-sig="DNF" title="Did not finish">DNF</button>
                    <button data-sig="RET" title="Retired">RET</button>
                </div>
                <div class="builder-row">
                    <input id="sess-sig-scp" type="number" value="120" title="SCP seconds" style="max-width:70px">
                    <button data-sig="SCP" title="Scoring penalty: add seconds">SCP</button>
                    <button data-sig="RECALL" title="General recall (fleet)">Recall</button>
                </div>` : ""}
                <div id="sess-signals" class="device-meta"></div>
                <div class="builder-row"><b>Results</b><button id="sess-res-refresh" title="Reload results">↻</button></div>
                <div id="sess-results" class="device-meta">no runs yet</div>
                <div class="builder-row">
                    ${s.status === "abandoned" || s.status === "finished"
                        ? ""
                        : `<button id="sess-abandon" title="Void the race AND tell the fleet now" style="color:#dc2626">Abandon race</button>`}
                    <button id="sess-del" style="color:#dc2626">Delete session</button>
                </div>
                <div id="sess-detail-err" class="boat-info-err"></div>
            </div>`;
        const put = async body => {
            const r = await fetch(`/sessions/${s.id}`, {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const j = await r.json();
            if (!r.ok) document.getElementById("sess-detail-err").textContent = j.error || "Update failed.";
            else loadSessions(s.id);
        };
        document.getElementById("sess-abandon")?.addEventListener("click", async () => {
            // One action: void the record + broadcast to the fleet now.
            await fetch(`/sessions/${s.id}`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "abandoned" }),
            });
            await fetch(`/sessions/${s.id}/signals`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: "ABANDON" }),
            });
            loadSessions(s.id);
        });
        document.getElementById("sess-post")?.addEventListener("click", () => {
            const mins = Math.min(120, Math.max(1, Number(document.getElementById("sess-post-mins").value) || 5));
            const base = s.startTime ? Math.max(new Date(s.startTime).getTime(), Date.now()) : Date.now();
            put({ startTime: new Date(base + mins * 60 * 1000).toISOString() });
        });
        document.getElementById("sess-add-btn").addEventListener("click", async () => {
            const id = document.getElementById("sess-add-boat").value;
            const off = Number(document.getElementById("sess-add-off").value) || 0;
            const errBox = document.getElementById("sess-detail-err");
            if (!id) return;
            const r = await fetch(`/sessions/${s.id}/boats`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deviceId: id, startOffsetSec: off }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) { if (errBox) errBox.textContent = j.error || "Could not add boat."; return; }
            if (errBox) errBox.textContent = "";
            loadSessions(s.id);
        });
        el.querySelectorAll("[data-unboat]").forEach(a => a.addEventListener("click", async e => {
            e.preventDefault();
            await fetch(`/sessions/${s.id}/boats/${encodeURIComponent(a.getAttribute("data-unboat"))}`, { method: "DELETE" });
            loadSessions(s.id);
        }));
        document.getElementById("sess-del").addEventListener("click", async () => {
            if (!confirm("Delete this session?")) return;
            await fetch(`/sessions/${s.id}`, { method: "DELETE" });
            // Back to full live (today window, traces obey the dropdown),
            // not stuck on the deleted session's frozen range.
            unselectSession();
            clearSessPreview();
            endSessMove();
            loadSessions();
        });
        const boatName = id => escHtml((lastDevices.find(d => d.deviceId === id) || {}).username || id.slice(-5));
        const fmtEl = sec => sec == null ? "—" : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        const refreshResults = async () => {
            const box = document.getElementById("sess-results");
            if (!box) return;
            try {
                const runs = await (await fetch(`/sessions/${s.id}/runs`)).json();
                box.innerHTML = runs.length ? `<table>${runs.map((r, i) => {
                    const pens = r.events.filter(e => ["OCS", "WRONG", "SIG"].includes(e.e))
                        .map(e => e.e + (e.v ? `:${escHtml(e.v)}` : "")).join(" ");
                    const splits = r.splits.length ? r.splits.map(fmtEl).join(" ") : "—";
                    return `<tr><td>${r.result === "FINISHED" ? i + 1 : "–"}</td><td>${boatName(r.deviceId)}</td><td>${fmtEl(r.elapsedSec)}</td><td>${splits}</td><td>${r.result}${pens ? ` (${pens})` : ""}</td></tr>`;
                }).join("")}</table>` : "no runs yet";
            } catch { box.textContent = "results unavailable"; }
        };
        document.getElementById("sess-res-refresh").addEventListener("click", refreshResults);
        refreshResults();
        const refreshSignals = async () => {
            const box = document.getElementById("sess-signals");
            if (!box) return;
            try {
                const sigs = await (await fetch(`/sessions/${s.id}/signals`)).json();
                box.innerHTML = sigs.length ? sigs.map(g =>
                    `<div>${escHtml(g.kind)}${g.deviceId ? ` → ${boatName(g.deviceId)}` : " (fleet)"}${g.detail ? ` ${escHtml(g.detail)}` : ""}</div>`
                ).join("") : "no signals";
            } catch { box.textContent = "signals unavailable"; }
        };
        // Load the signal log on OPEN, not only after posting one. It used to
        // be called only from the POST handler's success path, so opening a
        // session showed an empty committee log — the one thing the pane
        // exists to show — until you raised a signal yourself.
        refreshSignals();
        el.querySelectorAll("[data-sig]").forEach(b => b.addEventListener("click", async () => {
            const kind = b.getAttribute("data-sig");
            const body = { kind };
            if (!["RECALL", "ABANDON"].includes(kind)) {
                const sel = document.getElementById("sess-sig-boat");
                if (!sel || !sel.value) return;
                body.deviceId = sel.value;
            }
            if (kind === "SCP") body.detail = String(Number(document.getElementById("sess-sig-scp").value) || 0);
            const r = await fetch(`/sessions/${s.id}/signals`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const j = await r.json();
            if (!r.ok) document.getElementById("sess-detail-err").textContent = j.error || "Signal failed.";
            else refreshSignals();
        }));
        const syncSimPreviewBtn = () => {
            const b = document.getElementById("sess-sim-preview");
            if (b) b.classList.toggle("active", !!showSimPreview);
        };
        document.getElementById("sess-sim-preview")?.addEventListener("click", () => {
            showSimPreview = !showSimPreview;
            try { saveUI(); } catch {}
            syncSimPreviewBtn();
            renderSimOverlay(false);
        });
        syncSimPreviewBtn();
        // Closed sessions show the sailed track, not the scripted ideal:
        // the mock overlay would sit on top of history with no toggle
        // (the button below is only rendered pre-finish).
        if (!["finished", "abandoned"].includes(s.status)) renderSimOverlay(false);
        const gunMs = s.startTime ? new Date(s.startTime).getTime() : 0;
        const tickCountdown = () => {
            const box = document.getElementById("sess-countdown");
            if (!box) return;
            if (!gunMs || ["finished", "abandoned"].includes(s.status)) { box.textContent = "—"; return; }
            const d = Math.floor((gunMs - Date.now()) / 1000);
            const mmss = `${Math.floor(Math.abs(d) / 60)}:${String(Math.abs(d) % 60).padStart(2, "0")}`;
            box.innerHTML = d >= 0 ? `Gun in <b>${mmss}</b>` : `<b style="color:#16a34a">LIVE +${mmss}</b>`;
            // The gun just fired under an open pane: postpone is over.
            if (d < 0) document.getElementById("sess-post-row")?.remove();
        };
        tickCountdown();
        sessDetailTimers.push(setInterval(tickCountdown, 1000));
        // Status is inferred server-side (gun passed → live, all boats in →
        // finished): refresh just the badge so the committee sees flips.
        const tickStatus = async () => {
            // SSE owns status while subscribed; this is the fallback.
            if (sessSubbed("session")) return;
            try {
                const sj = await (await fetch(`/sessions/${s.id}`)).json();
                if (sj && sj.status && sj.status !== s.status) {
                    s.status = sj.status;
                    const badge = el.querySelector(".status-badge");
                    if (badge) { badge.textContent = sj.status; badge.className = `status-badge ${sj.status}`; }
                    // The race just closed under an open pane: the scripted
                    // mock overlay no longer applies (and its toggle is gone
                    // post-finish), so drop it instead of leaving it stranded.
                    if (["finished", "abandoned"].includes(sj.status)) { try { clearSimOverlay(); } catch {} }
                }
            } catch {}
        };
        sessDetailTimers.push(setInterval(tickStatus, 15000));
        if (typeof avoidPanelOverlap === "function") avoidPanelOverlap(document.getElementById("session-panel"));
    } catch {
        el.innerHTML = '<div class="boat-info-err">Failed to load session.</div>';
    }
}

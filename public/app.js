const map = L.map('map').setView([39.92, 9.65], 13);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '&copy; OpenStreetMap',
        referrerPolicy: 'strict-origin-when-cross-origin'
    }
).addTo(map);

// Remember last map position across reloads
let restoredMapView = false;
try {
    const saved = JSON.parse(localStorage.getItem("indietrotutta:map") || "null");
    if (saved && isFinite(saved.lat) && isFinite(saved.lon)) {
        map.setView([saved.lat, saved.lon], isFinite(saved.zoom) ? saved.zoom : map.getZoom());
        restoredMapView = true;
    }
} catch {}
map.on("moveend", () => {
    try {
        const c = map.getCenter();
        localStorage.setItem("indietrotutta:map", JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() }));
    } catch {}
});

let selectedDeviceIds = new Set();
// compat: keep selectedDeviceId getter for old code paths that expect single
let selectedDeviceId = null;

// --- Per-boat details panels (title = boat name, toggled from the boats list) ---
const boatPanels = new Map(); // deviceId -> { id, control, point, expanded, open }
let panelsToRestore = new Set(); // open panels persisted across reloads
let allPoints = [];
function boatDisplayName(id, fallbackPoint) {
    const d = lastDevices.find(x => x.deviceId === id);
    const name = (d && d.username) || (fallbackPoint && fallbackPoint.username) || null;
    return name || (id ? id.slice(-5) : "-");
}
function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function getBoatPanel(id) {
    let panel = boatPanels.get(id);
    if (!panel) {
        const control = L.control({ position: "topright" });
        control.onAdd = function () {
            this._div = L.DomUtil.create("div", "gps-info boat-panel");
            this._div.style.display = "none";
            return this._div;
        };
        control.addTo(map);
        panel = { id, control, point: null, expanded: false, open: false };
        boatPanels.set(id, panel);
        makePanelDraggable(control._div);
        control._div.addEventListener("click", e => e.stopPropagation());
    }
    return panel;
}
function renderBoatPanel(panel) {
    const div = panel.control._div;
    const p = panel.point;
    if (!panel.open || !p) { div.style.display = "none"; panel.renderedKey = null; return; }
    const name = boatDisplayName(panel.id, p);
    // skip rebuild when nothing changed — keeps links clickable during playback
    const key = `${name}|${p.id ?? p.timestamp}|${panel.expanded}`;
    if (panel.renderedKey === key && div.style.display !== "none") return;
    panel.renderedKey = key;
    div.innerHTML = `
        <h4>${boatDisplayName(panel.id, p)} <span style="float:right;cursor:pointer" onclick="closeBoatPanel('${panel.id}')">×</span><span style="float:right;cursor:pointer;margin-right:8px" title="Boat info" onclick="openBoatInfo('${panel.id}')">ⓘ</span><span style="float:right;cursor:pointer;margin-right:8px" title="Center map on boat" onclick="centerBoatOnMap('${panel.id}')">⌖</span></h4>
        <table>
            <tr><td>Speed</td><td>${typeof p.speed === "number" ? p.speed.toFixed(1) : "-"} knots</td></tr>
            <tr><td>Course</td><td>${p.course ?? "-"}°</td></tr>
            <tr><td>Time</td><td>${fmtTime(p.timestamp || p.receivedAt)}</td></tr>
            ${boatRecord(panel.id)?.boat ? `<tr><td>Boat</td><td>${boatRecord(panel.id).boat}</td></tr>` : ""}
            ${panel.expanded ? `
            <tr><td>Lat</td><td>${p.lat.toFixed(6)}</td></tr>
            <tr><td>Lon</td><td>${p.lon.toFixed(6)}</td></tr>
            <tr><td>Sats</td><td>${p.sats ?? "-"}</td></tr>
            <tr><td>Altitude</td><td>${p.altitude ?? "-"} m</td></tr>` : ""}
        </table>
        <a href="#" style="font-size:12px;color:#2563eb" onclick="toggleBoatMore(event,'${panel.id}');return false">${panel.expanded ? "less..." : "more..."}</a>
    `;
    div.style.display = "block";
}
window.toggleBoatMore = function (e, id) {
    if (e) e.stopPropagation();
    const panel = getBoatPanel(id);
    panel.expanded = !panel.expanded;
    renderBoatPanel(panel);
};
window.closeBoatPanel = function (id) {
    const panel = boatPanels.get(id);
    if (panel) { panel.open = false; renderBoatPanel(panel); }
};
window.centerBoatOnMap = function (id) {
    const panel = boatPanels.get(id);
    const p = (panel && panel.point) || currentPointForBoat(id);
    if (!p || typeof p.lat !== "number" || typeof p.lon !== "number") return;
    map.setView([p.lat, p.lon], map.getZoom());
};
// --- Boat info modal (view + edit name / make-model) ---
function boatRecord(id) {
    return lastDevices.find(x => x.deviceId === id) || null;
}
window.openBoatInfo = function (id) {
    const d = boatRecord(id) || {};
    const panel = boatPanels.get(id);
    const p = (panel && panel.point) || currentPointForBoat(id) || {};
    let overlay = document.getElementById("boat-info-overlay");
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.id = "boat-info-overlay";
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    overlay.innerHTML = `
        <div class="boat-info-card">
            <h4>Boat info <span style="float:right;cursor:pointer" onclick="closeBoatInfo()">×</span></h4>
            <label>Boat name<input id="boat-info-name" maxlength="32" value="${esc(d.username || p.username || "")}" placeholder="e.g. Ciccio"></label>
            <label>Make / model<input id="boat-info-boat" maxlength="64" value="${esc(d.boat || "")}" placeholder="e.g. First 27.7"></label>
            <table>
                <tr><td>Device</td><td>${esc(id)}</td></tr>
                <tr><td>Status</td><td>${esc(d.status || "-")}</td></tr>
                <tr><td>Firmware</td><td>${d.firmware ? "v" + esc(d.firmware) : "-"}</td></tr>
                <tr><td>Last seen</td><td>${d.lastSeen ? esc(new Date(d.lastSeen).toLocaleString()) : "-"}</td></tr>
                <tr><td>First seen</td><td>${d.firstSeen ? esc(new Date(d.firstSeen).toLocaleString()) : "-"}</td></tr>
            </table>
            <div id="boat-info-err" class="boat-info-err"></div>
            <div class="boat-info-actions">
                <button id="boat-info-cancel">Cancel</button>
                <button id="boat-info-save" class="primary">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeBoatInfo(); });
    document.getElementById("boat-info-cancel").addEventListener("click", () => closeBoatInfo());
    document.getElementById("boat-info-save").addEventListener("click", () => saveBoatInfo(id));
};
window.closeBoatInfo = function () {
    document.getElementById("boat-info-overlay")?.remove();
};
window.saveBoatInfo = async function (id) {
    const errEl = document.getElementById("boat-info-err");
    const username = document.getElementById("boat-info-name").value.trim();
    const boat = document.getElementById("boat-info-boat").value.trim();
    if (!username) { errEl.textContent = "Boat name required."; return; }
    errEl.textContent = "";
    try {
        const res = await fetch(`/boats/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, boat }),
        });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            errEl.textContent = j.error || `Save failed (${res.status})`;
            return;
        }
        closeBoatInfo();
        await refreshDevices();
        updateOpenPanels();
    } catch (e) {
        errEl.textContent = "Network error.";
    }
};
// --- Per-boat sailing-days calendar (days with track data → click filters main view) ---
let boatCalState = null; // { deviceId, counts: Map<day,count>, viewY, viewM }
window.openBoatCalendar = async function (id) {
    if (!id) return;
    const color = colorForDevice(id);
    const name = boatDisplayName(id);
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    let overlay = document.getElementById("boat-cal-overlay");
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.id = "boat-cal-overlay";
    overlay.innerHTML = `
        <div class="boat-cal-card">
            <h4>📅 ${esc(name)} <span style="float:right;cursor:pointer" onclick="closeBoatCalendar()">×</span></h4>
            <div id="boat-cal-body"><div class="device-meta">Loading days…</div></div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeBoatCalendar(); });
    let days = [];
    try {
        const res = await fetch(`/gps/days?deviceId=${encodeURIComponent(id)}`);
        if (res.ok) days = await res.json();
    } catch (e) {
        const body = document.getElementById("boat-cal-body");
        if (body) body.innerHTML = '<div class="boat-info-err">Network error.</div>';
        return;
    }
    const counts = new Map((Array.isArray(days) ? days : []).map(d => [d.day, d.count]));
    const now = new Date();
    let viewY = now.getFullYear(), viewM = now.getMonth();
    // jump to the latest active month when the current month has no data
    const hasInMonth = (y, m) => [...counts.keys()].some(k => {
        const [ky, km] = k.split("-").map(Number);
        return ky === y && km === m + 1;
    });
    if (counts.size && !hasInMonth(viewY, viewM)) {
        const last = [...counts.keys()].sort().pop().split("-").map(Number);
        viewY = last[0]; viewM = last[1] - 1;
    }
    boatCalState = { deviceId: id, color, counts, viewY, viewM };
    renderBoatCalendar();
};
window.closeBoatCalendar = function () {
    document.getElementById("boat-cal-overlay")?.remove();
    boatCalState = null;
};
window.boatCalNav = function (delta) {
    if (!boatCalState) return;
    const d = new Date(boatCalState.viewY, boatCalState.viewM + delta, 1);
    boatCalState.viewY = d.getFullYear();
    boatCalState.viewM = d.getMonth();
    renderBoatCalendar();
};
function renderBoatCalendar() {
    const st = boatCalState;
    const body = document.getElementById("boat-cal-body");
    if (!st || !body) return;
    const monthName = new Date(st.viewY, st.viewM, 1).toLocaleDateString([], { month: "long", year: "numeric" });
    const daysInMonth = new Date(st.viewY, st.viewM + 1, 0).getDate();
    const lead = (new Date(st.viewY, st.viewM, 1).getDay() + 6) % 7; // Monday start
    const todayKey = `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}-${pad2(new Date().getDate())}`;
    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<span class="boat-cal-empty"></span>`;
    for (let d = 1; d <= daysInMonth; d++) {
        const key = `${st.viewY}-${pad2(st.viewM + 1)}-${pad2(d)}`;
        const count = st.counts.get(key);
        const isToday = key === todayKey ? " boat-cal-today" : "";
        if (count) {
            cells += `<span class="boat-cal-day boat-cal-active${isToday}" title="${count} points — click to view" onclick="boatCalPick('${key}')" style="background:${lightenColor(st.color, 0.85)};border-color:${st.color}">${d}</span>`;
        } else {
            cells += `<span class="boat-cal-day${isToday}">${d}</span>`;
        }
    }
    body.innerHTML = `
        <div class="boat-cal-nav">
            <button onclick="boatCalNav(-1)" title="Previous month">◀</button>
            <b>${monthName}</b>
            <button onclick="boatCalNav(1)" title="Next month">▶</button>
        </div>
        <div class="boat-cal-grid">
            ${["M", "T", "W", "T", "F", "S", "S"].map(w => `<span class="boat-cal-wd">${w}</span>`).join("")}
            ${cells}
        </div>
        <div class="device-meta" style="margin-top:8px">Days in <span style="font-weight:700;color:${st.color}">■</span> boat color have track data — click one to filter.</div>
    `;
}
// Picking a day sets the main screen start/end filters to that full UTC day
window.boatCalPick = function (dayStr) {
    const st = boatCalState;
    if (!st) return;
    const id = st.deviceId;
    closeBoatCalendar();
    // make sure the boat is selected so its track shows
    selectedDeviceIds.add(id);
    syncSelected();
    stopPlayback();
    isLive = false;
    liveBtn.classList.remove("active");
    timePreset = "custom";
    if (presetSelect) presetSelect.value = "custom";
    // cover the full UTC day (backend groups days in UTC) — round-trip via local picker values
    customStart = toLocalDatetimeValue(new Date(dayStr + "T00:00:00.000Z"));
    customEnd = toLocalDatetimeValue(new Date(dayStr + "T23:59:59.999Z"));
    if (startPicker) startPicker.value = customStart;
    if (endPicker) endPicker.value = customEnd;
    updateTimeControlsVisibility();
    syncDateLabel();
    saveUI();
    playbackTime = new Date(customStart).getTime();
    refresh(true);
};
function openBoatPanel(id, point) {
    if (!id) return;
    const panel = getBoatPanel(id);
    panel.open = true;
    if (point) panel.point = point;
    else if (!panel.point) panel.point = currentPointForBoat(id);
    renderBoatPanel(panel);
}
function toggleBoatPanel(id) {
    const panel = getBoatPanel(id);
    if (panel.open) { panel.open = false; renderBoatPanel(panel); }
    else openBoatPanel(id);
}
// Boat's current point: follow playback cursor when playing/history, else latest
function currentPointForBoat(id) {
    const pts = allPoints.filter(p => p.deviceId === id);
    if (!pts.length) return null;
    if (playbackTimer || !isLive) {
        let cur = null;
        for (const p of pts) {
            if (new Date(p.timestamp || p.receivedAt).getTime() <= playbackTime) cur = p;
            else break;
        }
        return cur || pts[0];
    }
    return pts[pts.length - 1];
}
function updateOpenPanels() {
    boatPanels.forEach(panel => {
        if (!panel.open) return;
        const cur = currentPointForBoat(panel.id);
        if (cur) panel.point = cur;
        renderBoatPanel(panel);
    });
}
function closeAllBoatPanels() {
    boatPanels.forEach(panel => { panel.open = false; renderBoatPanel(panel); });
}

// Boat panels: draggable by header (close button excluded)
function makePanelDraggable(el) {
    if (!el) return;
    let drag = null;
    const onHeader = e => {
        const h = e.target && e.target.closest && e.target.closest("h4");
        const c = e.target && e.target.closest && e.target.closest("h4 span");
        return !!(h && !c);
    };
    el.addEventListener("touchstart", e => { if (onHeader(e)) e.stopPropagation(); }, { passive: true });
    el.addEventListener("pointerdown", e => {
        if (!onHeader(e)) return;
        const r = el.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        el.style.position = "fixed";
        el.style.left = r.left + "px";
        el.style.top = r.top + "px";
        el.style.margin = "0";
        el.style.zIndex = "2000";
        if (map.dragging) map.dragging.disable();
        try { el.setPointerCapture(e.pointerId); } catch {}
        e.stopPropagation();
        e.preventDefault();
    });
    el.addEventListener("pointermove", e => {
        if (!drag) return;
        el.style.left = (e.clientX - drag.dx) + "px";
        el.style.top = (e.clientY - drag.dy) + "px";
        e.stopPropagation();
    });
    const end = () => {
        if (!drag) return;
        drag = null;
        if (map.dragging) map.dragging.enable();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
}

// Click on or near a route point → show Details, else close
function findNearestPoint(latlng, maxMeters = 80) {
    if (!allPoints.length) return null;
    let best = null, bestDist = Infinity;
    allPoints.forEach(p => {
        const d = map.distance(latlng, L.latLng(p.lat, p.lon));
        if (d < bestDist && d < maxMeters) { bestDist = d; best = p; }
    });
    return best;
}
// Center only when the point is outside the current viewport
function panToIfOutside(pos) {
    if (!pos) return;
    if (!map.getBounds().contains([pos.lat, pos.lon])) map.panTo([pos.lat, pos.lon]);
}
// Route click → timeline jumps to that point's moment (cursor, markers, details follow)
function jumpTimelineTo(p) {
    const t = new Date(p.timestamp || p.receivedAt).getTime();
    if (isNaN(t)) return;
    const bounds = getDayBounds();
    if (t < bounds.start || t > bounds.end) return;
    showTime(t);
}
// Hover: a dot on the route + a dot on the timeline for the hovered point
let hoverMarker = null;
const timelineHoverEl = document.getElementById("timeline-hover");
function showHoverPoint(p) {
    if (hoverMarker) map.removeLayer(hoverMarker);
    hoverMarker = L.circleMarker([p.lat, p.lon], {
        color: "#ffffff", weight: 2, fillColor: colorForDevice(p.deviceId), fillOpacity: 1, radius: 6
    }).addTo(map);
    if (timelineHoverEl) {
        const t = new Date(p.timestamp || p.receivedAt).getTime();
        const bounds = getDayBounds();
        const dayMs = bounds.end - bounds.start || 1;
        if (!isNaN(t) && t >= bounds.start && t <= bounds.end) {
            timelineHoverEl.style.display = "block";
            timelineHoverEl.style.left = ((t - bounds.start) / dayMs * 100) + "%";
            timelineHoverEl.style.background = colorForDevice(p.deviceId);
            // center on this boat's stripe (same order/geometry as updateTimelineTracks)
            const order = selectedDeviceIds.size ? [...selectedDeviceIds] : [...new Set(allPoints.map(q => q.deviceId))];
            timelineHoverEl.style.top = (4 + Math.max(0, order.indexOf(p.deviceId)) * (32 + 6) + 16) + "px";
        } else {
            timelineHoverEl.style.display = "none";
        }
    }
}
function hideHover() {
    if (hoverMarker) { map.removeLayer(hoverMarker); hoverMarker = null; }
    if (timelineHoverEl) timelineHoverEl.style.display = "none";
}
map.on("click", e => {
    if (typeof sessSuppressClick !== "undefined" && sessSuppressClick) { sessSuppressClick = false; return; }
    if (typeof builderMapClick === "function" && builderMapClick(e)) return;
    const nearest = findNearestPoint(e.latlng);
    if (nearest) { openBoatPanel(nearest.deviceId, nearest); jumpTimelineTo(nearest); }
    else closeAllBoatPanels();
});
// Hover anywhere on the map (wide radius — thin route lines are hard to hit)
map.on("mousemove", e => {
    if (typeof CB !== "undefined" && CB.open && CB.placing) return; // builder gesture in progress
    const n = findNearestPoint(e.latlng, 100);
    if (n) showHoverPoint(n);
    else hideHover();
});
map.on("mouseout", hideHover);


let marker = null;
let polyline = null;
let polylines = [];
let flaggedMarkers = [];
let fleetMarkers = [];

const palette = ["#e41a1c","#377eb8","#4daf4a","#984ea3","#ff7f00","#a65628","#f781bf","#1f77b4"];
const colorMap = new Map();
function colorForDevice(id) {
    if (!id) return palette[0];
    if (colorMap.has(id)) return colorMap.get(id);    // assign next distinct color in order, fallback to hash if palette exhausted
    if (colorMap.size < palette.length) {
        const c = palette[colorMap.size];
        colorMap.set(id, c);
        return c;
    }
    let h = 0; for (let i=0;i<id.length;i++) h = (h*31 + id.charCodeAt(i)) >>> 0;
    const c = palette[h % palette.length];
    colorMap.set(id, c);
    return c;
}
function lightenColor(hex, amt = 0.85) {
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), b = parseInt(c.substring(4, 6), 16);
    const nr = Math.round(r + (255 - r) * amt), ng = Math.round(g + (255 - g) * amt), nb = Math.round(b + (255 - b) * amt);
    return `rgb(${nr},${ng},${nb})`;
}

function boatTriangleIcon(deviceId, courseDeg) {
    const color = colorForDevice(deviceId);
    const deg = (typeof courseDeg === "number" && !isNaN(courseDeg)) ? courseDeg : 0;
    const html = `<div style="transform:rotate(${deg}deg);width:20px;height:20px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.45))"><svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block"><path d="M12 2.5 L19.5 19.5 L12 15.8 L4.5 19.5 Z" fill="${color}" stroke="white" stroke-width="1.3" stroke-linejoin="round"/></svg></div>`;
    return L.divIcon({ html, className: "boat-triangle", iconSize: [20, 20], iconAnchor: [10, 10] });
}

const UI_KEY = "indietrotutta:ui";
function syncSelected() { selectedDeviceId = selectedDeviceIds.size ? [...selectedDeviceIds][0] : null; }
function saveUI() {
    try {
        const data = {
            selectedDeviceIds: [...selectedDeviceIds],
            selectedDeviceId: selectedDeviceId, // compat
            isLive,
            selectedDate, // compat
            timePreset,
            customStart,
            customEnd,
            boatFilter: document.getElementById("boatFilter")?.value || "",
            panels: {
                "device-panel": document.getElementById("device-panel")?.style.display,
                "playback": document.getElementById("playback")?.style.display,
                "template-panel": document.getElementById("template-panel")?.style.display,
                "session-panel": document.getElementById("session-panel")?.style.display,
            },
            panelPos: ["device-panel", "template-panel", "session-panel", "builder-panel"].reduce((acc, id) => {
                const el = document.getElementById(id);
                if (el && el.style.left && el.style.top) acc[id] = { left: el.style.left, top: el.style.top };
                return acc;
            }, {}),
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
        const d = JSON.parse(raw);
        if (Array.isArray(d.selectedDeviceIds)) { selectedDeviceIds = new Set(d.selectedDeviceIds); syncSelected(); }
        else if (d.selectedDeviceId) { selectedDeviceIds = new Set([d.selectedDeviceId]); syncSelected(); }
        if (typeof d.isLive === "boolean") isLive = d.isLive;
        if (d.selectedDate) selectedDate = d.selectedDate;
        if (d.timePreset) timePreset = d.timePreset;
        else if (d.selectedDate && d.selectedDate !== todayStr()) timePreset = "custom"; // migrate old date
        if (d.customStart) customStart = d.customStart;
        if (d.customEnd) customEnd = d.customEnd;
        if (d.boatFilter !== undefined) { const el=document.getElementById("boatFilter"); if(el) el.value=d.boatFilter; }
        if (d.panels) Object.entries(d.panels).forEach(([id, disp]) => {
            if (id === "session-panel") return; // sessions always start closed
            const el=document.getElementById(id); if(el && disp) el.style.display=disp;
        });
        if (d.panelPos) Object.entries(d.panelPos).forEach(([id, pos]) => {
            const el = document.getElementById(id);
            if (el && pos && isFinite(parseFloat(pos.left)) && isFinite(parseFloat(pos.top))) {
                el.style.left = Math.max(0, Math.min(parseFloat(pos.left), window.innerWidth - 60)) + "px";
                el.style.top = Math.max(0, parseFloat(pos.top)) + "px";
                el.dataset.moved = "1"; // restored = user-owned, cascade leaves it alone
            }
        });
        // restore boats button active state
        const dp=document.getElementById("device-panel"), bb=document.getElementById("boatsToggleBtn");
        if(dp && bb) bb.classList.toggle("active", dp.style.display!=="none" && dp.style.display!=="");
        // open boat panels persisted from previous session (applied after first data load)
        if (Array.isArray(d.openPanels)) panelsToRestore = new Set(d.openPanels);
    } catch {}
}

// --- Controls: Live vs range (rich time selector) ---
const liveBtn = document.getElementById("liveBtn");
const presetSelect = document.getElementById("presetSelect");
const startPicker = document.getElementById("startPicker");
const endPicker = document.getElementById("endPicker");
const applyRangeBtn = document.getElementById("applyRangeBtn");
const rangeSep = document.getElementById("rangeSep");
const dateLabel = document.getElementById("dateLabel");
// compat: old datePicker removed — keep variable for legacy code
const datePicker = { value: "" };

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}
function pad2(n){ return String(n).padStart(2,"0"); }
function toLocalDatetimeValue(d){
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d){ const x=new Date(d); x.setHours(23,59,59,999); return x; }
function startOfWeek(d){
    const x=new Date(d); const day=x.getDay(); const diff= day===0?6:day-1; // Monday start
    x.setDate(x.getDate()-diff); x.setHours(0,0,0,0); return x;
}
function computeRangeForPreset(preset, cStart, cEnd){
    const now=new Date();
    if(preset==="today") return { start: startOfDay(now).getTime(), end: endOfDay(now).getTime() };
    if(preset==="yesterday"){ const y=new Date(now); y.setDate(y.getDate()-1); return { start: startOfDay(y).getTime(), end: endOfDay(y).getTime() }; }
    if(preset==="thisWeek") return { start: startOfWeek(now).getTime(), end: endOfDay(now).getTime() };
    if(preset==="custom" && cStart && cEnd){
        const s=new Date(cStart), e=new Date(cEnd);
        if(!isNaN(s.getTime()) && !isNaN(e.getTime())) return { start: s.getTime(), end: e.getTime() };
    }
    return { start: startOfDay(now).getTime(), end: endOfDay(now).getTime() };
}
function formatRangeLabel(startMs, endMs){
    const s=new Date(startMs), e=new Date(endMs);
    const sameDay = s.toDateString()===e.toDateString();
    const sd = s.toLocaleDateString(); const st=s.toLocaleTimeString().slice(0,5);
    const ed = e.toLocaleDateString(); const et=e.toLocaleTimeString().slice(0,5);
    if(sameDay) return `${sd} ${st} → ${et}`;
    return `${sd} ${st} → ${ed} ${et}`;
}

let isLive = true;
let selectedDate = todayStr(); // compat
let timePreset = "today";
let customStart = "";
let customEnd = "";
// init defaults then override via loadUI
loadUI();
// ensure defaults if loadUI missing values
if(!timePreset) timePreset="today";
if(presetSelect) presetSelect.value = timePreset;
// if legacy selectedDate was custom, hydrate custom inputs
if(timePreset==="custom" && selectedDate && !customStart){
    const d=new Date(selectedDate+"T00:00"); if(!isNaN(d.getTime())){ customStart=toLocalDatetimeValue(startOfDay(d)); customEnd=toLocalDatetimeValue(endOfDay(d)); }
}
if(startPicker) startPicker.value = customStart;
if(endPicker) endPicker.value = customEnd;

function updateTimeControlsVisibility(){
    const isCustom = timePreset==="custom" && !isLive;
    if(presetSelect) presetSelect.style.display = isLive ? "none" : "";
    if(startPicker) startPicker.style.display = isCustom ? "" : "none";
    if(rangeSep) rangeSep.style.display = isCustom ? "" : "none";
    if(endPicker) endPicker.style.display = isCustom ? "" : "none";
    if(applyRangeBtn) applyRangeBtn.style.display = isCustom ? "" : "none";
    if(presetSelect) presetSelect.disabled = !!isLive;
}
function syncDateLabel(count){
    const suffix = typeof count==="number" ? ` (${count})` : "";
    if(isLive){ dateLabel.textContent = `Live — Today${suffix}`; return; }
    const range = computeRangeForPreset(timePreset, customStart, customEnd);
    if(timePreset==="today") dateLabel.textContent = `Today${suffix}`;
    else if(timePreset==="yesterday") dateLabel.textContent = `Yesterday${suffix}`;
    else if(timePreset==="thisWeek") dateLabel.textContent = `This week${suffix}`;
    else if(timePreset==="custom") dateLabel.textContent = `${formatRangeLabel(range.start, range.end)}${suffix}`;
    else dateLabel.textContent = `${formatRangeLabel(range.start, range.end)}${suffix}`;
}
function getCurrentRange(){
    if(isLive){
        const now=new Date(); return { start: startOfDay(now).getTime(), end: endOfDay(now).getTime() };
    }
    return computeRangeForPreset(timePreset, customStart, customEnd);
}

updateTimeControlsVisibility();
syncDateLabel();
if (isLive) liveBtn.classList.add("active"); else liveBtn.classList.remove("active");
if (presetSelect) presetSelect.value = timePreset;

liveBtn.addEventListener("click", () => {
    // any Live click hides the timeline (toggle deactivates via observer)
    stopPlayback();
    document.getElementById("playback").style.display = "none";
    isLive = !isLive;
    if(isLive){
        liveBtn.classList.add("active");
        updateTimeControlsVisibility();
        syncDateLabel();
        saveUI();
        refresh(true);
    } else {
        liveBtn.classList.remove("active");
        updateTimeControlsVisibility();
        syncDateLabel();
        saveUI();
        refresh(true);
    }
});

if(presetSelect) presetSelect.addEventListener("change", () => {
    timePreset = presetSelect.value;
    isLive = false;
    liveBtn.classList.remove("active");
    // if switching to custom and no values, seed with today range
    if(timePreset==="custom" && (!customStart || !customEnd)){
        const r=computeRangeForPreset("today"); customStart=toLocalDatetimeValue(new Date(r.start)); customEnd=toLocalDatetimeValue(new Date(r.end));
        if(startPicker) startPicker.value=customStart; if(endPicker) endPicker.value=customEnd;
    }
    // keep compat selectedDate for custom
    if(timePreset==="custom"){ const r=computeRangeForPreset(timePreset, customStart, customEnd); selectedDate=new Date(r.start).toISOString().slice(0,10); }
    updateTimeControlsVisibility();
    syncDateLabel();
    saveUI();
    refresh(true);
});

function applyCustomRange(){
    if(startPicker) customStart=startPicker.value;
    if(endPicker) customEnd=endPicker.value;
    if(timePreset!=="custom"){ timePreset="custom"; if(presetSelect) presetSelect.value="custom"; }
    isLive=false; liveBtn.classList.remove("active");
    updateTimeControlsVisibility();
    syncDateLabel();
    saveUI();
    refresh(true);
}
if(startPicker) startPicker.addEventListener("change", applyCustomRange);
if(endPicker) endPicker.addEventListener("change", applyCustomRange);
if(applyRangeBtn) applyRangeBtn.addEventListener("click", applyCustomRange);

// Manual recenter — explicit viewport jump to the track. Interval
// refreshes never touch the viewport, so free panning is preserved.
document.getElementById("recenterBtn")?.addEventListener("click", () => {
    refresh(true);
});

let lastDevices = [];
// --- Device list ---
async function refreshDevices() {
    try {
        const res = await fetch("/boats");
        const devices = await res.json();
        lastDevices = devices;
        const list = document.getElementById("device-list");
        const filterEl = document.getElementById("boatFilter");
        const q = filterEl ? filterEl.value.toLowerCase().trim() : "";
        let filtered = devices;
        if (q) filtered = devices.filter(d => (d.username||"").toLowerCase().includes(q) || (d.deviceId||"").toLowerCase().includes(q));

        if (devices.length === 0) {
            list.innerHTML = '<div class="device-meta">No boats yet</div>';
            return;
        }
        if (filtered.length === 0) {
            list.innerHTML = '<div class="device-meta">No boats matching filter</div>';
            return;
        }

        function lighten(hex, amt=0.85) {
            const c = hex.replace('#','');
            const r = parseInt(c.substring(0,2),16), g = parseInt(c.substring(2,4),16), b = parseInt(c.substring(4,6),16);
            const nr = Math.round(r + (255-r)*amt), ng = Math.round(g + (255-g)*amt), nb = Math.round(b + (255-b)*amt);
            return `rgb(${nr},${ng},${nb})`;
        }
        list.innerHTML = filtered.map(d => {
            const status = d.status || "offline";
            const isActive = selectedDeviceIds.has(d.deviceId);
            const name = d.username || d.deviceId || "-";
            const lastSeen = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "-";
            const routeColor = colorForDevice(d.deviceId);
            const lightBg = lighten(routeColor, 0.85);
            const statusColor = status === "live" ? "#16a34a" : status === "idle" ? "#f59e0b" : "#9ca3af";
            return `
                <div class="device-item ${isActive ? "active" : ""}" data-id="${d.deviceId}" style="cursor:pointer">
                    <div style="display:flex;align-items:center;gap:8px;overflow:hidden;flex:1">
                        <input type="checkbox" ${isActive ? "checked" : ""} data-check="${d.deviceId}" style="accent-color:${routeColor};width:14px;height:14px;flex-shrink:0">
                        <span class="device-name" style="border:1.5px solid ${routeColor};background:${lightBg};padding:2px 7px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${name}</span>
                    </div>
                    <div style="text-align:right">
                        <div class="device-meta" style="color:${statusColor};font-weight:600">${status} <span class="boat-cal-btn" data-cal="${d.deviceId}" title="Sailing days calendar">📅</span></div>
                        <div class="device-meta">${lastSeen}${d.firmware ? ` • v${d.firmware}` : ""}</div>
                    </div>
                </div>
            `;
        }).join("");

        // multi-select boats: each checkbox toggles independently
        list.querySelectorAll("input[data-check]").forEach(cb => {
            cb.addEventListener("click", e => e.stopPropagation());
            cb.addEventListener("change", () => {
                const id = cb.getAttribute("data-check");
                if (cb.checked) {
                    selectedDeviceIds.add(id);
                } else {
                    selectedDeviceIds.delete(id);
                }
                syncSelected();
                saveUI();
                updateTimelineTracks();
                refresh(true);
            });
        });
        list.querySelectorAll(".device-item").forEach(el => {
            el.addEventListener("click", e => {
                if (e.target.closest("input[type=checkbox]")) return;
                if (e.target.closest("[data-cal]")) return;
                toggleBoatPanel(el.getAttribute("data-id"));
            });
        });
        list.querySelectorAll("[data-cal]").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                openBoatCalendar(btn.getAttribute("data-cal"));
            });
        });
        // list height changed after async load — re-cascade floating panels
        if (typeof avoidPanelOverlap === "function") avoidPanelOverlap(document.getElementById("device-panel"));

    } catch (e) {
        console.error("devices refresh failed", e);
    }
}

let firstFit = !restoredMapView; // viewport moves only on explicit recenter or first load (skipped when restoring last position)
async function refresh(recenter = false) {

    let points = [];
    if (selectedDeviceIds.size > 0) {
        try {
            const ids = [...selectedDeviceIds];
            const range = getCurrentRange();
            const all = await Promise.all(ids.map(async id => {
                const params = new URLSearchParams();
                params.set("deviceId", id);
                // use rich range (start/end ISO) — backend filters by timestamp
                params.set("start", new Date(range.start).toISOString());
                params.set("end", new Date(range.end).toISOString());
                const r = await fetch(`/gps?${params.toString()}`);
                if (!r.ok) return [];
                return r.json();
            }));
            points = all.flat().sort((a,b) => new Date(a.timestamp||a.receivedAt) - new Date(b.timestamp||b.receivedAt));
            // client-side guard: only keep points inside selected time range
            const _range = getCurrentRange();
            points = points.filter(p => {
                const t = new Date(p.timestamp || p.receivedAt).getTime();
                return !isNaN(t) && t >= _range.start && t <= _range.end;
            });
        } catch (e) {
            console.error("filtered fetch failed", e);
            points = [];
        }
    } else {
        points = [];
    }

    allPoints = points;
    // Update label with count — rich selector
    const filterSuffix = selectedDeviceIds.size ? ` • ${selectedDeviceIds.size} selected` : "";
    syncDateLabel(points.length);
    if (filterSuffix) dateLabel.textContent += filterSuffix;

    if (points.length === 0) {
        if (polyline) { map.removeLayer(polyline); polyline = null; }
        polylines.forEach(l => map.removeLayer(l)); polylines = [];
        if (marker) { map.removeLayer(marker); marker = null; }
        fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
        flaggedMarkers.forEach(m => m.remove());
        flaggedMarkers = [];
        hideHover();
        return;
    }

    // clear previous tracks
    if (polyline) { map.removeLayer(polyline); polyline = null; }
    polylines.forEach(l => map.removeLayer(l)); polylines = [];
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
    hideHover();

    // multi-select: one polyline per boat, each with its route color
    const byDevice = new Map();
    points.forEach(p => {
        const id = p.deviceId || "unknown";
        if (!byDevice.has(id)) byDevice.set(id, []);
        byDevice.get(id).push([p.lat, p.lon]);
    });
    byDevice.forEach((latlngs, id) => {
        const line = L.polyline(latlngs, { color: colorForDevice(id), weight: 2, opacity: 0.6 }).addTo(map);
        line.on("click", e => { const n = findNearestPoint(e.latlng); if (n) { openBoatPanel(n.deviceId, n); jumpTimelineTo(n); L.DomEvent.stop(e); } });
        if (selectedDeviceIds.size === 1 && id === [...selectedDeviceIds][0]) {
            polyline = line;
        } else {
            polylines.push(line);
        }
    });
    // keep single polyline reference for fitBounds when single selection
    if (selectedDeviceIds.size === 1 && polyline) {
        // already set
    } else if (selectedDeviceIds.size > 0 && polylines.length === 1 && !polyline) {
        polyline = polylines[0];
        polylines = [];
    }

    flaggedMarkers.forEach(m => m.remove());
    flaggedMarkers = points
        .filter(p => p.flagged)
        .map(p => L.circleMarker([p.lat, p.lon], {
            color: "#dc2626",
            fillColor: "#ef4444",
            fillOpacity: 0.9,
            radius: 8,
            weight: 2
        })
            .addTo(map)
            .bindPopup(`Flagged position${p.username
                ? `<br><b>${p.username}</b>`
                : ""}<br>${p.timestamp}`));

    const latest = points[points.length - 1];

    if (marker) { map.removeLayer(marker); marker = null; }
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];

    if (selectedDeviceIds.size > 0) {
        const latestByDevice = new Map();
        points.forEach(p => latestByDevice.set(p.deviceId, p));
        latestByDevice.forEach(p => {
            if (!selectedDeviceIds.has(p.deviceId)) return;
            const m = L.marker([p.lat, p.lon], { icon: boatTriangleIcon(p.deviceId, p.course) }).addTo(map).bindPopup(p.username ? `Latest<br><b>${p.username}</b><br><small>${p.deviceId.slice(-5)}</small>` : `Latest<br>${p.deviceId}`);
            m.on("click", () => openBoatPanel(p.deviceId, p));
            fleetMarkers.push(m);
        });
        // keep single marker ref for single selection compat
        if (fleetMarkers.length === 1) { marker = fleetMarkers[0]; fleetMarkers = []; }
    } else {
        const latestByDevice = new Map();
        points.forEach(p => latestByDevice.set(p.deviceId, p));
        latestByDevice.forEach(p => {
            const m = L.marker([p.lat, p.lon], { icon: boatTriangleIcon(p.deviceId, p.course) }).addTo(map).bindPopup(p.username ? `Latest<br><b>${p.username}</b><br><small>${p.deviceId.slice(-5)}</small>` : `Latest<br>${p.deviceId}`);
            m.on("click", () => openBoatPanel(p.deviceId, p));
            fleetMarkers.push(m);
        });
    }

    // Viewport: move only on explicit request (recenter=true) or first
    // load. Live interval ticks update tracks in place and never pan/fit,
    // so free panning/zooming is preserved.
    if (selectedDeviceIds.size > 0) {
        const allLatLngs = points.filter(p=> selectedDeviceIds.has(p.deviceId)).map(p => [p.lat, p.lon]);
        const bounds = L.latLngBounds(allLatLngs.length ? allLatLngs : points.map(p => [p.lat, p.lon]));
        if (recenter || firstFit) {
            map.fitBounds(bounds, { padding: [20, 20] });
            firstFit = false;
        }
    } else {
        const allLatLngs = points.map(p => [p.lat, p.lon]);
        const bounds = L.latLngBounds(allLatLngs);
        if (recenter || firstFit) {
            map.fitBounds(bounds, { padding: [20, 20] });
            firstFit = false;
        }
    }

    // Open boat panels follow their boat (playback cursor or latest)
    if (panelsToRestore.size && points.length) {
        panelsToRestore.forEach(id => openBoatPanel(id));
        panelsToRestore.clear();
    }
    updateOpenPanels();
}

refresh(true);
refreshDevices();

setInterval(() => {
    refreshDevices();
    if (isLive && !playbackTimer) refresh();
}, 5000);

// Also refresh when tab becomes visible
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refresh(); refreshDevices(); }
});

// --- Playback (south anchored timeline, time-based, interpolated) ---
const playBtn = document.getElementById("playBtn");
const playSlider = document.getElementById("playSlider");
const playSpeedSel = document.getElementById("playSpeed");
const playLabel = document.getElementById("playLabel");
const playTimeEl = document.getElementById("playTime");
const timelineTracksEl = document.getElementById("timeline-tracks");
const timelineCursorEl = document.getElementById("timeline-cursor");

let playbackPoints = []; // kept for compat, now allPoints is source
let playbackTime = null;
let playbackTimer = null;
let playbackSpeed = 1;
let playbackMarkers = new Map(); // deviceId -> circleMarker

// Gap larger than this splits activity into separate trips (idle stillness)
const IDLE_GAP_MS = 5 * 60 * 1000; // 5 minutes — gps is ~40s, so >5min = idle/transport

function getTripsForDevice(deviceId) {
    const pts = allPoints.filter(p=>p.deviceId===deviceId).sort((a,b)=> new Date(a.timestamp)-new Date(b.timestamp));
    if (!pts.length) return [];
    const trips = [];
    let cur = [pts[0]];
    for (let i=1;i<pts.length;i++) {
        const gap = new Date(pts[i].timestamp).getTime() - new Date(pts[i-1].timestamp).getTime();
        if (gap > IDLE_GAP_MS) {
            trips.push(cur);
            cur = [pts[i]];
        } else {
            cur.push(pts[i]);
        }
    }
    trips.push(cur);
    return trips;
}

function getDayBounds() {
    const r = getCurrentRange();
    return { start: r.start, end: r.end };
}
function updateTimelineTracks() {
    if (!timelineTracksEl) return;
    // always clear first — stale stripes must not survive selection/data changes
    timelineTracksEl.innerHTML = "";
    const oldSvg = document.getElementById("timeline-speed");
    if (oldSvg) oldSvg.remove();
    const bounds = getDayBounds();
    const dayMs = bounds.end - bounds.start || 1;
    const ids = selectedDeviceIds.size ? [...selectedDeviceIds] : [...new Set(allPoints.map(p=>p.deviceId))];
    if (ids.length === 0) { timelineTracksEl.parentElement.style.height = ""; return; }
    // one stacked stripe per boat
    const stripeH = 32, stripeGap = 6, stripePad = 4;
    const stripeTop = idx => stripePad + idx * (stripeH + stripeGap);
    const totalH = Math.max(40, stripePad * 2 + ids.length * stripeH + Math.max(0, ids.length - 1) * stripeGap);
    ids.forEach((id, idx) => {
        const trips = getTripsForDevice(id);
        if (!trips.length) return;
        const track = document.createElement("div");
        track.className = "timeline-track";
        track.style.top = stripeTop(idx) + "px";
        track.style.bottom = "auto";
        track.style.height = stripeH + "px";
        track.style.background = "#e5e7eb";
        trips.forEach(trip => {
            if (!trip.length) return;
            const tFirst = new Date(trip[0].timestamp).getTime();
            const tLast = new Date(trip[trip.length-1].timestamp).getTime();
            const left = ((tFirst - bounds.start)/dayMs)*100;
            const width = ((tLast - tFirst)/dayMs)*100;
            const seg = document.createElement("div");
            seg.className = "timeline-segment";
            seg.style.left = Math.max(0, left) + "%";
            seg.style.width = Math.max(0.6, width) + "%";
            seg.style.background = lightenColor(colorForDevice(id), 0.85);
            seg.title = `${id} ${new Date(tFirst).toLocaleTimeString()}–${new Date(tLast).toLocaleTimeString()} (${trip.length} pts)`;
            seg.dataset.deviceId = id;
            seg.addEventListener("mousemove", e => {
                const rect = timelineEl.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const b = getDayBounds();
                const timeMs = b.start + ratio * (b.end - b.start);
                let best = null, bestDt = Infinity;
                for (const p of allPoints) {
                    if (p.deviceId !== id) continue;
                    const dt = Math.abs(new Date(p.timestamp || p.receivedAt).getTime() - timeMs);
                    if (dt < bestDt) { bestDt = dt; best = p; }
                }
                if (best) showHoverPoint(best);
            });
            seg.addEventListener("mouseout", hideHover);
            track.appendChild(seg);
        });
        timelineTracksEl.appendChild(track);
    });
    // height — one stripe per boat
    timelineTracksEl.parentElement.style.height = totalH + "px";
    // speed graph overlay: one polyline per trip, normalized to its own
    // stripe so each boat's min/max touch its stripe margins
    const spdPts = [];
    ids.forEach(id => allPoints.filter(p => p.deviceId === id && typeof p.speed === "number" && !isNaN(p.speed)).forEach(p => spdPts.push(p)));
    if (spdPts.length > 1) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.id = "timeline-speed";
        svg.setAttribute("viewBox", `0 0 1000 ${totalH}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1";
        ids.forEach((id, idx) => {
            const top = stripeTop(idx);
            // one polyline per trip — speed lives only where data is present
            getTripsForDevice(id).forEach(trip => {
                const pts = trip.filter(p => typeof p.speed === "number" && !isNaN(p.speed))
                    .sort((a, b) => new Date(a.timestamp || a.receivedAt) - new Date(b.timestamp || b.receivedAt));
                if (pts.length < 2) return;
                let mn = Infinity, mx = -Infinity;
                pts.forEach(p => { if (p.speed < mn) mn = p.speed; if (p.speed > mx) mx = p.speed; });
                const d = pts.map(p => {
                    const t = new Date(p.timestamp || p.receivedAt).getTime();
                    const x = Math.max(0, Math.min(1000, (t - bounds.start) / dayMs * 1000)).toFixed(1);
                    const y = (top + stripeH - 3 - (p.speed - mn) / ((mx - mn) || 1) * (stripeH - 6)).toFixed(1);
                    return `${x},${y}`;
                }).join(" ");
                const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
                pl.setAttribute("points", d);
                pl.setAttribute("fill", "none");
                pl.setAttribute("stroke", colorForDevice(id));
                pl.setAttribute("stroke-width", "2");
                pl.setAttribute("vector-effect", "non-scaling-stroke");
                pl.setAttribute("opacity", "0.9");
                svg.appendChild(pl);
            });
        });
        timelineTracksEl.parentElement.prepend(svg);
    }
}
function interpolatePosition(deviceId, timeMs) {
    const trips = getTripsForDevice(deviceId);
    if (!trips.length) return null;
    const firstTrip = trips[0], lastTrip = trips[trips.length-1];
    const first = new Date(firstTrip[0].timestamp).getTime();
    const last = new Date(lastTrip[lastTrip.length-1].timestamp).getTime();
    if (timeMs <= first) return firstTrip[0];
    if (timeMs >= last) return lastTrip[lastTrip.length-1];
    // Check each trip and idle gap between trips
    for (let ti=0; ti<trips.length; ti++) {
        const trip = trips[ti];
        const tFirst = new Date(trip[0].timestamp).getTime();
        const tLast = new Date(trip[trip.length-1].timestamp).getTime();
        if (timeMs >= tFirst && timeMs <= tLast) {
            // inside an activity period — interpolate within this trip only
            if (trip.length === 1) return trip[0];
            for (let i=0;i<trip.length-1;i++) {
                const t1 = new Date(trip[i].timestamp).getTime();
                const t2 = new Date(trip[i+1].timestamp).getTime();
                if (timeMs >= t1 && timeMs <= t2) {
                    const r = (timeMs - t1)/(t2 - t1 || 1);
                    let course = trip[i].course;
                    const c1 = trip[i].course, c2 = trip[i+1].course;
                    if (typeof c1 === "number" && typeof c2 === "number" && !isNaN(c1) && !isNaN(c2)) {
                        const delta = ((c2 - c1 + 540) % 360) - 180;
                        course = (c1 + delta * r + 360) % 360;
                    } else if (typeof c1 === "number" && !isNaN(c1)) course = c1;
                    else if (typeof c2 === "number" && !isNaN(c2)) course = c2;
                    return { lat: trip[i].lat + (trip[i+1].lat - trip[i].lat)*r, lon: trip[i].lon + (trip[i+1].lon - trip[i].lon)*r, course, speed: trip[i].speed, deviceId, username: trip[i].username, timestamp: new Date(timeMs).toISOString() };
                }
            }
            return trip[trip.length-1];
        }
        // idle gap between this trip and next — stay still at end of previous trip
        if (ti < trips.length-1) {
            const nextFirst = new Date(trips[ti+1][0].timestamp).getTime();
            if (timeMs > tLast && timeMs < nextFirst) {
                return trip[trip.length-1];
            }
        }
    }
    // fallback — idle gap fallback to nearest trip end
    return lastTrip[lastTrip.length-1];
}
function getPlaybackSteps() { return 1000; }
function updatePlaybackSlider() {
    const bounds = getDayBounds();
    if (playbackTime === null) playbackTime = bounds.start;
    const ratio = (playbackTime - bounds.start)/(bounds.end - bounds.start);
    playSlider.value = Math.round(ratio*1000);
    playLabel.textContent = new Date(playbackTime).toLocaleTimeString().slice(0,5) + " / " + new Date(bounds.end).toLocaleTimeString().slice(0,5);
    if (playTimeEl) playTimeEl.textContent = new Date(playbackTime).toLocaleString();
    if (timelineCursorEl) timelineCursorEl.style.left = (Math.max(0, Math.min(100, ratio*100))) + "%";
}
function showTime(timeMs) {
    playbackTime = timeMs;
    updatePlaybackSlider();
    const ids = selectedDeviceIds.size ? [...selectedDeviceIds] : [...new Set(allPoints.map(p=>p.deviceId))];
    // clear previous playback markers
    playbackMarkers.forEach(m=> map.removeLayer(m));
    playbackMarkers.clear();
    fleetMarkers.forEach(m=> map.removeLayer(m)); fleetMarkers = [];
    if (marker) { map.removeLayer(marker); marker = null; }
    ids.forEach(id => {
        const pos = interpolatePosition(id, timeMs);
        if (!pos) return;
        const m = L.marker([pos.lat, pos.lon], { icon: boatTriangleIcon(pos.deviceId || id, pos.course) }).addTo(map).bindPopup(`${pos.username||id}<br>${new Date(timeMs).toLocaleTimeString()}`);
        playbackMarkers.set(id, m);
    });
    if (ids.length === 1 && playbackMarkers.size === 1) {
        const only = [...playbackMarkers.values()][0];
        marker = only;
        playbackMarkers.clear();
    }
    // Open boat panels follow their boat (nearest real point, never interpolated)
    updateOpenPanels();
    // Keep all boats on screen: shift only when one leaves the viewport
    const latlngs = [];
    playbackMarkers.forEach(m => latlngs.push(m.getLatLng()));
    if (!latlngs.length && marker) latlngs.push(marker.getLatLng());
    if (latlngs.length && !latlngs.every(ll => map.getBounds().contains(ll))) {
        const bounds = L.latLngBounds(latlngs);
        if (bounds.getNorthEast().equals(bounds.getSouthWest())) map.panTo(latlngs[0]);
        else map.fitBounds(bounds.pad(0.25));
    }
}

function showPlaybackPoint(idx) {
    // legacy compat: convert idx 0..1000 to time
    const bounds = getDayBounds();
    const ratio = idx / 1000;
    const timeMs = bounds.start + ratio * (bounds.end - bounds.start);
    showTime(timeMs);
}

function startPlayback() {
    if (playbackPoints.length === 0) return;
    if (playbackTimer) return;
    playBtn.textContent = "⏸";
    const steps = getPlaybackSteps();
    playbackTimer = setInterval(() => {
        if (playbackIdx >= steps - 1) {
            stopPlayback();
            return;
        }
        showPlaybackPoint(playbackIdx + 1);
    }, 800 / playbackSpeed);
}

// Next recorded timestamp at/after fromMs for the boats in play.
// Wraps to the first recorded timestamp when the cursor is past all data.
function nextDataTime(fromMs) {
    const ids = selectedDeviceIds.size ? [...selectedDeviceIds] : [...new Set(allPoints.map(p => p.deviceId))];
    let best = null, first = null;
    for (const p of allPoints) {
        if (ids.length && !ids.includes(p.deviceId)) continue;
        const t = new Date(p.timestamp || p.receivedAt).getTime();
        if (isNaN(t)) continue;
        if (first === null || t < first) first = t;
        if (t >= fromMs && (best === null || t < best)) best = t;
    }
    return best !== null ? best : first;
}

function startPlayback() {
    if (playbackTimer) return;
    if (playbackTime === null) playbackTime = getDayBounds().start;
    // Cursor in a gray area (no data) → jump to the next point with data
    const snap = nextDataTime(playbackTime);
    if (snap !== null && snap !== playbackTime) {
        playbackTime = snap;
        showTime(playbackTime);
    }
    playBtn.textContent = "⏸";
    let last = Date.now();
    playbackTimer = setInterval(() => {
        const now = Date.now();
        const delta = (now - last) * playbackSpeed;
        last = now;
        playbackTime += delta;
        const bounds = getDayBounds();
        if (playbackTime >= bounds.end) { playbackTime = bounds.end; showTime(playbackTime); stopPlayback(); return; }
        showTime(playbackTime);
    }, 50);
}
function stopPlayback() {
    if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
    playBtn.textContent = "▶";
}
playBtn.addEventListener("click", () => {
    if (playbackTimer) stopPlayback();
    else startPlayback();
});
const rewindBtn = document.getElementById("rewindBtn");
if(rewindBtn){
    rewindBtn.addEventListener("click", () => {
        stopPlayback();
        const bounds = getDayBounds();
        playbackTime = bounds.start;
        showTime(playbackTime);
        if (selectedDeviceIds.size === 1) {
            const id = [...selectedDeviceIds][0];
            const pos = interpolatePosition(id, playbackTime);
            if (pos) map.panTo([pos.lat, pos.lon]);
        }
    });
}
playSlider.addEventListener("input", e => {
    const bounds = getDayBounds();
    const ratio = parseInt(e.target.value, 10) / 1000;
    const timeMs = bounds.start + ratio * (bounds.end - bounds.start);
    showTime(timeMs);
    if (selectedDeviceIds.size === 1) {
        const id = [...selectedDeviceIds][0];
        const pos = interpolatePosition(id, timeMs);
        panToIfOutside(pos);
    }
});
playSpeedSel.addEventListener("change", e => {
    playbackSpeed = parseInt(e.target.value, 10);
    if (playbackTimer) { stopPlayback(); startPlayback(); }
});
// Timeline: click to scrub, drag to select start/end range
const timelineEl = document.getElementById("timeline");
const timelineSelectionEl = document.getElementById("timeline-selection");
let timelineDrag = null;
function getTimelineRatio(clientX){
    const rect = timelineEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}
function hideTimelineSelection(){
    if(timelineSelectionEl){ timelineSelectionEl.style.display="none"; timelineSelectionEl.style.left="0%"; timelineSelectionEl.style.width="0%"; }
    if(timelineEl) timelineEl.classList.remove("dragging");
}
if(timelineEl){
    timelineEl.addEventListener("mousedown", e => {
        if(e.button!==0) return;
        const ratio = getTimelineRatio(e.clientX);
        timelineDrag = { startX: e.clientX, startRatio: ratio, currentRatio: ratio, isDragging:false, rect: timelineEl.getBoundingClientRect() };
        e.preventDefault();
    });
    timelineEl.addEventListener("touchstart", e => {
        if(!e.touches[0]) return;
        const ratio = getTimelineRatio(e.touches[0].clientX);
        timelineDrag = { startX: e.touches[0].clientX, startRatio: ratio, currentRatio: ratio, isDragging:false, rect: timelineEl.getBoundingClientRect() };
    }, {passive:false});
}
window.addEventListener("mousemove", e => {
    if(!timelineDrag) return;
    const rect = timelineDrag.rect || (timelineEl && timelineEl.getBoundingClientRect());
    const curRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const delta = Math.abs(e.clientX - timelineDrag.startX);
    if(!timelineDrag.isDragging && delta > 4){
        timelineDrag.isDragging = true;
        if(timelineEl) timelineEl.classList.add("dragging");
        if(timelineSelectionEl) timelineSelectionEl.style.display="block";
    }
    if(timelineDrag.isDragging){
        timelineDrag.currentRatio = curRatio;
        const left = Math.min(timelineDrag.startRatio, curRatio) * 100;
        const width = Math.abs(curRatio - timelineDrag.startRatio) * 100;
        if(timelineSelectionEl){ timelineSelectionEl.style.left = left + "%"; timelineSelectionEl.style.width = width + "%"; }
    }
});
window.addEventListener("touchmove", e => {
    if(!timelineDrag || !e.touches[0]) return;
    const rect = timelineDrag.rect || (timelineEl && timelineEl.getBoundingClientRect());
    const curRatio = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
    const delta = Math.abs(e.touches[0].clientX - timelineDrag.startX);
    if(!timelineDrag.isDragging && delta > 6){
        timelineDrag.isDragging = true;
        if(timelineEl) timelineEl.classList.add("dragging");
        if(timelineSelectionEl) timelineSelectionEl.style.display="block";
    }
    if(timelineDrag.isDragging){
        timelineDrag.currentRatio = curRatio;
        const left = Math.min(timelineDrag.startRatio, curRatio) * 100;
        const width = Math.abs(curRatio - timelineDrag.startRatio) * 100;
        if(timelineSelectionEl){ timelineSelectionEl.style.left = left + "%"; timelineSelectionEl.style.width = width + "%"; }
        e.preventDefault();
    }
}, {passive:false});
window.addEventListener("mouseup", e => {
    if(!timelineDrag) return;
    const wasDragging = timelineDrag.isDragging;
    const rect = timelineDrag.rect || (timelineEl && timelineEl.getBoundingClientRect());
    const endRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const startRatio = timelineDrag.startRatio;
    const tmpDragging = wasDragging;
    timelineDrag = null;
    if(tmpDragging){
        const minR = Math.min(startRatio, endRatio), maxR = Math.max(startRatio, endRatio);
        if(maxR - minR < 0.01){
            hideTimelineSelection();
            // treat as click — move cursor, keep playing if already playing
            const bounds = getDayBounds();
            const timeMs = bounds.start + minR * (bounds.end - bounds.start);
            showTime(timeMs);
            if (selectedDeviceIds.size === 1) {
                const id = [...selectedDeviceIds][0];
                const pos = interpolatePosition(id, timeMs);
                panToIfOutside(pos);
            }
            return;
        }
        const bounds = getDayBounds();
        const duration = bounds.end - bounds.start;
        let selStart = bounds.start + minR * duration;
        let selEnd = bounds.start + maxR * duration;
        if(selEnd - selStart < 60000) selEnd = selStart + 60000; // at least 1min
        // apply as custom range
        isLive = false;
        liveBtn.classList.remove("active");
        timePreset = "custom";
        if(presetSelect) presetSelect.value = "custom";
        customStart = toLocalDatetimeValue(new Date(selStart));
        customEnd = toLocalDatetimeValue(new Date(selEnd));
        if(startPicker) startPicker.value = customStart;
        if(endPicker) endPicker.value = customEnd;
        updateTimeControlsVisibility();
        syncDateLabel();
        saveUI();
        playbackTime = selStart;
        hideTimelineSelection();
        refresh().then(() => {
            updateTimelineTracks();
            playbackTime = selStart;
            updatePlaybackSlider();
            showTime(selStart);
            if(selectedDeviceIds.size===1){
                const id=[...selectedDeviceIds][0]; const pos=interpolatePosition(id, selStart); if(pos) map.panTo([pos.lat,pos.lon]);
            }
        });
    } else {
        // single click -> scrub (keep playing if already playing)
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const bounds = getDayBounds();
        const timeMs = bounds.start + ratio * (bounds.end - bounds.start);
        showTime(timeMs);
        if (selectedDeviceIds.size === 1) {
            const id = [...selectedDeviceIds][0];
            const pos = interpolatePosition(id, timeMs);
            panToIfOutside(pos);
        }
        hideTimelineSelection();
    }
});
window.addEventListener("touchend", e => {
    if(!timelineDrag) return;
    const wasDragging = timelineDrag.isDragging;
    const endRatio = timelineDrag.currentRatio ?? timelineDrag.startRatio;
    const startRatio = timelineDrag.startRatio;
    timelineDrag = null;
    if(wasDragging){
        const minR = Math.min(startRatio, endRatio), maxR = Math.max(startRatio, endRatio);
        if(maxR - minR < 0.01){ hideTimelineSelection(); return; }
        const bounds = getDayBounds();
        const duration = bounds.end - bounds.start;
        let selStart = bounds.start + minR * duration;
        let selEnd = bounds.start + maxR * duration;
        if(selEnd - selStart < 60000) selEnd = selStart + 60000;
        isLive = false; liveBtn.classList.remove("active"); timePreset="custom"; if(presetSelect) presetSelect.value="custom";
        customStart = toLocalDatetimeValue(new Date(selStart)); customEnd = toLocalDatetimeValue(new Date(selEnd));
        if(startPicker) startPicker.value=customStart; if(endPicker) endPicker.value=customEnd;
        updateTimeControlsVisibility(); syncDateLabel(); saveUI(); playbackTime=selStart; hideTimelineSelection();
        refresh().then(()=>{ updateTimelineTracks(); playbackTime=selStart; updatePlaybackSlider(); showTime(selStart); });
    } else {
        hideTimelineSelection();
    }
});
document.getElementById("playbackClose")?.addEventListener("click", () => { stopPlayback(); document.getElementById("playback").style.display="none"; saveUI(); hideTimelineSelection(); });

// Hook into refresh to update timeline (forwards the recenter flag)
const origRefresh = refresh;
refresh = async function(recenter) {
    if (playbackTimer) return origRefresh(recenter);
    await origRefresh(recenter);
    updateTimelineTracks();
    if (playbackTime === null) playbackTime = getDayBounds().start;
    updatePlaybackSlider();
    if (playbackMarkers.size) showTime(playbackTime);
};

// Initialize timeline after first refresh
setTimeout(async () => {
    await refresh();
    updateTimelineTracks();
    if (playbackTime === null) playbackTime = getDayBounds().start;
    updatePlaybackSlider();
}, 800);

// --- Top menu: toggle panes (all hidden at start) ---
function toggleEl(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    if (typeof show === "boolean") el.style.display = show ? "block" : "none";
    else el.style.display = el.style.display === "none" || !el.style.display ? "block" : "none";
    saveUI();
}
const boatsBtn = document.getElementById("boatsToggleBtn");
const devicePanel = document.getElementById("device-panel");
if (boatsBtn && devicePanel) {
    const syncBoatsBtn = () => boatsBtn.classList.toggle("active", devicePanel.style.display !== "none" && devicePanel.style.display !== "");
    boatsBtn.addEventListener("click", () => { toggleEl("device-panel"); avoidPanelOverlap(devicePanel); syncBoatsBtn(); saveUI(); });
    // keep in sync if panel toggled elsewhere
    new MutationObserver(syncBoatsBtn).observe(devicePanel, { attributes:true, attributeFilter:["style"] });
}
const timelineBtn = document.getElementById("timelineToggleBtn");
const playbackEl = document.getElementById("playback");
if (timelineBtn && playbackEl) {
    const syncTimelineBtn = () => timelineBtn.classList.toggle("active", playbackEl.style.display !== "none" && playbackEl.style.display !== "");
    timelineBtn.addEventListener("click", () => { toggleEl("playback"); syncTimelineBtn(); updateTimelineTracks(); });
    new MutationObserver(syncTimelineBtn).observe(playbackEl, { attributes:true, attributeFilter:["style"] });
    syncTimelineBtn();
}
document.getElementById("boatFilter")?.addEventListener("input", () => { saveUI(); refreshDevices(); });

// --- Courses, builder & sessions (Step 2) ---
function escHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
// Inverse: absolute lat/lon → wind-frame offsets (waypoint adopter).
function offsetsFromLatLon(lat, lon, o) {
    const t = (o.windDir * Math.PI) / 180;
    const cosLat = Math.cos((o.originLat * Math.PI) / 180);
    const E = (lon - o.originLon) * 111320 * cosLat;
    const N = (lat - o.originLat) * 111320;
    const scale = o.scale || 1;
    return { x: (E * Math.cos(t) - N * Math.sin(t)) / scale, y: (E * Math.sin(t) + N * Math.cos(t)) / scale };
}

const racesDropdown = document.getElementById("racesDropdown");
const racesToggleBtn = document.getElementById("racesToggleBtn");
if (racesToggleBtn && racesDropdown) {
    // touch support: tap toggles the menu (hover covers desktop)
    racesToggleBtn.addEventListener("click", e => {
        e.stopPropagation();
        racesDropdown.classList.toggle("active");
    });
    document.addEventListener("click", e => {
        if (!e.target.closest("#racesDropdown")) racesDropdown.classList.remove("active");
    });
}
function syncRacesBtn() {
    const rt = document.getElementById("racesToggleBtn");
    if (!rt) return;
    const vis = el => el && el.style.display !== "none" && el.style.display !== "";
    rt.classList.toggle("active", !!(vis(document.getElementById("template-panel")) || vis(document.getElementById("session-panel"))));
}
const templatesBtn = document.getElementById("templatesToggleBtn");
const templatePanel = document.getElementById("template-panel");
if (templatesBtn && templatePanel) {
    const syncTemplatesBtn = () => {
        const open = templatePanel.style.display !== "none" && templatePanel.style.display !== "";
        templatesBtn.classList.toggle("active", open);
        syncRacesBtn();
    };
    templatesBtn.addEventListener("click", () => { toggleEl("template-panel"); avoidPanelOverlap(templatePanel); syncTemplatesBtn(); saveUI(); loadCourseTemplates(); if (racesDropdown) racesDropdown.classList.remove("active"); if (!panelVisible(templatePanel)) closeBuilder(); });
    new MutationObserver(syncTemplatesBtn).observe(templatePanel, { attributes: true, attributeFilter: ["style"] });
    syncTemplatesBtn();
}
const sessionsBtn = document.getElementById("sessionsToggleBtn");
const sessionPanel = document.getElementById("session-panel");
if (sessionsBtn && sessionPanel) {
    const syncSessionsBtn = () => {
        const open = sessionPanel.style.display !== "none" && sessionPanel.style.display !== "";
        sessionsBtn.classList.toggle("active", open);
        syncRacesBtn();
    };
    sessionsBtn.addEventListener("click", () => { toggleEl("session-panel"); avoidPanelOverlap(sessionPanel); syncSessionsBtn(); saveUI(); loadSessions(); if (racesDropdown) racesDropdown.classList.remove("active"); if (!panelVisible(sessionPanel)) { disarmSessMove(); clearSessPreview(); } });
    new MutationObserver(syncSessionsBtn).observe(sessionPanel, { attributes: true, attributeFilter: ["style"] });
    syncSessionsBtn();
    document.getElementById("sessionClose")?.addEventListener("click", () => {
        sessionPanel.style.display = "none";
        disarmSessMove();
        clearSessPreview();
        syncSessionsBtn();
        saveUI();
    });
}

let courseTemplatesCache = null;
async function loadCourseTemplates() {
    const el = document.getElementById("tab-templates");
    try {
        if (!courseTemplatesCache) {
            const res = await fetch("/templates/presets");
            courseTemplatesCache = await res.json();
        }
        const myRes = await fetch("/templates");
        const myTpls = await myRes.json();
        el.innerHTML = `<div class="device-meta" style="margin-bottom:6px">Wind-frame presets — placed + rotated on the day.</div>
        <div class="template-grid">` + courseTemplatesCache.map(t => `
            <div class="template-card" data-tpl="${escHtml(t.key)}">
                <b>${escHtml(t.name)}</b>
                <span class="device-meta">${escHtml(t.desc)} · ${t.marks.length} marks</span>
            </div>`).join("") + `
            <div class="template-card" data-blank-tpl>
                <b>Blank</b>
                <span class="device-meta">Start from scratch</span>
            </div></div>` + (myTpls.length ? `
            <div class="device-meta" style="margin:8px 0 4px 0"><b>My templates</b></div>
            <div class="template-grid">` + myTpls.map(c => {
                const gates = new Set((c.marks || []).filter(m => m.type === "gate" && m.gate).map(m => m.gate)).size;
                const lineLen = c.startLine ? Math.round(Math.hypot(c.startLine.bx - c.startLine.ax, c.startLine.by - c.startLine.ay)) + "m line" : "no lines";
                return `
            <div class="template-card" data-course-tpl="${c.id}">
                <b>${escHtml(c.name)}</b>
                <span class="device-meta">${c.desc ? escHtml(c.desc) : `${c.marks.length} marks · ${lineLen}${gates ? ` · ${gates} gate${gates > 1 ? "s" : ""}` : ""}`} · v${c.version}</span>
                <button data-del-tpl="${c.id}" title="Delete template" style="float:right;border:1px solid #d1d5db;background:white;border-radius:4px;cursor:pointer;font-size:11px">×</button>
            </div>`; }).join("") + `</div>` : "");
        el.querySelectorAll("[data-tpl]").forEach(card => {
            card.addEventListener("click", () => {
                const t = courseTemplatesCache.find(x => x.key === card.getAttribute("data-tpl"));
                if (t) openBuilder({ name: t.name + " (copy)", desc: t.desc, marks: t.marks.map(m => ({ ...m })), startLine: t.startLine ? { ...t.startLine } : null, finishLine: t.finishLine ? { ...t.finishLine } : null });
            });
        });
        el.querySelectorAll("[data-blank-tpl]").forEach(card => {
            card.addEventListener("click", () => openBuilder({ name: "", marks: [] }));
        });
        el.querySelectorAll("[data-course-tpl]").forEach(card => {
            card.addEventListener("click", async e => {
                if (e.target.closest("[data-del-tpl]")) return;
                const res = await fetch(`/templates/${card.getAttribute("data-course-tpl")}`);
                const c = await res.json();
                if (c && c.marks) openBuilder({ templateId: c.id, name: c.name, desc: c.desc, marks: c.marks.map(m => ({ ...m })), startLine: c.startLine, finishLine: c.finishLine });
            });
        });
        el.querySelectorAll("[data-del-tpl]").forEach(btn => {
            btn.addEventListener("click", async e => {
                e.stopPropagation();
                if (!confirm("Delete this template? Sessions already frozen keep their copy.")) return;
                await fetch(`/templates/${btn.getAttribute("data-del-tpl")}`, { method: "DELETE" });
                loadCourseTemplates();
            });
        });
        if (typeof avoidPanelOverlap === "function") avoidPanelOverlap(document.getElementById("template-panel"));
    } catch (e) {
        el.innerHTML = '<div class="boat-info-err">Failed to load templates.</div>';
    }
}

// --- Builder state + preview layers ---
const CB = {
    open: false, templateId: null, name: "", desc: "", marks: [],
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
    if (seg.square === false) {
        const a = pt(seg.ax, seg.ay), b = pt(seg.bx, seg.by);
        return { ...seg, latA: a.lat, lonA: a.lon, latB: b.lat, lonB: b.lon };
    }
    const cx = (seg.ax + seg.bx) / 2, cy = (seg.ay + seg.by) / 2;
    const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) * scale;
    const bdeg = ((((o.windDir + 90 + (seg.bias || 0)) % 360) + 360) % 360);
    const brad = (bdeg * Math.PI) / 180;
    const c = pt(cx, cy);
    const half = len / 2;
    const dLa = (half * Math.cos(brad)) / 111320;
    const dLo = (half * Math.sin(brad)) / (111320 * cosLat);
    return { ...seg, latA: c.lat - dLa, lonA: c.lon - dLo, latB: c.lat + dLa, lonB: c.lon + dLo };
}
function segLenM(a, b) {
    return map.distance([a.lat, a.lon], [b.lat, b.lon]);
}
let coursePreview = null; // L.layerGroup for resolved preview
let PV = null; // live refs into the preview (route/segments/dots), for in-drag updates
let adoptPins = null;     // L.layerGroup for waypoint pins
let adoptFlags = [];      // flagged points loaded for adoption
let pileTops = {};        // latlon key -> pile rotation offset (stacked display only)
const BUILDER_DRAFT_KEY = "indietrotutta:builder";

function builderInst() {
    return { originLat: CB.origin?.lat, originLon: CB.origin?.lon, windDir: CB.windDir, scale: CB.scale };
}
function builderResolved() {
    if (!CB.origin) return [];
    try { return resolveMarksJS(CB.marks, builderInst()); } catch { return []; }
}
const MARK_COLORS = { start: "#16a34a", finish: "#dc2626", gate: "#984ea3", mark: "#f59e0b" };

function openBuilder(init = {}) {
    CB.templateId = init.templateId ?? null;
    CB.name = init.name || "";
    CB.desc = init.desc || "";
    CB.marks = (init.marks || []).map(m => ({ ...m }));
    CB.origin = init.origin || null;
    CB.windDir = init.windDir ?? 315;
    CB.scale = init.scale || 1;
    CB.placing = null;
    CB.startLine = init.startLine || null;
    // server form {sameAs:"start"} normalizes to the UI shorthand
    CB.finishLine = init.finishLine && init.finishLine.sameAs === "start" ? "start" : (init.finishLine || null);
    CB.lineA = null;
    CB.open = true;
    pileTops = {};
    // templates arrive without placement: default the origin to the map
    // center so the preview renders immediately (user refines it after)
    if (!CB.origin && CB.marks.length) {
        const c = map.getCenter();
        CB.origin = { lat: Math.round(c.lat * 1e5) / 1e5, lon: Math.round(c.lng * 1e5) / 1e5 };
    }
    document.getElementById("builder-panel").style.display = "block";
    document.getElementById("builder-name").value = CB.name;
    document.getElementById("builder-desc").value = CB.desc;
    document.getElementById("builder-wind-val").textContent = CB.windDir;
    document.getElementById("builder-scale").value = CB.scale;
    document.getElementById("builder-msg").textContent = "";
    document.getElementById("builder-wind-src").textContent = "";
    document.getElementById("builderLabels")?.classList.toggle("arming", CB.showLabels);
    document.getElementById("builder-origin-label").textContent = CB.origin
        ? `Origin: ${CB.origin.lat.toFixed(5)}, ${CB.origin.lon.toFixed(5)}`
        : "Origin: not set (added automatically)";
    updateLineInfo();
    renderBuilderMarks();
    updateBuilderPreview();
    saveBuilderDraft();
    loadAdoptBoats();
}
function closeBuilder() {
    CB.open = false;
    CB.placing = null;
    if (courseMove) { courseMove = null; if (map.dragging) map.dragging.enable(); }
    updateWindDial();
    document.getElementById("builder-panel").style.display = "none";
    if (coursePreview) { map.removeLayer(coursePreview); coursePreview = null; }
    if (adoptPins) { map.removeLayer(adoptPins); adoptPins = null; }
    adoptFlags = [];
    syncBuilderArmButtons();
}
document.getElementById("builderClose")?.addEventListener("click", closeBuilder);
document.getElementById("builder-name")?.addEventListener("input", e => { CB.name = e.target.value; saveBuilderDraft(); });
document.getElementById("builder-desc")?.addEventListener("input", e => { CB.desc = e.target.value; saveBuilderDraft(); });
document.getElementById("builder-scale")?.addEventListener("change", e => {
    CB.scale = Math.min(5, Math.max(0.1, Number(e.target.value) || 1));
    e.target.value = CB.scale;
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
// Lines list (alongside the marks): length, square/bias, same-as, define/clear.
function renderLinesBox() {
    const el = document.getElementById("builder-lines-list");
    if (!el) return;
    const segLen = seg => Math.round(Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) * (CB.scale || 1));
    const squareTxt = seg => seg.square === false ? "fixed" : `⊥ wind${seg.bias ? ((seg.bias > 0 ? "+" : "") + seg.bias + "°") : ""}`;
    const row = (role, seg, isSame) => `
        <div class="mark-row" data-line="${role}">
            <div class="mark-head">
                <b>${role === "start" ? "Start" : "Finish"}</b>
                <span class="device-meta">${isSame ? "same as start" : seg ? `${segLen(seg)}m · ${squareTxt(seg)}` : "radius circle"}</span>
            </div>
            ${seg && !isSame ? `<div class="mark-head" style="margin-top:4px">
                <label class="device-meta">bias <input data-lb="bias" type="number" min="-60" max="60" step="1" value="${seg.bias || 0}" title="Skew vs square (deg)">°</label>
                <label class="device-meta"><input data-lb="square" type="checkbox" ${seg.square === false ? "" : "checked"}> square</label>
            </div>` : ""}
            <div class="mark-head" style="margin-top:4px">
                <button class="mini" data-lact="define">Define</button>
                ${role === "finish" && !isSame ? `<button class="mini" data-lact="same">Same as start</button>` : ""}
                ${(seg || isSame) ? `<button class="mini" data-lact="clear">Clear</button>` : ""}
            </div>
        </div>`;
    el.innerHTML = row("start", CB.startLine, false) +
        row("finish", CB.finishLine === "start" ? null : CB.finishLine, CB.finishLine === "start");
    el.querySelectorAll("[data-line]").forEach(box => {
        const role = box.getAttribute("data-line");
        const cur = () => (role === "start" ? CB.startLine : CB.finishLine);
        const set = seg => { if (role === "start") CB.startLine = seg; else CB.finishLine = seg; };
        const bias = box.querySelector('[data-lb="bias"]');
        if (bias) bias.addEventListener("change", () => {
            const c = cur();
            if (!c || typeof c !== "object") return;
            set({ ...c, bias: Math.max(-60, Math.min(60, Number(bias.value) || 0)) });
            afterLineEdit();
        });
        const sq = box.querySelector('[data-lb="square"]');
        if (sq) sq.addEventListener("change", () => {
            const c = cur();
            if (!c || typeof c !== "object") return;
            const upd = { ...c };
            if (sq.checked) delete upd.square; else upd.square = false;
            set(upd);
            afterLineEdit();
        });
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
            r: 30, side: "P", type: CB.marks.length === 0 ? "start" : "mark",
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
        el.innerHTML = '<div class="device-meta">No marks — click "+ Add marks" then click the map, or adopt waypoints below.</div>';
        return;
    }
    el.innerHTML = CB.marks.map((m, i) => `
        <div class="mark-row" data-mark="${i}">
            <div class="mark-head">
                <b>#${i + 1}</b>
                <select data-f="type" title="Mark type">
                    ${["start", "mark", "gate", "finish"].map(t => `<option ${m.type === t ? "selected" : ""}>${t}</option>`).join("")}
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
        </div>`).join("");
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
    const pts = [...(startC ? [startC] : []),
        ...PV.marks.map(m => { const p = m.getLatLng(); return [p.lat, p.lng]; }),
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
    updateWindDial();
    if (!CB.open) return;
    if (coursePreview) { map.removeLayer(coursePreview); coursePreview = null; }
    PV = null;
    if (!CB.origin || (!CB.marks.length && !CB.startLine && !CB.finishLine && !CB.lineA)) return;
    coursePreview = L.layerGroup().addTo(map);
    PV = { marks: [], circles: [], route: null, legs: [], startSeg: null, finishSeg: null, startDots: [], finishDots: [], startMove: null, finishMove: null, startLenTip: null, finishLenTip: null, gateSegs: [] };
    const resolved = builderResolved();
    // route runs line-center → marks → line-center when lines replace points
    const segCenter = seg => {
        const r = resolveSegJS(seg, builderInst());
        return [(r.latA + r.latB) / 2, (r.lonA + r.lonB) / 2];
    };
    const latlngs = resolved.map(m => [m.lat, m.lon]);
    // route point sources (mark index or -1 for line centers) — legs inside
    // one gate pair get no leg label (the gate connector already labels them)
    const routeSrc = resolved.map((m, i) => i);
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
        marker.on("drag", refreshRouteLive);
        marker.on("dragend", () => {
            const ll = marker.getLatLng();
            const off = offsetsFromLatLon(ll.lat, ll.lng, builderInst());
            CB.marks[i].x = Math.round(off.x * 10) / 10;
            CB.marks[i].y = Math.round(off.y * 10) / 10;
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

// --- Wind dial: screen-anchored indicator (bottom-left), tip drags to set wind ---
let windDialCtl = null;
function ensureWindDial() {
    if (windDialCtl) return windDialCtl._container;
    windDialCtl = L.control({ position: "bottomleft" });
    windDialCtl.onAdd = function () {
        const div = L.DomUtil.create("div", "wind-dial");
        div.innerHTML = `<div class="wind-dial-rot" id="windDialRot"><div class="wind-dial-arrow">▲</div></div><div class="wind-dial-label" id="windDialLabel"></div>`;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        div.addEventListener("pointerdown", windDialDown);
        return div;
    };
    windDialCtl.addTo(map);
    return windDialCtl._container;
}
function windDialDown(e) {
    e.stopPropagation();
    e.preventDefault();
    const dial = e.currentTarget;
    try { dial.setPointerCapture(e.pointerId); } catch {}
    const move = ev => {
        const r = dial.getBoundingClientRect();
        const dx = ev.clientX - (r.left + r.width / 2);
        const dy = ev.clientY - (r.top + r.height / 2);
        setBuilderWind(Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360));
    };
    move(e);
    const up = () => {
        dial.removeEventListener("pointermove", move);
        dial.removeEventListener("pointerup", up);
        dial.removeEventListener("pointercancel", up);
    };
    dial.addEventListener("pointermove", move);
    dial.addEventListener("pointerup", up);
    dial.addEventListener("pointercancel", up);
}
function setBuilderWind(deg) {
    CB.windDir = ((Math.round(deg) % 360) + 360) % 360;
    const wv = document.getElementById("builder-wind-val");
    if (wv) wv.textContent = CB.windDir;
    updateWindDial();
    updateBuilderPreview();
    saveBuilderDraft();
}
function updateWindDial() {
    const c = ensureWindDial();
    c.style.display = CB.open ? "block" : "none";
    if (!CB.open) return;
    const rot = document.getElementById("windDialRot");
    const lab = document.getElementById("windDialLabel");
    if (rot) rot.style.transform = `rotate(${CB.windDir}deg)`;
    if (lab) lab.textContent = `${CB.windDir}°`;
}

// --- Waypoint adopter ---
async function loadAdoptBoats() {
    const sel = document.getElementById("adopt-boat");
    if (!lastDevices.length) await refreshDevices();
    sel.innerHTML = lastDevices.map(d => `<option value="${escHtml(d.deviceId)}">${escHtml(d.username || d.deviceId.slice(-5))}</option>`).join("");
    if (!document.getElementById("adopt-date").value) {
        document.getElementById("adopt-date").value = new Date().toISOString().slice(0, 10);
    }
}
document.getElementById("adopt-load")?.addEventListener("click", async () => {
    const deviceId = document.getElementById("adopt-boat").value;
    const date = document.getElementById("adopt-date").value;
    const msg = document.getElementById("builder-msg");
    if (!deviceId || !date) { msg.textContent = "Pick a boat and a day first."; return; }
    msg.textContent = "";
    try {
        const res = await fetch(`/gps?deviceId=${encodeURIComponent(deviceId)}&date=${encodeURIComponent(date)}&flagged=true`);
        adoptFlags = await res.json();
        if (adoptPins) { map.removeLayer(adoptPins); adoptPins = null; }
        if (!adoptFlags.length) { msg.textContent = "No flagged waypoints that day."; return; }
        adoptPins = L.layerGroup().addTo(map);
        adoptFlags.forEach((p, i) => {
            const mk = L.marker([p.lat, p.lon], {
                icon: L.divIcon({ html: `<div class="adopt-pin-label">F${i + 1}</div>`, className: "", iconSize: [20, 20], iconAnchor: [10, 10] }),
            }).addTo(adoptPins);
            mk.bindTooltip(`F${i + 1} · ${new Date(p.timestamp || p.receivedAt).toLocaleTimeString()} · ${escHtml(p.uid || "")}`);
            mk.on("click", () => adoptFlag(i));
        });
        map.fitBounds(adoptFlags.map(p => [p.lat, p.lon]), { padding: [30, 30] });
    } catch (e) {
        msg.textContent = "Failed to load waypoints.";
    }
});
function adoptFlag(i) {
    const p = adoptFlags[i];
    if (!p) return;
    if (!CB.origin) {
        CB.origin = { lat: p.lat, lon: p.lon };
        document.getElementById("builder-origin-label").textContent =
            `Origin: ${CB.origin.lat.toFixed(5)}, ${CB.origin.lon.toFixed(5)} (from ${p.uid || "flag"})`;
    }
    const off = offsetsFromLatLon(p.lat, p.lon, builderInst());
    CB.marks.push({
        x: Math.round(off.x * 10) / 10, y: Math.round(off.y * 10) / 10,
        r: 30, side: "P", type: CB.marks.length === 0 ? "start" : "mark",
        sourceUid: p.uid || undefined,
    });
    renderBuilderMarks();
    updateBuilderPreview(); saveBuilderDraft();
}
document.getElementById("builderWindSuggest")?.addEventListener("click", async () => {
    const src = document.getElementById("builder-wind-src");
    if (!CB.origin) { src.textContent = "Set the origin first."; return; }
    src.textContent = "asking…";
    try {
        const res = await fetch(`/wind?lat=${CB.origin.lat}&lon=${CB.origin.lon}`);
        if (!res.ok) throw new Error();
        const w = await res.json();
        setBuilderWind(w.dir);
        src.textContent = `${escHtml(w.source)} · ${w.distKm != null ? w.distKm + "km" : "model"} · ${w.ageMin}min ago · ${w.speedKn}kn`;
    } catch {
        src.textContent = "no wind source available";
    }
});

// --- Save template (shape library only; sessions are born in Sessions) ---
// Save as template (the only shape library — sessions freeze from here).
async function builderSaveTemplate() {
    const msg = document.getElementById("builder-msg");
    const name = document.getElementById("builder-name").value.trim() || "Untitled template";
    const desc = document.getElementById("builder-desc").value.trim() || null;
    // UI shorthand "start" → server form {sameAs:"start"}
    const finishOut = CB.finishLine === "start" ? { sameAs: "start" } : CB.finishLine;
    try {
        let res;
        if (CB.templateId) {
            res = await fetch(`/templates/${CB.templateId}`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, desc, marks: CB.marks, startLine: CB.startLine, finishLine: finishOut }),
            });
        } else {
            res = await fetch("/templates", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, desc, marks: CB.marks, startLine: CB.startLine, finishLine: finishOut, is_template: true }),
            });
        }
        const j = await res.json();
        if (!res.ok) { msg.textContent = j.error || "Save failed."; return null; }
        CB.templateId = j.id;
        CB.name = j.name;
        CB.desc = j.desc || "";
        document.getElementById("builder-name").value = j.name;
        document.getElementById("builder-desc").value = CB.desc;
        msg.textContent = "";
        return j;
    } catch {
        msg.textContent = "Network error.";
        return null;
    }
}
document.getElementById("builderSave")?.addEventListener("click", () => builderSaveTemplate());
function saveBuilderDraft() {
    try {
        localStorage.setItem(BUILDER_DRAFT_KEY, JSON.stringify({
            templateId: CB.templateId, name: document.getElementById("builder-name")?.value || "",
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
    const sb = document.getElementById("sessionsToggleBtn");
    if (sb && panel) sb.classList.toggle("active", panelVisible(panel));
    syncRacesBtn();
    saveUI();
    loadSessions(selectId);
}

// --- Sessions tab: list + create + committee controls ---
let sessionsCache = [];
let selectedSessionId = null;

// --- Session creation draft: template + placement previewed on the chart ---
const SESSDRAFT = { template: null, sel: null, origin: null, windDir: 315, scale: 1, placing: null };
let sessPreview = null;
let sessMove = null;
let sessSuppressClick = false;
function disarmSessMove() {
    sessMove = null;
    if (SESSDRAFT.placing === "move") SESSDRAFT.placing = null;
    if (map.dragging) map.dragging.enable();
    document.getElementById("sess-move")?.classList.remove("arming");
}
if (typeof map !== "undefined" && map.getContainer) {
    const sessBox = map.getContainer();
    sessBox.addEventListener("pointerdown", e => {
        if (SESSDRAFT.placing !== "move" || !SESSDRAFT.origin) return;
        if (!panelVisible(document.getElementById("session-panel"))) { disarmSessMove(); return; }
        if (e.target.closest(".leaflet-marker-icon, .leaflet-tooltip, .leaflet-control, button, input, select, a")) return;
        e.stopPropagation();
        e.preventDefault();
        if (map.dragging) map.dragging.disable();
        const p = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
        sessMove = { lastLat: p.lat, lastLon: p.lng };
        try { sessBox.setPointerCapture(e.pointerId); } catch {}
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
        SESSDRAFT.placing = null;
        sessSuppressClick = true;
        if (map.dragging) map.dragging.enable();
        document.getElementById("sess-move")?.classList.remove("arming");
    };
    sessBox.addEventListener("pointerup", sessUp);
    sessBox.addEventListener("pointercancel", sessUp);
}
function clearSessPreview() {
    if (sessPreview) { map.removeLayer(sessPreview); sessPreview = null; }
}
function sessDraftInst() {
    return { originLat: SESSDRAFT.origin.lat, originLon: SESSDRAFT.origin.lon, windDir: SESSDRAFT.windDir, scale: SESSDRAFT.scale };
}
function renderSessPreview() {
    clearSessPreview();
    // a template fetch may resolve after the panel was closed — stay buried
    if (!panelVisible(document.getElementById("session-panel"))) return;
    const t = SESSDRAFT.template;
    if (!t || !SESSDRAFT.origin) return;
    const o = sessDraftInst();
    sessPreview = L.layerGroup().addTo(map);
    const marks = resolveMarksJS(t.marks, o);
    const latlngs = marks.map(m => [m.lat, m.lon]);
    if (t.startLine) {
        const r = resolveSegJS(t.startLine, o);
        latlngs.unshift([(r.latA + r.latB) / 2, (r.lonA + r.lonB) / 2]);
        L.polyline([[r.latA, r.lonA], [r.latB, r.lonB]], { color: "#16a34a", weight: 5 }).addTo(sessPreview);
    }
    const effFinish = t.finishLine === "start" ? t.startLine : t.finishLine;
    if (effFinish && typeof effFinish === "object") {
        const r = resolveSegJS(effFinish, o);
        latlngs.push([(r.latA + r.latB) / 2, (r.lonA + r.lonB) / 2]);
        const same = t.finishLine === "start";
        L.polyline([[r.latA, r.lonA], [r.latB, r.lonB]], same
            ? { color: "#dc2626", weight: 2, dashArray: "6 4" }
            : { color: "#dc2626", weight: 5 }).addTo(sessPreview);
    }
    L.polyline(latlngs, { color: "#3b82f6", weight: 2, dashArray: "6 4", opacity: 0.9 }).addTo(sessPreview);
    marks.forEach((m, i) => {
        L.circle([m.lat, m.lon], { radius: m.r, color: MARK_COLORS[m.type] || "#f59e0b", weight: 2, fillOpacity: 0.08 }).addTo(sessPreview);
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
async function pickSessTemplate(value) {
    try {
        let c = null;
        if (String(value).startsWith("t:")) {
            if (!courseTemplatesCache) {
                const res = await fetch("/templates/presets");
                courseTemplatesCache = await res.json();
            }
            const t = (courseTemplatesCache || []).find(x => x.key === String(value).slice(2));
            if (t) c = {
                ...t,
                marks: t.marks.map(m => ({ ...m })),
                startLine: t.startLine ? { ...t.startLine } : null,
                finishLine: t.finishLine && typeof t.finishLine === "object" ? { ...t.finishLine } : (t.finishLine ?? null),
            };
        } else {
            const res = await fetch(`/templates/${String(value).replace(/^c:/, "")}`);
            c = await res.json();
            if (!c || !c.marks) return;
        }
        SESSDRAFT.template = c;
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
async function loadSessions(selectId) {
    const el = document.getElementById("tab-sessions");
    try {
        const [sessRes, courseRes, tplRes] = await Promise.all([fetch("/sessions"), fetch("/templates"), fetch("/templates/presets")]);
        sessionsCache = await sessRes.json();
        const courses = await courseRes.json();
        courseTemplatesCache = courseTemplatesCache || await tplRes.json();
        if (!lastDevices.length) await refreshDevices();
        if (selectId) selectedSessionId = selectId;
        const boatChecks = lastDevices.map(d => `<label style="display:inline-block;margin-right:8px;font-weight:normal;font-size:12px">
            <input type="checkbox" data-sb="${escHtml(d.deviceId)}" checked> ${escHtml(d.username || d.deviceId.slice(-5))}</label>`).join("");
        el.innerHTML = `
            <div class="device-meta" style="margin-bottom:6px"><b>New session</b> — pick a template, place it on the chart, set the wind</div>
            <div class="builder-row"><select id="sess-template">${courseTemplatesCache.map(t => `<option value="t:${escHtml(t.key)}">${escHtml(t.name)}</option>`).join("")}${courses.map(c => `<option value="c:${c.id}">${escHtml(c.name)}</option>`).join("")}</select></div>
            <div class="builder-row">
                <span id="sess-origin" class="device-meta" style="flex:2">Origin: —</span>
                <button id="sess-move" title="Drag the course on the map">Move</button>
            </div>
            <div class="builder-row">
                <label class="device-meta" style="flex:1">Wind <input id="sess-wind" type="number" min="0" max="359" step="1" style="max-width:64px" title="Wind from (deg)"></label>
                <label class="device-meta" style="flex:1">Scale <input id="sess-scale" type="number" min="0.1" max="5" step="0.1" style="max-width:64px"></label>
                <button id="sess-wind-suggest" title="Suggest wind from nearby stations">Suggest</button>
            </div>
            <div class="device-meta" id="sess-wind-src"></div>
            <div class="builder-row">
                <input id="sess-date" type="date" value="${new Date().toISOString().slice(0, 10)}">
                <select id="sess-mode"><option value="practice">Practice</option><option value="race">Race</option></select>
            </div>
            <div class="builder-row"><label class="device-meta" style="flex:1">Start <input id="sess-start" type="time" title="Start time on session date (optional)"></label></div>
            <div style="margin:4px 0">${boatChecks || '<span class="device-meta">No boats known yet.</span>'}</div>
            <div class="builder-row"><button id="sess-create" class="primary">Create session</button></div>
            <div id="sess-create-err" class="boat-info-err"></div>
            <div class="device-meta" style="margin:6px 0 4px 0"><b>Sessions</b> (wind/origin editable pre-start in detail view)</div>
            <div id="sess-list">` + (sessionsCache.length ? sessionsCache.map(s => `
                <div class="device-item ${String(s.id) === String(selectedSessionId) ? "active" : ""}" data-sess="${s.id}" style="cursor:pointer">
                    <div style="overflow:hidden;flex:1">
                        <span class="device-name">${escHtml(s.name || ("Session " + s.id))}</span>
                        <div class="device-meta">${escHtml(s.date)} · ${s.boats.length} boats · v${s.courseVersion}</div>
                    </div>
                    <div style="text-align:right">
                        <div><span class="mode-badge ${s.mode}">${s.mode}</span></div>
                        <div style="margin-top:2px"><span class="status-badge ${s.status}">${s.status}</span></div>
                    </div>
                </div>`).join("") : '<div class="device-meta">No sessions yet.</div>') + `</div>
            <div id="sess-detail"></div>`;
        document.getElementById("sess-template").addEventListener("change", e => pickSessTemplate(e.target.value));
        const sessSel = document.getElementById("sess-template");
        const hasSel = opt => [...sessSel.options].some(o => o.value === opt);
        if (SESSDRAFT.sel && hasSel(SESSDRAFT.sel)) sessSel.value = SESSDRAFT.sel;
        pickSessTemplate(sessSel.value);
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
        document.getElementById("sess-move").addEventListener("click", () => {
            if (SESSDRAFT.placing === "move") { disarmSessMove(); return; }
            if (!SESSDRAFT.origin) {
                const m = map.getCenter();
                SESSDRAFT.origin = { lat: Math.round(m.lat * 1e5) / 1e5, lon: Math.round(m.lng * 1e5) / 1e5 };
                syncSessForm();
                renderSessPreview();
            }
            SESSDRAFT.placing = "move";
            document.getElementById("sess-move")?.classList.add("arming");
        });
        document.getElementById("sess-wind-suggest").addEventListener("click", async () => {
            const src = document.getElementById("sess-wind-src");
            const at = SESSDRAFT.origin || (() => { const m = map.getCenter(); return { lat: m.lat, lon: m.lng }; })();
            src.textContent = "asking…";
            try {
                const res = await fetch(`/wind?lat=${at.lat}&lon=${at.lon}`);
                if (!res.ok) throw new Error();
                const w = await res.json();
                SESSDRAFT.windDir = ((Math.round(w.dir) % 360) + 360) % 360;
                syncSessForm();
                src.textContent = `${escHtml(w.source)} · ${w.distKm != null ? w.distKm + "km" : "model"} · ${w.ageMin}min ago · ${w.speedKn}kn`;
                renderSessPreview();
            } catch {
                src.textContent = "no wind source available";
            }
        });
        document.getElementById("sess-create").addEventListener("click", async () => {
            const errEl = document.getElementById("sess-create-err");
            const date = document.getElementById("sess-date").value;
            const mode = document.getElementById("sess-mode").value;
            const startVal = document.getElementById("sess-start").value;
            const startISO = startVal ? new Date(`${date}T${startVal}`).toISOString() : null;
            const t0 = SESSDRAFT.template;
            if (!t0) { errEl.textContent = "Pick a template first."; return; }
            if (!SESSDRAFT.origin) { errEl.textContent = "Place the origin first (Center here)."; return; }
            if (!date) { errEl.textContent = "Pick a session date."; return; }
            // sessions encapsulate: DB template rows pass lineage, anything else
            // freezes as an inline snapshot (no phantom template rows created)
            const shapeBody = t0.id
                ? { templateId: t0.id }
                : {
                    snapshot: {
                        name: t0.name, marks: t0.marks,
                        startLine: t0.startLine || null,
                        finishLine: t0.finishLine === undefined ? null : t0.finishLine,
                    },
                };
            try {
                const res = await fetch("/sessions", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        ...shapeBody,
                        name: `${t0.name} — ${date}`, date, mode,
                        originLat: SESSDRAFT.origin.lat, originLon: SESSDRAFT.origin.lon,
                        windDir: SESSDRAFT.windDir, scale: SESSDRAFT.scale,
                        startTime: startISO,
                    }),
                });
                const j = await res.json();
                if (!res.ok) { errEl.textContent = j.error || "Create failed."; return; }
                const ids = [...document.querySelectorAll("#tab-sessions input[data-sb]:checked")].map(x => x.getAttribute("data-sb"));
                for (const id of ids) {
                    await fetch(`/sessions/${j.id}/boats`, {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ deviceId: id }),
                    });
                }
                loadSessions(j.id);
            } catch { errEl.textContent = "Network error."; }
        });
        el.querySelectorAll("[data-sess]").forEach(row => {
            row.addEventListener("click", () => {
                selectedSessionId = Number(row.getAttribute("data-sess"));
                loadSessions();
            });
        });
        if (selectedSessionId) renderSessionDetail();
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
// Newest sim run for a session, drawn as dashed preview + wall-clock dot.
async function renderSimOverlay(fit) {
    clearSimOverlay();
    const box = document.getElementById("sess-detail");
    if (!box || !selectedSessionId) return;
    let runs = [];
    try { runs = await (await fetch(`/sim/runs?sessionId=${selectedSessionId}`)).json(); } catch { return; }
    if (!runs.length || !document.getElementById("sess-detail")) return;
    const run = runs[0];
    let pts;
    try {
        pts = await (await fetch(`/sim/runs/${encodeURIComponent(run.id)}/points`)).json();
        if (!pts.points || !pts.points.length) return;
    } catch { return; }
    simOverlay = L.layerGroup().addTo(map);
    simOverlayRun = run.id;
    const latlngs = pts.points.map(p => [p.lat, p.lon]);
    L.polyline(latlngs, { color: "#f97316", weight: 2, dashArray: "6 4", opacity: 0.9 }).addTo(simOverlay);
    const dot = L.circleMarker(latlngs[0], {
        radius: 7, color: colorForDevice(run.deviceId),
        fillColor: colorForDevice(run.deviceId), fillOpacity: 1,
    }).addTo(simOverlay);
    if (fit) map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
    const moveDot = () => {
        if (!simOverlay || simOverlayRun !== run.id) return;
        const el = (Date.now() - pts.startMs) / 1000;
        let bi = 0;
        while (bi + 1 < pts.points.length && pts.points[bi + 1].t <= el) bi++;
        const p = pts.points[bi];
        if (p) dot.setLatLng([p.lat, p.lon]);
        if (el > pts.durationSec + 30) clearSimOverlay();
    };
    moveDot();
    sessDetailTimers.push(setInterval(moveDot, 2000));
}
async function renderSessionDetail() {
    const el = document.getElementById("sess-detail");
    if (!el) return;    clearSessDetailTimers();
    clearSimOverlay();
    try {
        const res = await fetch(`/sessions/${selectedSessionId}`);
        if (!res.ok) { el.innerHTML = ""; return; }
        const s = await res.json();
        el.innerHTML = `
            <div class="sess-detail">
                <b>${escHtml(s.name || ("Session " + s.id))}</b>
                <table>
                    <tr><td>Date</td><td>${escHtml(s.date)}</td></tr>
                    <tr><td>Mode</td><td><span class="mode-badge ${s.mode}">${s.mode}</span></td></tr>
                    <tr><td>Status</td><td><span class="status-badge ${s.status}">${s.status}</span></td></tr>
                    <tr><td>Course</td><td>v${s.courseVersion} · ${s.marks.length} marks · wind ${Math.round(s.windDir)}° · scale ${s.scale}</td></tr>
                    <tr><td>Lines</td><td>${sessLinesText(s)}</td></tr>
                    <tr><td>Start</td><td>${s.startTime ? escHtml(new Date(s.startTime).toLocaleString()) : "—"}</td></tr>
                    <tr><td>Gun</td><td id="sess-countdown">—</td></tr>
                    <tr><td>Boats</td><td>${s.boats.length ? s.boats.map(b => `${escHtml((lastDevices.find(d => d.deviceId === b.deviceId) || {}).username || b.deviceId.slice(-5))}${b.startOffsetSec ? ` (+${b.startOffsetSec}s)` : ""} <a href="#" data-unboat="${escHtml(b.deviceId)}" style="color:#dc2626">×</a>`).join(", ") : "—"}</td></tr>
                </table>
                <div class="builder-row">
                    <button data-sstatus="scheduled">Scheduled</button>
                    <button data-sstatus="live">Live</button>
                    <button data-sstatus="finished">Finished</button>
                    <button data-sstatus="abandoned">Abandon</button>
                </div>
                <div class="builder-row">
                    <button id="sess-seq" title="Set the gun 5 minutes from now">Gun in 5:00</button>
                    <button id="sess-post" title="Push the existing gun 5 minutes later">Postpone +5:00</button>
                </div>
                <div class="builder-row">
                    <input id="sess-start-custom" type="time" value="${s.startTime ? toLocalDatetimeValue(new Date(s.startTime)).slice(11, 16) : ""}" title="Start time on ${escHtml(s.date)}">
                    <button id="sess-start-apply">Set start</button>
                </div>
                <div class="builder-row">
                    <select id="sess-add-boat">${lastDevices.map(d => `<option value="${escHtml(d.deviceId)}">${escHtml(d.username || d.deviceId.slice(-5))}</option>`).join("")}</select>
                    <input id="sess-add-off" type="number" value="0" title="Pursuit offset (s)" style="max-width:70px">
                    <button id="sess-add-btn">Add</button>
                </div>
                <div class="builder-row">
                    <input id="sess-repeat-date" type="date" value="${new Date().toISOString().slice(0, 10)}" title="Repeat this session on a new day">
                    <button id="sess-repeat" title="Same course, boats and wind on a new day">Repeat</button>
                </div>
                <div class="builder-row">
                    <button id="sess-sim" title="Script a mock-GPS run for all boats (indoor testing)">Simulate</button>
                </div>
                <div id="sess-runs" class="device-meta"></div>
                <div class="builder-row"><b>Results</b><button id="sess-res-refresh" title="Reload results">↻</button></div>
                <div id="sess-results" class="device-meta">no runs yet</div>
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
                    <button data-sig="ABANDON" title="Abandon race (fleet)">Abandon</button>
                </div>
                <div id="sess-signals" class="device-meta"></div>
                <div class="builder-row">
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
        el.querySelectorAll("[data-sstatus]").forEach(b => b.addEventListener("click", () => put({ status: b.getAttribute("data-sstatus") })));
        document.getElementById("sess-seq").addEventListener("click", () =>
            put({ startTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(), status: "scheduled" }));
        document.getElementById("sess-post").addEventListener("click", () => {
            const base = s.startTime ? new Date(s.startTime).getTime() : Date.now() + 5 * 60 * 1000;
            put({ startTime: new Date(base + 5 * 60 * 1000).toISOString() });
        });
        document.getElementById("sess-start-apply").addEventListener("click", () => {
            const v = document.getElementById("sess-start-custom").value;
            if (!v) return;
            put({ startTime: new Date(`${s.date}T${v}`).toISOString() });
        });
        document.getElementById("sess-add-btn").addEventListener("click", async () => {
            const id = document.getElementById("sess-add-boat").value;
            const off = Number(document.getElementById("sess-add-off").value) || 0;
            if (!id) return;
            await fetch(`/sessions/${s.id}/boats`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deviceId: id, startOffsetSec: off }),
            });
            loadSessions(s.id);
        });
        el.querySelectorAll("[data-unboat]").forEach(a => a.addEventListener("click", async e => {
            e.preventDefault();
            await fetch(`/sessions/${s.id}/boats/${encodeURIComponent(a.getAttribute("data-unboat"))}`, { method: "DELETE" });
            loadSessions(s.id);
        }));
        document.getElementById("sess-repeat").addEventListener("click", async () => {
            const date = document.getElementById("sess-repeat-date").value;
            if (!date) return;
            const r = await fetch(`/sessions/${s.id}/repeat`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ date }),
            });
            const j = await r.json();
            if (!r.ok) document.getElementById("sess-detail-err").textContent = j.error || "Repeat failed.";
            else loadSessions(j.id);
        });
        document.getElementById("sess-del").addEventListener("click", async () => {
            if (!confirm("Delete this session?")) return;
            await fetch(`/sessions/${s.id}`, { method: "DELETE" });
            selectedSessionId = null;
            loadSessions();
        });
        const refreshRuns = async () => {
            const box = document.getElementById("sess-runs");
            if (!box) return;
            try {
                const runs = await (await fetch(`/sim/runs?sessionId=${s.id}`)).json();
                const nowMs = Date.now();
                box.innerHTML = runs.length ? runs.map(r => {
                    const el = Math.max(0, Math.floor((nowMs - r.startMs) / 1000));
                    const state = el >= r.durationSec ? "done" : `${el}s / ${r.durationSec}s`;
                    const echo = r.echoCount ? ` · echo ${r.echoCount}${r.lastDevM != null ? ` Δ${r.lastDevM}m` : ""}` : "";
                    return `<div>${escHtml(r.deviceId.slice(-5))} · ${r.speedKn}kn · gun T+${r.gunSec}s · ${state}${echo} <a href="#" data-stoprun="${escHtml(r.id)}" style="color:#dc2626">stop</a></div>`;
                }).join("") : "no sim runs";
                box.querySelectorAll("[data-stoprun]").forEach(a => a.addEventListener("click", async e => {
                    e.preventDefault();
                    await fetch(`/sim/runs/${encodeURIComponent(a.getAttribute("data-stoprun"))}`, { method: "DELETE" });
                    refreshRuns();
                    renderSimOverlay(false);
                }));
            } catch { box.textContent = "runs unavailable"; }
        };
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
        document.getElementById("sess-sim").addEventListener("click", async () => {
            const errBox = document.getElementById("sess-detail-err");
            try {
                const existing = await (await fetch(`/sim/runs?sessionId=${s.id}`)).json();
                for (const r of existing) {
                    try { await fetch(`/sim/runs/${encodeURIComponent(r.id)}`, { method: "DELETE" }); } catch {}
                }
            } catch {}
            const r = await fetch("/sim/runs", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: s.id }),
            });
            const j = await r.json();
            if (!r.ok) { if (errBox) errBox.textContent = j.error || "Simulate failed."; return; }
            refreshRuns();
            renderSimOverlay(true);
        });
        refreshRuns();
        renderSimOverlay(false);
        const gunMs = s.startTime ? new Date(s.startTime).getTime() : 0;
        const tickCountdown = () => {
            const box = document.getElementById("sess-countdown");
            if (!box) return;
            if (!gunMs || ["finished", "abandoned"].includes(s.status)) { box.textContent = "—"; return; }
            const d = Math.floor((gunMs - Date.now()) / 1000);
            const mmss = `${Math.floor(Math.abs(d) / 60)}:${String(Math.abs(d) % 60).padStart(2, "0")}`;
            box.innerHTML = d >= 0 ? `Gun in <b>${mmss}</b>` : `<b style="color:#16a34a">LIVE +${mmss}</b>`;
        };
        tickCountdown();
        sessDetailTimers.push(setInterval(tickCountdown, 1000));
        if (typeof avoidPanelOverlap === "function") avoidPanelOverlap(document.getElementById("session-panel"));
    } catch {
        el.innerHTML = '<div class="boat-info-err">Failed to load session.</div>';
    }
}

// --- Floating panels: drag by header + no-overlap on show ---
let floatZ = 1001; // bring-to-front counter for dragged panels
function makeFloatingDraggable(el) {
    if (!el || el.dataset.draggable) return;
    const header = el.querySelector("h4");
    if (!header) return;
    el.dataset.draggable = "1";
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    let drag = null;
    header.addEventListener("pointerdown", e => {
        if (e.target.closest("button,input,select,a")) return;
        if (e.target.closest("[id$='Close']")) return; // × must stay clickable (preventDefault would eat the click)
        // bring the grabbed panel above its siblings
        el.style.zIndex = String(++floatZ);
        const r = el.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        try { header.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
    });
    header.addEventListener("pointermove", e => {
        if (!drag) return;
        el.style.left = Math.max(0, e.clientX - drag.dx) + "px";
        el.style.top = Math.max(0, e.clientY - drag.dy) + "px";
        el.dataset.moved = "1"; // user owns the position from here on
    });
    const end = () => {
        if (!drag) return;
        drag = null;
        try { saveUI(); } catch {}
    };
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
}
function panelVisible(el) {
    return !!el && el.style.display !== "none" && el.style.display !== "";
}
function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
// If el (just shown/grown) covers another open floating panel, cascade it
// below; if that runs off-screen, dock it right of the other panel instead.
// Panels the user dragged themselves are never auto-moved.
function avoidPanelOverlap(el) {
    if (!panelVisible(el) || el.dataset.moved) return;
    const others = ["device-panel", "template-panel", "session-panel", "builder-panel"]
        .map(id => document.getElementById(id))
        .filter(o => o && o !== el && panelVisible(o));
    let moved = false;
    for (const o of others) {
        const r = el.getBoundingClientRect(), q = o.getBoundingClientRect();
        if (!rectsOverlap(r, q)) continue;
        const below = q.bottom + 8;
        if (below + Math.min(r.height, 300) > window.innerHeight) {
            el.style.left = Math.min(q.right + 8, Math.max(0, window.innerWidth - r.width - 8)) + "px";
            el.style.top = "58px";
        } else {
            el.style.top = below + "px";
        }
        moved = true;
    }
    if (moved) { try { saveUI(); } catch {} }
}
makeFloatingDraggable(document.getElementById("device-panel"));
makeFloatingDraggable(document.getElementById("template-panel"));
makeFloatingDraggable(document.getElementById("session-panel"));
makeFloatingDraggable(document.getElementById("builder-panel"));
// fix any overlap restored from a previous session
avoidPanelOverlap(document.getElementById("template-panel"));
avoidPanelOverlap(document.getElementById("session-panel"));
avoidPanelOverlap(document.getElementById("device-panel"));
// populate panels restored visible (their content loads on toggle otherwise)
if (panelVisible(document.getElementById("template-panel"))) loadCourseTemplates();
if (panelVisible(document.getElementById("session-panel"))) loadSessions();

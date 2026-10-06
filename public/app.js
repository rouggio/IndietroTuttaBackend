const map = L.map('map').setView([39.92, 9.65], 13);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '&copy; OpenStreetMap',
        referrerPolicy: 'strict-origin-when-cross-origin'
    }
).addTo(map);

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
        <h4>${boatDisplayName(panel.id, p)} <span style="float:right;cursor:pointer" onclick="closeBoatPanel('${panel.id}')">×</span></h4>
        <table>
            <tr><td>Speed</td><td>${typeof p.speed === "number" ? p.speed.toFixed(1) : "-"} knots</td></tr>
            <tr><td>Course</td><td>${p.course ?? "-"}°</td></tr>
            <tr><td>Time</td><td>${fmtTime(p.timestamp || p.receivedAt)}</td></tr>
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
    const nearest = findNearestPoint(e.latlng);
    if (nearest) { openBoatPanel(nearest.deviceId, nearest); jumpTimelineTo(nearest); }
    else closeAllBoatPanels();
});
// Hover anywhere on the map (wide radius — thin route lines are hard to hit)
map.on("mousemove", e => {
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
                "builder-panel": document.getElementById("builder-panel")?.style.display,
                "race-panel": document.getElementById("race-panel")?.style.display,
                "playback": document.getElementById("playback")?.style.display,
            },
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
        if (d.panels) Object.entries(d.panels).forEach(([id, disp]) => { const el=document.getElementById(id); if(el && disp) el.style.display=disp; });
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
                        <div class="device-meta" style="color:${statusColor};font-weight:600">${status}</div>
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
                toggleBoatPanel(el.getAttribute("data-id"));
            });
        });

    } catch (e) {
        console.error("devices refresh failed", e);
    }
}

let firstFit = true; // viewport moves only on explicit recenter or first load
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

// --- Course Builder ---
const templateSelect = document.getElementById("templateSelect");
const createCourseBtn = document.getElementById("createCourseBtn");
const courseListEl = document.getElementById("course-list");
const courseEditor = document.getElementById("course-editor");
const courseNameEl = document.getElementById("courseName");
const courseDescEl = document.getElementById("courseDesc");
const markListEl = document.getElementById("mark-list");
const saveCourseBtn = document.getElementById("saveCourseBtn");
const cancelCourseBtn = document.getElementById("cancelCourseBtn");
const deleteCourseBtn = document.getElementById("deleteCourseBtn");
const toggleBuilderBtn = document.getElementById("toggleBuilderBtn");

let templates = [];
let courses = [];
let editingId = null;
let editingMarks = [];
let builderMarkers = [];
let builderPolyline = null;

async function loadTemplates() {
    try {
        const res = await fetch("/courses/templates");
        templates = await res.json();
        templateSelect.innerHTML = templates.map(t => `<option value="${t.id}">${t.name} — ${t.description}</option>`).join("");
    } catch (e) { templateSelect.innerHTML = '<option>Failed to load</option>'; }
}

async function loadCourses() {
    try {
        const res = await fetch("/courses");
        courses = await res.json();
        renderCourseList();
    } catch (e) { console.error(e); }
}

function renderCourseList() {
    if (courses.length === 0) {
        courseListEl.innerHTML = '<div class="device-meta">No courses yet — pick a template</div>';
        return;
    }
    courseListEl.innerHTML = courses.map(c => `
        <div class="course-item ${editingId===c.id?'active':''}" data-id="${c.id}">
            <div><strong>${c.name}</strong> <span class="device-meta">v${c.version} • ${c.marks.length} marks</span></div>
            <div class="device-meta">${c.description||''}</div>
        </div>
    `).join("");
    courseListEl.querySelectorAll(".course-item").forEach(el => {
        el.addEventListener("click", () => startEdit(el.getAttribute("data-id")));
    });
}

function renderBuilder() {
    // clear old markers/polyline
    builderMarkers.forEach(m => map.removeLayer(m));
    builderMarkers = [];
    if (builderPolyline) { map.removeLayer(builderPolyline); builderPolyline = null; }

    if (editingMarks.length === 0) {
        markListEl.innerHTML = '<div class="device-meta">Click map to add marks</div>';
        return;
    }

    const latlngs = [];
    editingMarks.forEach((m, idx) => {
        const lat = m.lat != null ? m.lat : (map.getCenter().lat + (m.latOffset||0));
        const lon = m.lon != null ? m.lon : (map.getCenter().lng + (m.lonOffset||0));
        // keep absolute for editing
        m.lat = lat; m.lon = lon; delete m.latOffset; delete m.lonOffset;
        latlngs.push([lat, lon]);

        const marker = L.marker([lat, lon], {
            draggable: true,
            icon: L.divIcon({ className: 'builder-marker', html: `${idx+1}`, iconSize: [22,22] })
        }).addTo(map);
        marker.on('dragend', e => {
            const ll = e.target.getLatLng();
            m.lat = ll.lat; m.lon = ll.lng;
            renderBuilder();
        });
        marker.bindPopup(`Mark ${idx+1}<br><small>${lat.toFixed(5)}, ${lon.toFixed(5)}</small>`);
        builderMarkers.push(marker);
    });

    builderPolyline = L.polyline(latlngs, { color: '#f59e0b', weight: 3, dashArray: '8 8' }).addTo(map);

    markListEl.innerHTML = editingMarks.map((m, idx) => `
        <div class="mark-row">
            <span style="min-width:20px;font-weight:bold">${idx+1}</span>
            <span style="flex:1">${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}</span>
            <select data-idx="${idx}" data-field="side">
                <option value="P" ${m.side==='P'?'selected':''}>P</option>
                <option value="S" ${m.side==='S'?'selected':''}>S</option>
                <option value="G" ${m.side==='G'?'selected':''}>G</option>
            </select>
            <input type="number" data-idx="${idx}" data-field="radius" value="${m.radius||30}" style="width:50px" title="radius m">
            <button data-idx="${idx}" data-action="remove" style="background:#fee2e2">×</button>
        </div>
    `).join("");

    markListEl.querySelectorAll("select, input").forEach(el => {
        el.addEventListener("change", e => {
            const idx = +e.target.getAttribute("data-idx");
            const field = e.target.getAttribute("data-field");
            editingMarks[idx][field] = field === 'radius' ? parseInt(e.target.value,10) : e.target.value;
        });
    });
    markListEl.querySelectorAll("button[data-action='remove']").forEach(el => {
        el.addEventListener("click", e => {
            const idx = +e.target.getAttribute("data-idx");
            editingMarks.splice(idx, 1);
            renderBuilder();
        });
    });
}

function startEdit(id) {
    const c = courses.find(x => x.id === id);
    if (!c) return;
    editingId = id;
    editingMarks = JSON.parse(JSON.stringify(c.marks));
    courseNameEl.value = c.name;
    courseDescEl.value = c.description || "";
    courseEditor.style.display = "block";
    renderCourseList();
    renderBuilder();
    if (editingMarks.length > 0) {
        const bounds = L.latLngBounds(editingMarks.map(m => [m.lat || (map.getCenter().lat + m.latOffset), m.lon || (map.getCenter().lng + m.lonOffset)]));
        map.fitBounds(bounds.pad(0.3));
    }
}

function startNewFromTemplate() {
    const tid = templateSelect.value;
    const tmpl = templates.find(t => t.id === tid);
    if (!tmpl) return;
    const center = map.getCenter();
    editingId = null;
    editingMarks = tmpl.marks.map(m => ({
        lat: center.lat + (m.latOffset || 0),
        lon: center.lng + (m.lonOffset || 0),
        radius: m.radius || 30,
        side: m.side || "P",
        type: m.type || "mark"
    }));
    courseNameEl.value = tmpl.name + " Copy";
    courseDescEl.value = tmpl.description || "";
    courseEditor.style.display = "block";
    renderBuilder();
}

createCourseBtn.addEventListener("click", startNewFromTemplate);
cancelCourseBtn.addEventListener("click", () => {
    editingId = null;
    editingMarks = [];
    courseEditor.style.display = "none";
    builderMarkers.forEach(m => map.removeLayer(m)); builderMarkers = [];
    if (builderPolyline) { map.removeLayer(builderPolyline); builderPolyline = null; }
    renderCourseList();
});
deleteCourseBtn.addEventListener("click", async () => {
    if (!editingId) return;
    if (!confirm("Delete course?")) return;
    await fetch(`/courses/${editingId}`, { method: "DELETE" });
    editingId = null; editingMarks = []; courseEditor.style.display = "none";
    await loadCourses(); renderBuilder();
});
saveCourseBtn.addEventListener("click", async () => {
    const name = courseNameEl.value.trim();
    if (!name) { alert("Name required"); return; }
    if (editingMarks.length === 0) { alert("Add at least one mark"); return; }
    const payload = { name, description: courseDescEl.value, marks: editingMarks };
    if (editingId) {
        await fetch(`/courses/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } else {
        const res = await fetch("/courses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const created = await res.json();
        editingId = created.id;
    }
    await loadCourses(); renderCourseList(); renderBuilder();
});
toggleBuilderBtn.addEventListener("click", () => {
    const content = document.getElementById("builder-content");
    const hidden = content.style.display === "none";
    content.style.display = hidden ? "block" : "none";
    toggleBuilderBtn.textContent = hidden ? "▾" : "▸";
});

map.on("click", e => {
    if (courseEditor.style.display === "none") return;
    editingMarks.push({ lat: e.latlng.lat, lon: e.latlng.lng, radius: 30, side: "P", type: "mark" });
    renderBuilder();
});

loadTemplates();
loadCourses();

// --- Race Builder ---
const raceListEl = document.getElementById("race-list");
const newRaceBtn = document.getElementById("newRaceBtn");
const raceEditor = document.getElementById("race-editor");
const raceNameEl = document.getElementById("raceName");
const raceCourseSelect = document.getElementById("raceCourseSelect");
const raceStartTimeEl = document.getElementById("raceStartTime");
const raceStatusEl = document.getElementById("raceStatus");
const raceParticipantsEl = document.getElementById("raceParticipants");
const saveRaceBtn = document.getElementById("saveRaceBtn");
const cancelRaceBtn = document.getElementById("cancelRaceBtn");
const deleteRaceBtn = document.getElementById("deleteRaceBtn");
const toggleRaceBtn = document.getElementById("toggleRaceBtn");

let races = [];
let editingRaceId = null;
let allDevicesForRace = [];

async function loadRaces() {
    try {
        const res = await fetch("/races");
        races = await res.json();
        renderRaceList();
        // also refresh course dropdown
        raceCourseSelect.innerHTML = '<option value="">-- Course --</option>' + courses.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
    } catch (e) { console.error(e); }
}

function renderRaceList() {
    if (races.length === 0) {
        raceListEl.innerHTML = '<div class="device-meta">No races yet</div>';
        return;
    }
    raceListEl.innerHTML = races.map(r => {
        const courseName = courses.find(c => c.id === r.courseId)?.name || (r.courseId ? r.courseId.slice(0,6) : "no course");
        const when = r.startTime ? new Date(r.startTime).toLocaleString() : "no start";
        const count = r.participants ? r.participants.length : 0;
        return `
            <div class="race-item ${editingRaceId===r.id?'active':''}" data-id="${r.id}">
                <div><strong>${r.name}</strong> <span class="device-meta">${r.status}</span></div>
                <div class="device-meta">${courseName} • ${when} • ${count} boats</div>
            </div>
        `;
    }).join("");
    raceListEl.querySelectorAll(".race-item").forEach(el => {
        el.addEventListener("click", () => startEditRace(el.getAttribute("data-id")));
    });
}

function renderRaceParticipants() {
    if (allDevicesForRace.length === 0) {
        raceParticipantsEl.innerHTML = '<div class="device-meta">No boats</div>';
        return;
    }
    const selected = new Set((races.find(r=>r.id===editingRaceId)?.participants) || []);
    // if editing, use current editor selection? For new race, use empty
    // For editing, we need to track checked state from DOM or from editingRace participants
    // We'll read from editingRaceId's race object if exists, else from current checkbox state
    const currentSelected = editingRaceId ? (races.find(r=>r.id===editingRaceId)?.participants || []) : [];
    const currentSet = new Set(currentSelected);
    // But if user has toggled checkboxes, we need to preserve — instead read from DOM before re-render? Simpler: rebuild from currentSet
    raceParticipantsEl.innerHTML = allDevicesForRace.map(d => {
        const checked = currentSet.has(d.deviceId) ? "checked" : "";
        const name = d.username ? `${d.username} (${d.deviceId.slice(-5)})` : d.deviceId;
        return `<label style="display:flex;align-items:center;gap:6px;padding:2px 0"><input type="checkbox" value="${d.deviceId}" ${checked}> <span>${name}</span> <span class="device-meta">${d.status}</span></label>`;
    }).join("");
}

async function refreshDevicesForRace() {
    try {
        const res = await fetch("/boats");
        allDevicesForRace = await res.json();
        if (raceEditor.style.display !== "none") renderRaceParticipants();
    } catch {}
}

function startEditRace(id) {
    const r = races.find(x => x.id === id);
    if (!r) return;
    editingRaceId = id;
    raceNameEl.value = r.name;
    raceCourseSelect.value = r.courseId || "";
    raceStatusEl.value = r.status || "scheduled";
    // datetime-local needs local format: YYYY-MM-DDTHH:mm
    if (r.startTime) {
        const d = new Date(r.startTime);
        const pad = n => String(n).padStart(2,"0");
        raceStartTimeEl.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
        raceStartTimeEl.value = "";
    }
    raceEditor.style.display = "block";
    renderRaceList();
    refreshDevicesForRace();
}

function startNewRace() {
    editingRaceId = null;
    raceNameEl.value = "";
    raceCourseSelect.value = "";
    raceStartTimeEl.value = "";
    raceStatusEl.value = "scheduled";
    raceEditor.style.display = "block";
    refreshDevicesForRace();
}

newRaceBtn.addEventListener("click", startNewRace);
cancelRaceBtn.addEventListener("click", () => {
    editingRaceId = null;
    raceEditor.style.display = "none";
    renderRaceList();
});
deleteRaceBtn.addEventListener("click", async () => {
    if (!editingRaceId) return;
    if (!confirm("Delete race?")) return;
    await fetch(`/races/${editingRaceId}`, { method: "DELETE" });
    editingRaceId = null; raceEditor.style.display = "none";
    await loadRaces();
});
saveRaceBtn.addEventListener("click", async () => {
    const name = raceNameEl.value.trim();
    if (!name) { alert("Name required"); return; }
    const courseId = raceCourseSelect.value || null;
    const startTime = raceStartTimeEl.value ? new Date(raceStartTimeEl.value).toISOString() : null;
    const status = raceStatusEl.value;
    const participants = Array.from(raceParticipantsEl.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    const payload = { name, courseId, startTime, status, participants };
    if (editingRaceId) {
        await fetch(`/races/${editingRaceId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } else {
        const res = await fetch("/races", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const created = await res.json();
        editingRaceId = created.id;
    }
    await loadRaces();
    renderRaceList();
});
toggleRaceBtn.addEventListener("click", () => {
    const content = document.getElementById("race-content");
    const hidden = content.style.display === "none";
    content.style.display = hidden ? "block" : "none";
    toggleRaceBtn.textContent = hidden ? "▾" : "▸";
});

// Re-render race list when courses/devices change
const origLoadCourses = loadCourses;
loadCourses = async function() {
    await origLoadCourses();
    // refresh race course dropdown if races loaded
    raceCourseSelect.innerHTML = '<option value="">-- Course --</option>' + courses.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
    await loadRaces();
};

loadRaces();
refreshDevicesForRace();
setInterval(() => { if (document.getElementById("race-editor").style.display === "none") loadRaces(); }, 8000);

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
    boatsBtn.addEventListener("click", () => { toggleEl("device-panel"); syncBoatsBtn(); saveUI(); });
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
// Courses/Races are not ready: show their menus only on local dev, hide in production
if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
    document.getElementById("coursesMenu")?.remove();
    document.getElementById("racesMenu")?.remove();
}
document.querySelectorAll("#topbar-menu [data-action]").forEach(a => {
    a.addEventListener("click", (e) => {
        e.preventDefault();
        const act = a.getAttribute("data-action");
        if (act === "courses-new") { toggleEl("builder-panel", true); document.getElementById("createCourseBtn")?.click(); }
        else if (act === "courses-list") toggleEl("builder-panel", true);
        else if (act === "courses-hide") toggleEl("builder-panel", false);
        else if (act === "races-new") { toggleEl("race-panel", true); document.getElementById("newRaceBtn")?.click(); }
        else if (act === "races-list") toggleEl("race-panel", true);
        else if (act === "races-past") { toggleEl("race-panel", true); document.getElementById("past-races-section")?.scrollIntoView({behavior:"smooth", block:"center"}); }
        else if (act === "races-hide") toggleEl("race-panel", false);
        // close dropdown after click
        a.closest(".dropdown")?.classList.remove("active");
        saveUI();
    });
});

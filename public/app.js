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

const info = L.control({ position: "topright" });

info.onAdd = function () {
    this._div = L.DomUtil.create("div", "gps-info");
    this.update();
    return this._div;
};

let detailsPoint = null;
let allPoints = [];
info.update = function (p) {
    if (!p) {
        this._div.style.display = "none";
        detailsPoint = null;
        return;
    }
    detailsPoint = p;
    this._div.innerHTML = `
        <h4>Details <span style="float:right;cursor:pointer" onclick="info.update(null)">×</span></h4>
        <table>
            <tr><td>Boat</td><td>${p.username ? `<b>${p.username}</b>` : "-"}</td></tr>
            <tr><td>Lat</td><td>${p.lat.toFixed(6)}</td></tr>
            <tr><td>Lon</td><td>${p.lon.toFixed(6)}</td></tr>
            <tr><td>Speed</td><td>${p.speed ?? "-"} knots</td></tr>
            <tr><td>Course</td><td>${p.course ?? "-"}°</td></tr>
            <tr><td>Altitude</td><td>${p.altitude ?? "-"} m</td></tr>
            <tr><td>Sats</td><td>${p.sats ?? "-"}</td></tr>
            <tr><td>Time</td><td>${p.timestamp}</td></tr>
        </table>
    `;
    this._div.style.display = "block";
};

info.addTo(map);

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
map.on("click", e => {
    const nearest = findNearestPoint(e.latlng);
    if (nearest) info.update(nearest);
    else info.update(null);
});
// prevent map click when clicking Details pane
info._div?.addEventListener?.("click", e => e.stopPropagation());


let marker = null;
let polyline = null;
let polylines = [];
let flaggedMarkers = [];
let fleetMarkers = [];

const palette = ["#e41a1c","#377eb8","#4daf4a","#984ea3","#ff7f00","#a65628","#f781bf","#1f77b4"];
const colorMap = new Map();
function colorForDevice(id) {
    if (!id) return palette[0];
    if (colorMap.has(id)) return colorMap.get(id);
    // assign next distinct color in order, fallback to hash if palette exhausted
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

const UI_KEY = "indietrotutta:ui";
function syncSelected() { selectedDeviceId = selectedDeviceIds.size ? [...selectedDeviceIds][0] : null; }
function saveUI() {
    try {
        const data = {
            selectedDeviceIds: [...selectedDeviceIds],
            selectedDeviceId: selectedDeviceId, // compat
            isLive,
            selectedDate,
            boatFilter: document.getElementById("boatFilter")?.value || "",
            panels: {
                "device-panel": document.getElementById("device-panel")?.style.display,
                "builder-panel": document.getElementById("builder-panel")?.style.display,
                "race-panel": document.getElementById("race-panel")?.style.display,
                "playback": document.getElementById("playback")?.style.display,
            },
            viewGpsVisible: info && info._div ? info._div.style.display !== "none" : true
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
        if (d.boatFilter !== undefined) { const el=document.getElementById("boatFilter"); if(el) el.value=d.boatFilter; }
        if (d.panels) Object.entries(d.panels).forEach(([id, disp]) => { const el=document.getElementById(id); if(el && disp) el.style.display=disp; });
        // restore boats button active state
        const dp=document.getElementById("device-panel"), bb=document.getElementById("boatsToggleBtn");
        if(dp && bb) bb.classList.toggle("active", dp.style.display!=="none" && dp.style.display!=="");
        // viewGpsVisible will be applied after info added to map
        if (d.viewGpsVisible === false && info && info._div) info._div.style.display="none";
    } catch {}
}

// --- Controls: Live vs date ---
const liveBtn = document.getElementById("liveBtn");
const datePicker = document.getElementById("datePicker");
const dateLabel = document.getElementById("dateLabel");

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

let isLive = true;
let selectedDate = todayStr();
datePicker.value = selectedDate;
dateLabel.textContent = "Live — Today";
loadUI();
datePicker.value = selectedDate;
dateLabel.textContent = isLive ? "Live — Today" : (selectedDate === todayStr() ? "Today" : selectedDate);
if (isLive) liveBtn.classList.add("active"); else liveBtn.classList.remove("active");

liveBtn.addEventListener("click", () => {
    isLive = true;
    selectedDate = todayStr();
    datePicker.value = selectedDate;
    dateLabel.textContent = "Live — Today";
    liveBtn.classList.add("active");
    saveUI();
    refresh();
});

datePicker.addEventListener("change", () => {
    if (!datePicker.value) return;
    selectedDate = datePicker.value;
    isLive = false;
    liveBtn.classList.remove("active");
    dateLabel.textContent = selectedDate === todayStr() ? "Today" : selectedDate;
    saveUI();
    refresh();
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

        list.innerHTML = filtered.map(d => {
            const status = d.status || "offline";
            const isActive = selectedDeviceIds.has(d.deviceId);
            const shortId = d.deviceId ? d.deviceId.slice(-5) : "";
            const name = d.username ? `${d.username} <span class="device-meta">${shortId}</span>` : (d.deviceId || "-");
            const lastSeen = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "-";
            const routeColor = colorForDevice(d.deviceId);
            const statusColor = status === "live" ? "#16a34a" : status === "idle" ? "#f59e0b" : "#9ca3af";
            return `
                <div class="device-item ${isActive ? "active" : ""}" data-id="${d.deviceId}" style="cursor:pointer">
                    <div style="display:flex;align-items:center;gap:6px;overflow:hidden;flex:1">
                        <span style="width:12px;height:12px;border-radius:3px;background:${routeColor};border:1px solid rgba(0,0,0,.1);flex-shrink:0" title="Route color"></span>
                        <span class="device-name">${name}</span>
                    </div>
                    <div style="text-align:right">
                        <div class="device-meta" style="color:${statusColor};font-weight:600">${status}</div>
                        <div class="device-meta">${lastSeen}</div>
                    </div>
                </div>
            `;
        }).join("");

        // click to filter by device (multi-select)
        list.querySelectorAll(".device-item").forEach(el => {
            el.addEventListener("click", () => {
                const id = el.getAttribute("data-id");
                if (selectedDeviceIds.has(id)) selectedDeviceIds.delete(id); else selectedDeviceIds.add(id);
                syncSelected();
                saveUI();
                updateTimelineTracks();
                refresh();
                refreshDevices();
            });
        });

    } catch (e) {
        console.error("devices refresh failed", e);
    }
}

async function refresh() {

    let points = [];
    if (selectedDeviceIds.size > 0) {
        try {
            const ids = [...selectedDeviceIds];
            const all = await Promise.all(ids.map(async id => {
                const params = new URLSearchParams();
                if (selectedDate) params.set("date", selectedDate);
                params.set("deviceId", id);
                const r = await fetch(`/gps?${params.toString()}`);
                if (!r.ok) return [];
                return r.json();
            }));
            points = all.flat().sort((a,b) => new Date(a.timestamp||a.receivedAt) - new Date(b.timestamp||b.receivedAt));
        } catch (e) {
            console.error("filtered fetch failed", e);
            points = [];
        }
    } else {
        try {
            const devRes = await fetch("/boats");
            const boats = await devRes.json();
            const all = await Promise.all(boats.map(async b => {
                const p = new URLSearchParams();
                if (selectedDate) p.set("date", selectedDate);
                p.set("deviceId", b.deviceId);
                const r = await fetch(`/gps?${p.toString()}`);
                if (!r.ok) return [];
                return r.json();
            }));
            points = all.flat().sort((a,b) => new Date(a.timestamp||a.receivedAt) - new Date(b.timestamp||b.receivedAt));
        } catch (e) {
            console.error("fleet fetch failed", e);
            points = [];
        }
    }

    allPoints = points;
    // Update label with count
    const filterSuffix = selectedDeviceIds.size ? ` • ${selectedDeviceIds.size} selected` : "";
    if (isLive) {
        dateLabel.textContent = `Live — Today (${points.length})${filterSuffix}`;
    } else {
        dateLabel.textContent = `${selectedDate} (${points.length})${filterSuffix}`;
    }

    if (points.length === 0) {
        if (polyline) { map.removeLayer(polyline); polyline = null; }
        polylines.forEach(l => map.removeLayer(l)); polylines = [];
        if (marker) { map.removeLayer(marker); marker = null; }
        fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
        flaggedMarkers.forEach(m => m.remove());
        flaggedMarkers = [];
        info.update(null);
        return;
    }

    // clear previous tracks
    if (polyline) { map.removeLayer(polyline); polyline = null; }
    polylines.forEach(l => map.removeLayer(l)); polylines = [];
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];

    // multi-select: one polyline per boat, each with its route color
    const byDevice = new Map();
    points.forEach(p => {
        const id = p.deviceId || "unknown";
        if (!byDevice.has(id)) byDevice.set(id, []);
        byDevice.get(id).push([p.lat, p.lon]);
    });
    byDevice.forEach((latlngs, id) => {
        const line = L.polyline(latlngs, { color: colorForDevice(id), weight: 2, opacity: 0.6 }).addTo(map);
        line.on("click", e => { const n = findNearestPoint(e.latlng); if (n) { info.update(n); L.DomEvent.stop(e); } });
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
            const m = L.circleMarker([p.lat, p.lon], { radius: 5, fillColor: colorForDevice(p.deviceId), color: "white", weight: 1, fillOpacity: 1 }).addTo(map).bindPopup(p.username ? `Latest<br><b>${p.username}</b><br><small>${p.deviceId.slice(-5)}</small>` : `Latest<br>${p.deviceId}`);
            m.on("click", () => info.update(p));
            fleetMarkers.push(m);
        });
        // keep single marker ref for single selection compat
        if (fleetMarkers.length === 1) { marker = fleetMarkers[0]; fleetMarkers = []; }
    } else {
        const latestByDevice = new Map();
        points.forEach(p => latestByDevice.set(p.deviceId, p));
        latestByDevice.forEach(p => {
            const m = L.circleMarker([p.lat, p.lon], { radius: 5, fillColor: colorForDevice(p.deviceId), color: "white", weight: 1, fillOpacity: 1 }).addTo(map).bindPopup(p.username ? `Latest<br><b>${p.username}</b><br><small>${p.deviceId.slice(-5)}</small>` : `Latest<br>${p.deviceId}`);
            m.on("click", () => info.update(p));
            fleetMarkers.push(m);
        });
    }

    // Fit bounds only for historical view or first load
    if (selectedDeviceIds.size > 0) {
        const allLatLngs = points.filter(p=> selectedDeviceIds.has(p.deviceId)).map(p => [p.lat, p.lon]);
        const bounds = L.latLngBounds(allLatLngs.length ? allLatLngs : points.map(p => [p.lat, p.lon]));
        if (!isLive || (!polyline || !polyline._map) && (polylines.length === 0 || !polylines[0]._map)) {
            map.fitBounds(bounds, { padding: [20, 20] });
        } else {
            map.panTo([latest.lat, latest.lon]);
        }
    } else {
        const allLatLngs = points.map(p => [p.lat, p.lon]);
        const bounds = L.latLngBounds(allLatLngs);
        if (!isLive || polylines.length === 0 || !polylines[0]._map) {
            map.fitBounds(bounds, { padding: [20, 20] });
        } else {
            map.panTo([latest.lat, latest.lon]);
        }
    }

    // Details pane: keep hidden until click near a point (or keep previous if still valid)
    if (detailsPoint) {
        const still = allPoints.find(p => p.id === detailsPoint.id || (p.lat===detailsPoint.lat && p.lon===detailsPoint.lon && p.deviceId===detailsPoint.deviceId));
        if (still) info.update(still); else info.update(null);
    } else {
        info.update(null);
    }
}

refresh();
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

function getDayBounds() {
    const d = isLive ? todayStr() : (selectedDate || todayStr());
    const start = new Date(d + "T00:00:00").getTime();
    const end = new Date(d + "T23:59:59.999").getTime();
    return { start, end };
}
function updateTimelineTracks() {
    if (!timelineTracksEl) return;
    timelineTracksEl.innerHTML = "";
    const bounds = getDayBounds();
    const dayMs = bounds.end - bounds.start || 1;
    const ids = selectedDeviceIds.size ? [...selectedDeviceIds] : [...new Set(allPoints.map(p=>p.deviceId))];
    if (ids.length === 0) return;
    ids.forEach((id, idx) => {
        const pts = allPoints.filter(p=>p.deviceId===id).sort((a,b)=> new Date(a.timestamp)-new Date(b.timestamp));
        if (!pts.length) return;
        const track = document.createElement("div");
        track.className = "timeline-track";
        track.style.top = (4 + idx*14) + "px";
        track.style.background = "#e5e7eb";
        const tFirst = new Date(pts[0].timestamp).getTime();
        const tLast = new Date(pts[pts.length-1].timestamp).getTime();
        const left = ((tFirst - bounds.start)/dayMs)*100;
        const width = ((tLast - tFirst)/dayMs)*100;
        const seg = document.createElement("div");
        seg.className = "timeline-segment";
        seg.style.left = Math.max(0, left) + "%";
        seg.style.width = Math.max(0.6, width) + "%";
        seg.style.background = colorForDevice(id);
        seg.title = id;
        track.appendChild(seg);
        timelineTracksEl.appendChild(track);
    });
    // height
    timelineTracksEl.parentElement.style.height = Math.max(24, 8 + ids.length*14) + "px";
}
function interpolatePosition(deviceId, timeMs) {
    const pts = allPoints.filter(p=>p.deviceId===deviceId).sort((a,b)=> new Date(a.timestamp)-new Date(b.timestamp));
    if (!pts.length) return null;
    const first = new Date(pts[0].timestamp).getTime();
    const last = new Date(pts[pts.length-1].timestamp).getTime();
    if (timeMs <= first) return pts[0];
    if (timeMs >= last) return pts[pts.length-1];
    for (let i=0;i<pts.length-1;i++) {
        const t1 = new Date(pts[i].timestamp).getTime();
        const t2 = new Date(pts[i+1].timestamp).getTime();
        if (timeMs >= t1 && timeMs <= t2) {
            const r = (timeMs - t1)/(t2 - t1 || 1);
            return { lat: pts[i].lat + (pts[i+1].lat - pts[i].lat)*r, lon: pts[i].lon + (pts[i+1].lon - pts[i].lon)*r, deviceId, username: pts[i].username, timestamp: new Date(timeMs).toISOString() };
        }
    }
    return pts[0];
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
        const m = L.circleMarker([pos.lat, pos.lon], { radius: 5, fillColor: colorForDevice(id), color: "white", weight: 1.5, fillOpacity: 1 }).addTo(map).bindPopup(`${pos.username||id}<br>${new Date(timeMs).toLocaleTimeString()}`);
        playbackMarkers.set(id, m);
    });
    if (ids.length === 1 && playbackMarkers.size === 1) {
        const only = [...playbackMarkers.values()][0];
        marker = only;
        playbackMarkers.clear();
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

function startPlayback() {
    if (playbackTimer) return;
    if (playbackTime === null) playbackTime = getDayBounds().start;
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
playSlider.addEventListener("input", e => {
    stopPlayback();
    const bounds = getDayBounds();
    const ratio = parseInt(e.target.value, 10) / 1000;
    const timeMs = bounds.start + ratio * (bounds.end - bounds.start);
    showTime(timeMs);
});
playSpeedSel.addEventListener("change", e => {
    playbackSpeed = parseInt(e.target.value, 10);
    if (playbackTimer) { stopPlayback(); startPlayback(); }
});
document.getElementById("timeline")?.addEventListener("click", e => {
    if (e.target === playSlider) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const bounds = getDayBounds();
    const timeMs = bounds.start + ratio * (bounds.end - bounds.start);
    stopPlayback();
    showTime(timeMs);
});
document.getElementById("playbackClose")?.addEventListener("click", () => { stopPlayback(); document.getElementById("playback").style.display="none"; saveUI(); });

// Hook into refresh to update timeline
const origRefresh = refresh;
refresh = async function() {
    if (playbackTimer) return origRefresh();
    await origRefresh();
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
document.getElementById("boatFilter")?.addEventListener("input", () => { saveUI(); refreshDevices(); });
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

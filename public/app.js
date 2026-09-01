const map = L.map('map').setView([39.92, 9.65], 13);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '&copy; OpenStreetMap',
        referrerPolicy: 'strict-origin-when-cross-origin'
    }
).addTo(map);

const info = L.control({ position: "topright" });

info.onAdd = function () {
    this._div = L.DomUtil.create("div", "gps-info");
    this.update();
    return this._div;
};

info.update = function (p) {
    if (!p) {
        this._div.innerHTML = "<b>Latest GPS</b><br>No data";
        return;
    }

    this._div.innerHTML = `
        <h4>Latest GPS</h4>
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
};

info.addTo(map);


let marker = null;
let polyline = null;
let polylines = [];
let flaggedMarkers = [];
let fleetMarkers = [];
let selectedDeviceId = null;

const palette = ["#2563eb","#dc2626","#16a34a","#ea580c","#9333ea","#0891b2","#be123c","#475569"];
function colorForDevice(id) {
    if (!id) return "#2563eb";
    let h = 0; for (let i=0;i<id.length;i++) h = (h*31 + id.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
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

liveBtn.addEventListener("click", () => {
    isLive = true;
    selectedDate = todayStr();
    datePicker.value = selectedDate;
    dateLabel.textContent = "Live — Today";
    liveBtn.classList.add("active");
    refresh();
});

datePicker.addEventListener("change", () => {
    if (!datePicker.value) return;
    selectedDate = datePicker.value;
    isLive = false;
    liveBtn.classList.remove("active");
    dateLabel.textContent = selectedDate === todayStr() ? "Today" : selectedDate;
    refresh();
});

// --- Device list ---
async function refreshDevices() {
    try {
        const res = await fetch("/boats");
        const devices = await res.json();
        const list = document.getElementById("device-list");

        if (devices.length === 0) {
            list.innerHTML = '<div class="device-meta">No boats yet</div>';
            return;
        }

        list.innerHTML = devices.map(d => {
            const status = d.status || "offline";
            const isActive = d.deviceId === selectedDeviceId;
            const shortId = d.deviceId ? d.deviceId.slice(-5) : "";
            const name = d.username ? `${d.username} <span class="device-meta">${shortId}</span>` : (d.deviceId || "-");
            const lastSeen = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "-";
            return `
                <div class="device-item ${isActive ? "active" : ""}" data-id="${d.deviceId}" style="cursor:pointer">
                    <div style="display:flex;align-items:center;overflow:hidden;flex:1">
                        <span class="dot ${status}"></span>
                        <span class="device-name">${name}</span>
                    </div>
                    <div style="text-align:right;margin-right:6px">
                        <div class="device-meta">${status}</div>
                        <div class="device-meta">${lastSeen}</div>
                    </div>
                    <button class="delete-boat-btn" data-id="${d.deviceId}" title="Delete boat" style="background:#fee2e2;color:#991b1b;border:none;border-radius:4px;padding:2px 6px;font-size:11px;cursor:pointer">×</button>
                </div>
            `;
        }).join("");

        // click to filter by device (ignore delete button)
        list.querySelectorAll(".device-item").forEach(el => {
            el.addEventListener("click", (e) => {
                if (e.target.closest(".delete-boat-btn")) return;
                const id = el.getAttribute("data-id");
                selectedDeviceId = selectedDeviceId === id ? null : id;
                refresh();
                refreshDevices();
            });
        });
        list.querySelectorAll(".delete-boat-btn").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute("data-id");
                if (!confirm(`Delete boat ${id} and its points?`)) return;
                await fetch(`/boats/${encodeURIComponent(id)}`, { method: "DELETE" });
                if (selectedDeviceId === id) selectedDeviceId = null;
                await refreshDevices();
                await refresh();
            });
        });

    } catch (e) {
        console.error("devices refresh failed", e);
    }
}

async function refresh() {

    const params = new URLSearchParams();
    // When not live, use selectedDate; when live, still filter to today so we don't pull years of data
    if (selectedDate) {
        params.set("date", selectedDate);
    }
    // Always fetch all boats' points — highlighting is client-side (all routes always displayed)

    const qs = params.toString() ? `?${params.toString()}` : "";
    const response = await fetch(`/gps${qs}`);
    const points = await response.json();

    // Update label with count
    if (isLive) {
        dateLabel.textContent = `Live — Today (${points.length})${selectedDeviceId ? " • filtered" : ""}`;
    } else {
        dateLabel.textContent = `${selectedDate} (${points.length})${selectedDeviceId ? " • filtered" : ""}`;
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

    const byDevice = new Map();
    points.forEach(p => {
        const id = p.deviceId || "unknown";
        if (!byDevice.has(id)) byDevice.set(id, []);
        byDevice.get(id).push([p.lat, p.lon]);
    });
    byDevice.forEach((latlngs, id) => {
        const isSelected = id === selectedDeviceId;
        const line = L.polyline(latlngs, { color: isSelected ? "#eab308" : colorForDevice(id), weight: isSelected ? 6 : 4, opacity: isSelected ? 1 : 0.85 }).addTo(map);
        polylines.push(line);
        if (isSelected) line.bringToFront();
    });

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

    const latestByDevice = new Map();
    points.forEach(p => latestByDevice.set(p.deviceId, p));
    latestByDevice.forEach(p => {
        const isSelected = p.deviceId === selectedDeviceId;
        const icon = L.divIcon({
            className: isSelected ? 'builder-marker' : 'fleet-marker',
            html: isSelected ? '⛵' : (p.username ? p.username[0].toUpperCase() : '?'),
            iconSize: isSelected ? [24,24] : [20,20],
            iconAnchor: isSelected ? [12,12] : [10,10]
        });
        const m = L.marker([p.lat, p.lon], { icon }).addTo(map).bindPopup(p.username ? `Latest<br><b>${p.username}</b>${isSelected ? '<br><em>selected</em>' : ''}` : `Latest`);
        if (isSelected) m.setZIndexOffset(1000);
        fleetMarkers.push(m);
    });
    // info shows selected boat if any, else overall latest
    const infoPoint = selectedDeviceId ? (latestByDevice.get(selectedDeviceId) || latest) : latest;

    // Fit bounds only for historical view or first load — always show all routes
    const allLatLngs = points.map(p => [p.lat, p.lon]);
    const bounds = L.latLngBounds(allLatLngs);
    const targetForPan = infoPoint;
    if (!isLive || polylines.length === 0 || !polylines[0]._map) {
        map.fitBounds(bounds, { padding: [20, 20] });
    } else {
        map.panTo([targetForPan.lat, targetForPan.lon]);
    }

    info.update(infoPoint);
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
let previewCourseId = null;
let previewMarkers = [];
let previewPolyline = null;
function clearPreview() { previewMarkers.forEach(m => map.removeLayer(m)); previewMarkers = []; if (previewPolyline) { map.removeLayer(previewPolyline); previewPolyline = null; } }
function previewCourse(id) {
    const c = courses.find(x => x.id === id);
    if (!c) return;
    previewCourseId = id;
    clearPreview();
    const latlngs = c.marks.map(m => [m.lat != null ? m.lat : (map.getCenter().lat + (m.latOffset||0)), m.lon != null ? m.lon : (map.getCenter().lng + (m.lonOffset||0))]);
    previewPolyline = L.polyline(latlngs, { color: '#a78bfa', weight: 3, dashArray: '6 6', opacity: 0.9 }).addTo(map);
    c.marks.forEach((m, idx) => {
        const lat = m.lat != null ? m.lat : (map.getCenter().lat + (m.latOffset||0));
        const lon = m.lon != null ? m.lon : (map.getCenter().lng + (m.lonOffset||0));
        const mk = L.marker([lat, lon], { icon: L.divIcon({ className: 'builder-marker', html: `${idx+1}`, iconSize: [18,18] }), interactive: false }).addTo(map);
        mk.bindPopup(`${c.name} — Mark ${idx+1}<br>${m.side||'P'} • ${m.radius||30}m`);
        previewMarkers.push(mk);
    });
    renderCourseList();
    if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
}

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
        <div class="course-item ${editingId===c.id?'active':''} ${previewCourseId===c.id?'active':''}" data-id="${c.id}" style="display:flex;justify-content:space-between;align-items:center">
            <div style="cursor:pointer;flex:1" data-action="preview">
                <div><strong>${c.name}</strong> <span class="device-meta">v${c.version} • ${c.marks.length} marks</span></div>
                <div class="device-meta">${c.description||''}</div>
            </div>
            <button class="editCourseBtn" data-id="${c.id}" style="margin-left:8px;background:#3b82f6;color:white">Edit</button>
        </div>
    `).join("");
    courseListEl.querySelectorAll("[data-action='preview']").forEach(el => {
        el.addEventListener("click", () => {
            const id = el.parentElement.getAttribute("data-id");
            if (previewCourseId === id) { clearPreview(); previewCourseId = null; renderCourseList(); }
            else previewCourse(id);
        });
    });
    courseListEl.querySelectorAll(".editCourseBtn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            clearPreview(); previewCourseId = null;
            startEdit(btn.getAttribute("data-id"));
        });
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
        const res = await fetch("/devices");
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

// --- Playback ---
const playBtn = document.getElementById("playBtn");
const playSlider = document.getElementById("playSlider");
const playSpeedSel = document.getElementById("playSpeed");
const playLabel = document.getElementById("playLabel");

let playbackPoints = [];
let playbackIdx = 0;
let playbackTimer = null;
let playbackSpeed = 1;

function getFleetSize() {
    if (selectedDeviceId) return 1;
    const s = new Set(playbackPoints.map(p => p.deviceId));
    return s.size || 1;
}
function getPlaybackSteps() {
    if (playbackPoints.length === 0) return 0;
    if (selectedDeviceId) return playbackPoints.length;
    const fleetSize = getFleetSize();
    return Math.ceil(playbackPoints.length / fleetSize);
}
function updatePlaybackSlider() {
    if (playbackPoints.length === 0) {
        playSlider.max = 100;
        playSlider.value = 0;
        playLabel.textContent = "0/0";
        return;
    }
    const steps = getPlaybackSteps();
    playSlider.max = steps - 1;
    playSlider.value = playbackIdx;
    playLabel.textContent = `${playbackIdx+1}/${steps}`;
}

function showPlaybackPoint(idx) {
    if (playbackPoints.length === 0) return;
    const steps = getPlaybackSteps();
    playbackIdx = Math.max(0, Math.min(idx, steps - 1));
    playSlider.value = playbackIdx;
    playLabel.textContent = `${playbackIdx+1}/${steps}`;

    if (selectedDeviceId) {
        const p = playbackPoints[playbackIdx];
        if (!p) return;
        const latlng = [p.lat, p.lon];
        if (marker) marker.setLatLng(latlng);
        else marker = L.marker(latlng).addTo(map);
        // hide fleet markers when filtered
        fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
        info.update(p);
        map.panTo(latlng);
    } else {
        const fleetSize = getFleetSize();
        const start = playbackIdx * fleetSize;
        const slice = playbackPoints.slice(start, start + fleetSize);
        // clear single marker, show fleet playback markers
        if (marker) { map.removeLayer(marker); marker = null; }
        fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
        slice.forEach(p => {
            const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'builder-marker', html: p.username ? p.username[0] : '?', iconSize: [18,18], iconAnchor: [9,9] }) }).addTo(map);
            m.bindPopup(`${p.username||p.deviceId}<br>${p.timestamp}`);
            fleetMarkers.push(m);
        });
        if (slice[0]) {
            info.update(slice[0]);
            const center = slice.reduce((a,p)=>[a[0]+p.lat/slice.length, a[1]+p.lon/slice.length], [0,0]);
            map.panTo(center);
        }
    }
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
    showPlaybackPoint(parseInt(e.target.value, 10));
});

playSpeedSel.addEventListener("change", e => {
    playbackSpeed = parseInt(e.target.value, 10);
    if (playbackTimer) { stopPlayback(); startPlayback(); }
});

// Hook into refresh to update playbackPoints
const origRefresh = refresh;
refresh = async function() {
    // don't refresh map while playback is scrubbing
    if (playbackTimer) return origRefresh();
    await origRefresh();
    // after refresh, update playbackPoints from current gps data (filtered)
    try {
        const params = new URLSearchParams();
        if (selectedDate) params.set("date", selectedDate);
        if (selectedDeviceId) params.set("deviceId", selectedDeviceId);
        const qs = params.toString() ? `?${params.toString()}` : "";
        const res = await fetch(`/gps${qs}`);
        playbackPoints = await res.json();
        // keep idx in bounds (steps for fleet, flat for single)
        const steps = getPlaybackSteps();
        if (playbackIdx >= steps) playbackIdx = steps - 1;
        updatePlaybackSlider();
    } catch {}
};

// Initialize playback after first refresh
setTimeout(async () => {
    await refresh();
    playbackPoints = await (await fetch(`/gps?date=${todayStr()}`)).json().catch(()=>[]);
    updatePlaybackSlider();
}, 1000);

// Top bar dropdowns
document.querySelectorAll(".dropdown").forEach(dd => {
    const btn = dd.querySelector(".dropbtn");
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll(".dropdown").forEach(d => { if (d !== dd) d.classList.remove("active"); });
        dd.classList.toggle("active");
    });
});
document.addEventListener("click", () => {
    document.querySelectorAll(".dropdown").forEach(d => d.classList.remove("active"));
});
function showPanel(id) { const el = document.getElementById(id); if (el) el.style.display = "block"; }
function hidePanel(id) { const el = document.getElementById(id); if (el) el.style.display = "none"; }
document.querySelectorAll(".dropdown-content a").forEach(a => {
    a.addEventListener("click", (e) => {
        e.preventDefault();
        const action = a.getAttribute("data-action");
        document.querySelectorAll(".dropdown").forEach(d => d.classList.remove("active"));
        switch(action) {
            case "courses-new": showPanel("builder-panel"); document.getElementById("templateSelect")?.focus(); break;
            case "courses-list": showPanel("builder-panel"); break;
            case "courses-hide": hidePanel("builder-panel"); break;
            case "races-new": showPanel("race-panel"); document.getElementById("newRaceBtn")?.click(); break;
            case "races-list": showPanel("race-panel"); break;
            case "races-past": case "past-show": showPanel("race-panel"); document.getElementById("pastRaceSelect")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); document.getElementById("pastRaceSelect")?.focus(); break;
            case "races-hide": hidePanel("race-panel"); break;
            case "devices-show": showPanel("device-panel"); break;
            case "devices-hide": hidePanel("device-panel"); break;
            case "devices-clear-filter": selectedDeviceId = null; refresh(); refreshDevices(); break;
            case "past-load": document.getElementById("loadPastRaceBtn")?.click(); break;
            case "view-gps-toggle": const gpsPanel = document.querySelector(".gps-info"); if (gpsPanel) { const hidden = gpsPanel.style.display === "none" || getComputedStyle(gpsPanel).display === "none"; gpsPanel.style.display = hidden ? "block" : "none"; } break;
        }
    });
});

// Mode harmonisation: editor / live / replay
function setMode(mode) {
    document.querySelectorAll("#mode-switch button").forEach(b => b.classList.toggle("active", b.getAttribute("data-mode")===mode));
    const builder = document.getElementById("builder-panel");
    const race = document.getElementById("race-panel");
    const devices = document.getElementById("device-panel");
    const playback = document.getElementById("playback");
    const controls = document.getElementById("topbar-controls");
    const gpsInfo = document.querySelector(".gps-info");
    if (mode === "editor") {
        builder.style.display = "block"; race.style.display = "block"; devices.style.display = "block"; playback.style.display = "none"; controls.style.display = "none"; if (gpsInfo) gpsInfo.style.display = "none";
    } else if (mode === "live") {
        builder.style.display = "none"; race.style.display = "none"; devices.style.display = "block"; playback.style.display = "none"; controls.style.display = "flex"; if (gpsInfo) gpsInfo.style.display = "block";
    } else if (mode === "replay") {
        builder.style.display = "none"; race.style.display = "block"; devices.style.display = "block"; playback.style.display = "flex"; controls.style.display = "flex"; if (gpsInfo) gpsInfo.style.display = "block";
    }
    localStorage.setItem("mode", mode);
}
document.querySelectorAll("#mode-switch button").forEach(btn => {
    btn.addEventListener("click", () => setMode(btn.getAttribute("data-mode")));
});
setMode(localStorage.getItem("mode") || "live");

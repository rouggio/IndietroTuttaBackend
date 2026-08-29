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
            <tr><td>Device</td><td>${p.username
                ? `<b>${p.username}</b> <small>${p.deviceId ?? ""}</small>`
                : (p.deviceId ?? "-")}</td></tr>
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
let flaggedMarkers = [];
let selectedDeviceId = null;

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
        const res = await fetch("/devices");
        const devices = await res.json();
        const list = document.getElementById("device-list");

        if (devices.length === 0) {
            list.innerHTML = '<div class="device-meta">No devices yet</div>';
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
                    <div style="display:flex;align-items:center;overflow:hidden">
                        <span class="dot ${status}"></span>
                        <span class="device-name">${name}</span>
                    </div>
                    <div style="text-align:right">
                        <div class="device-meta">${status}</div>
                        <div class="device-meta">${lastSeen}</div>
                    </div>
                </div>
            `;
        }).join("");

        // click to filter by device
        list.querySelectorAll(".device-item").forEach(el => {
            el.addEventListener("click", () => {
                const id = el.getAttribute("data-id");
                selectedDeviceId = selectedDeviceId === id ? null : id;
                refresh();
                refreshDevices();
            });
        });

    } catch (e) {
        console.error("devices refresh failed", e);
    }
}

async function refresh() {

    const params = new URLSearchParams();
    // When not live, use selectedDate; when live, still filter to today so we don't pull years of data
    // If user wants all history, they can clear the date filter - but we default to today for live
    if (selectedDate) {
        params.set("date", selectedDate);
    }
    if (selectedDeviceId) {
        params.set("deviceId", selectedDeviceId);
    }

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
        if (marker) { map.removeLayer(marker); marker = null; }
        flaggedMarkers.forEach(m => m.remove());
        flaggedMarkers = [];
        info.update(null);
        return;
    }

    const latlngs = points.map(p => [p.lat, p.lon]);

    if (polyline) map.removeLayer(polyline);

    polyline = L.polyline(latlngs, {
        color: selectedDeviceId ? "#16a34a" : "blue",
        weight: 4
    }).addTo(map);

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

    const last = latlngs[latlngs.length - 1];
    const latest = points[points.length - 1];

    if (marker) marker.remove();

    marker = L.marker(last)
        .addTo(map)
        .bindPopup(latest.username
            ? `Latest position<br><b>${latest.username}</b>`
            : "Latest position");

    // Fit bounds only for historical view or first load
    if (!isLive || !polyline._map) {
        map.fitBounds(polyline.getBounds(), { padding: [20, 20] });
    } else {
        map.panTo(last);
    }

    info.update(latest);
}

refresh();
refreshDevices();

setInterval(() => {
    refreshDevices();
    if (isLive) refresh();
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

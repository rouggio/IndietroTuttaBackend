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

    let points = [];
    if (selectedDeviceId) {
        const params = new URLSearchParams();
        if (selectedDate) params.set("date", selectedDate);
        params.set("deviceId", selectedDeviceId);
        const res = await fetch(`/gps?${params.toString()}`);
        if (res.ok) points = await res.json();
        else points = [];
    } else {
        // All fleet: fetch per boat and merge (GET /gps now requires deviceId)
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

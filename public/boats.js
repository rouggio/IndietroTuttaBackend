// boats.js — split from app.js. Boat selection set, per-boat panels, info modal, sailing-days calendar.
// Load order is index.html script order; cross-file names resolve at call time.
let selectedDeviceIds = new Set();

// --- Per-boat details panels (title = boat name, toggled from the boats list) ---
const boatPanels = new Map(); // deviceId -> { id, control, point, expanded, open }
let panelsToRestore = new Set(); // open panels persisted across reloads
let allPoints = [];
function boatDisplayName(id, fallbackPoint) {
    const d = lastDevices.find(x => x.deviceId === id);
    const name = (d && d.username) || (fallbackPoint && fallbackPoint.username) || null;
    return name || (id ? id.slice(-5) : "-");
}
// Date + time, short numeric date: "10/10/2026, 23:14:09".
// A track can span days (or, for a multi-day range, weeks), so a bare
// clock time is ambiguous about which day the fix belongs to.
function fmtDateTime(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleString([], {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
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
        <h4>${boatDisplayName(panel.id, p)}<span class="pane-actions"><span class="pane-btn" title="Center map on boat" onclick="centerBoatOnMap('${panel.id}')">⌖</span><span class="pane-btn" title="Boat info" onclick="openBoatInfo('${panel.id}')">ⓘ</span><span class="pane-btn pane-close" title="Close" onclick="closeBoatPanel('${panel.id}')">×</span></span></h4>
        <table>
            <tr><td>Speed</td><td>${typeof p.speed === "number" ? p.speed.toFixed(1) : "-"} knots</td></tr>
            <tr><td>Course</td><td>${p.course ?? "-"}&deg;</td></tr>
            <tr><td>Time</td><td>${fmtDateTime(p.timestamp || p.receivedAt)}</td></tr>
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
                <tr><td>GPS fix</td><td>${d.mock ? "MOCK (simulated)" : "REAL (receiver)"} <button id="boat-info-mock" title="Toggle mock GPS via the device portal over LAN">→ ${d.mock ? "Real" : "Mock"}</button></td></tr>
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
    document.getElementById("boat-info-mock").addEventListener("click", () => toggleBoatMock(id, !boatRecord(id)?.mock));
};
window.toggleBoatMock = async function (id, on) {
    const errEl = document.getElementById("boat-info-err");
    if (errEl) errEl.textContent = on ? "Switching to mock GPS…" : "Switching to real GPS…";
    try {
        const res = await fetch(`/boats/${encodeURIComponent(id)}/mock`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ on: !!on }),
        });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            if (errEl) errEl.textContent = res.status === 409
                ? "Device has no known LAN address (offline or never seen on LAN)."
                : (j.error || `Toggle failed (${res.status})`);
            return;
        }
        await refreshDevices();
        openBoatInfo(id); // re-render with the new state
    } catch (e) {
        if (errEl) errEl.textContent = "Network error.";
    }
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
            <h4>📅… ${esc(name)} <span style="float:right;cursor:pointer" onclick="closeBoatCalendar()">×</span></h4>
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
    stopPlayback();
    setMode(false, "calendar");
    UI.timePreset = "custom";
    if (presetSelect) presetSelect.value = "custom";
    // cover the full UTC day (backend groups days in UTC) — round-trip via local picker values
    UI.customStart = toLocalDatetimeValue(new Date(dayStr + "T00:00:00.000Z"));
    UI.customEnd = toLocalDatetimeValue(new Date(dayStr + "T23:59:59.999Z"));
    if (startPicker) startPicker.value = UI.customStart;
    if (endPicker) endPicker.value = UI.customEnd;

    saveUI();
    playbackTime = new Date(UI.customStart).getTime();
    refresh(true);
};
async function resolveBoatPoint(id) {
    const cur = currentPointForBoat(id);
    if (cur) return cur;
    const sim = liveSimLatest(id);
    if (sim) return { ...sim, deviceId: id };
    try {
        const r = await fetch(`/gps/latest?deviceId=${encodeURIComponent(id)}`);
        if (r.ok) {
            const p = await r.json();
            if (p && typeof p.lat === "number") return p;
        }
    } catch {}
    return null;
}
async function openBoatPanel(id, point) {
    if (!id) return;
    const panel = getBoatPanel(id);
    panel.open = true;
    // A boat with no point in the current window (mock boat in replay, or an
    // empty range) would open an invisible panel. Fall back through the
    // live-sim buffer to the newest stored fix, so details always show.
    if (point) panel.point = point;
    else if (!panel.point) panel.point = await resolveBoatPoint(id);
    renderBoatPanel(panel);
}
function toggleBoatPanel(id) {
    const panel = getBoatPanel(id);
    if (panel.open) { panel.open = false; renderBoatPanel(panel); }
    else openBoatPanel(id);
}
// Newest live-sim fix for a boat (mock boats never reach Turso), else null.
function liveSimLatest(id) {
    const st = liveSim.get(id);
    return st && st.pts.length ? st.pts[st.pts.length - 1] : null;
}
// Boat's current point: follow playback cursor when playing/history, else latest
function currentPointForBoat(id) {
    const pts = allPoints.filter(p => p.deviceId === id);
    if (playbackTimer || !UI.isLive) {
        if (!pts.length) return null;
        let cur = null;
        for (const p of pts) {
            if (new Date(p.timestamp || p.receivedAt).getTime() <= playbackTime) cur = p;
            else break;
        }
        return cur || pts[0];
    }
    const db = pts.length ? pts[pts.length - 1] : null;
    const sim = liveSimLatest(id);
    if (!db) return sim ? { ...sim, deviceId: id } : null;
    if (!sim) return db;
    // newest wins (mock uploads never land in Turso, so their track is stale)
    const t = p => new Date(p.timestamp || p.receivedAt || 0).getTime();
    return t(sim) > t(db) ? { ...sim, deviceId: id } : db;
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

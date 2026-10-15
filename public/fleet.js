// fleet.js — split from app.js. Boat list + refreshTracks (stored tracks). No boot calls (see boot.js).
// Load order is index.html script order; cross-file names resolve at call time.
let lastDevices = [];
// --- Device list ---
async function refreshDevices() {
    try {
        const res = await fetch("/boats");
        lastDevices = await res.json();
        renderDevices();
    } catch (e) {
        console.error("devices refresh failed", e);
    }
}
// Patch one known boat in place (no fetch): event-driven updates re-render
// the list from lastDevices. Returns false when the boat isn't cached —
// the caller then falls back to a full refreshDevices().
function patchBoat(deviceId, patch) {
    const d = lastDevices.find(x => x.deviceId === deviceId);
    if (!d) return false;
    Object.assign(d, patch);
    renderDevices();
    return true;
}
function renderDevices() {
    try {
        const devices = lastDevices;
        // Prune ghost selections: a device deleted from the DB stays in the
        // persisted selection Set forever, and refresh()/pollLiveSim() would
        // keep polling it every cycle for rows that can never come back.
        const known = new Set(devices.map(d => d.deviceId));
        for (const id of [...selectedDeviceIds]) {
            if (!known.has(id)) selectedDeviceIds.delete(id);
        }
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
            const name = d.username || d.deviceId || "-";
            const lastSeen = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : "-";
            const routeColor = colorForDevice(d.deviceId);
            const lightBg = lightenColor(routeColor, 0.85);
            const statusColor = status === "live" ? "#16a34a" : status === "idle" ? "#f59e0b" : "#9ca3af";
            return `
                <div class="device-item ${isActive ? "active" : ""}" data-id="${d.deviceId}" style="cursor:pointer">
                    <div style="display:flex;align-items:center;gap:8px;overflow:hidden;flex:1">
                        <input type="checkbox" ${isActive ? "checked" : ""} data-check="${d.deviceId}" style="accent-color:${routeColor};width:14px;height:14px;flex-shrink:0">
                        <span class="device-name" style="border:1.5px solid ${routeColor};background:${lightBg};padding:2px 7px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${name}</span>
                    </div>
                    <div style="text-align:right">
                        <div class="device-meta" style="color:${statusColor};font-weight:600">${status} <span class="boat-cal-btn" data-cal="${d.deviceId}" title="Sailing days calendar">📅…</span></div>
                        <div class="device-meta">${lastSeen}${d.mock ? ` • MOCK` : ""}</div>
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

// Live cursor cache: per-boat points retained across 5s ticks so the live
// loop appends only the tail (GET /gps?since=) instead of re-pulling the
// whole range. Any selection/range change (or explicit recenter) invalidates
// the key and falls back to a full range fetch.
let liveKey = null;            // selection+range fingerprint of the cache
let liveCache = new Map();     // deviceId -> points[]
function liveCacheKey(ids, range) { return ids.join(",") + "|" + range.start + "-" + range.end; }
function livePointKey(p) { return p.id != null ? "id:" + p.id : "t:" + (p.timestamp || p.receivedAt) + ":" + p.lat + "," + p.lon; }
let firstFit = !restoredMapView; // viewport moves only on explicit recenter or first load (skipped when restoring last position)
async function refreshTracks(recenter = false) {

    let points = [];
    if (selectedDeviceIds.size > 0) {
        try {
            const ids = [...selectedDeviceIds];
            const range = getCurrentRange();
            const key = liveCacheKey(ids, range);
            // Cursor path: live mode, no playback, same selection+range as the
            // cached fetch, and the cache actually holds those boats.
            const useCursor = !recenter && UI.isLive && !playbackTimer && liveKey === key &&
                ids.every(id => liveCache.has(id));
            const all = await Promise.all(ids.map(async id => {
                const params = new URLSearchParams();
                params.set("deviceId", id);
                if (useCursor) {
                    const cur = liveCache.get(id);
                    const last = cur.length ? cur[cur.length - 1] : null;
                    params.set("since", new Date(last ? (last.timestamp || last.receivedAt) : range.start).toISOString());
                } else {
                    // use rich range (start/end ISO) — backend filters by timestamp
                    params.set("start", new Date(range.start).toISOString());
                    params.set("end", new Date(range.end).toISOString());
                }
                const r = await fetch(`/gps?${params.toString()}`);
                if (!r.ok) return [];
                return r.json();
            }));
            if (useCursor) {
                // append + dedupe per boat, then drop anything outside the range
                ids.forEach((id, i) => {
                    const cur = liveCache.get(id);
                    const seen = new Set(cur.map(livePointKey));
                    for (const p of (all[i] || [])) {
                        const k = livePointKey(p);
                        if (!seen.has(k)) { seen.add(k); cur.push(p); }
                    }
                    liveCache.set(id, cur.filter(p => {
                        const t = new Date(p.timestamp || p.receivedAt).getTime();
                        const win = (UI.isLive && !playbackTimer && !isLiveWatch()) ? liveWindowMs() : 0;
                        const lo = win ? Math.max(range.start, Date.now() - win) : range.start;
                        return !isNaN(t) && t >= lo && t <= range.end;
                    }));
                });
                points = [...liveCache.values()].flat();
            } else {
                liveCache = new Map();
                for (const id of ids) liveCache.set(id, []);
                for (const p of all.flat()) {
                    if (!liveCache.has(p.deviceId)) liveCache.set(p.deviceId, []);
                    liveCache.get(p.deviceId).push(p);
                }
                liveKey = key;
                points = all.flat();
            }
            points = points.sort((a,b) => new Date(a.timestamp||a.receivedAt) - new Date(b.timestamp||b.receivedAt));
            // client-side guard: only keep points inside selected time range
            const _range = getCurrentRange();
            // In plain LIVE the topbar window narrows the range's lower bound.
            // A watched session is exempt: full trace since creation (the
            // session floor below is the only trim). Historical (non-live)
            // browsing is unaffected — there the range presets are the
            // control, and the dropdown stays out of the way.
            const _liveFrom = (UI.isLive && !playbackTimer && !isLiveWatch()) ? liveWindowMs() : 0;
            let _lo = _liveFrom ? Math.max(_range.start, Date.now() - _liveFrom) : _range.start;
            // A selected session also floors the window at its own start:
            // traces from before the race (an earlier session, yesterday)
            // are not part of it.
            const _sessFrom = selectedSessionFromMs();
            if (_sessFrom) _lo = Math.max(_lo, _sessFrom);
            // A finished/abandoned session is a CLOSED window: nothing
            // after its race window belongs on the map. Without this the
            // boat's later wander (same deviceId re-sails) shows up as a
            // second, unrelated trail on the finished session view.
            const _sessEnd = selectedSessionEndMs();
            let _hi = _range.end;
            if (_sessEnd) _hi = Math.min(_hi, _sessEnd);
            points = points.filter(p => {
                const t = new Date(p.timestamp || p.receivedAt).getTime();
                return !isNaN(t) && t >= _lo && t <= _hi;
            });
        } catch (e) {
            console.error("filtered fetch failed", e);
            points = [];
        }
    } else {
        points = [];
    }

    allPoints = points;

    if (points.length === 0) {
        if (polyline) { map.removeLayer(polyline); polyline = null; }
        polylines.forEach(l => map.removeLayer(l)); polylines = [];
        if (marker) { map.removeLayer(marker); marker = null; }
        fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
        hideHover();
        return;
    }

    // clear previous tracks
    if (polyline) { map.removeLayer(polyline); polyline = null; }
    polylines.forEach(l => map.removeLayer(l)); polylines = [];
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];
    hideHover();

    // multi-select: one polyline per boat, each with its route color.
    // Simulated stretches (mock GPS) render dashed: split each boat's
    // points into same-flag runs, overlapping by one point so there is
    // no visual gap at real/sim transitions.
    const byDevice = new Map();
    points.forEach(p => {
        const id = p.deviceId || "unknown";
        if (!byDevice.has(id)) byDevice.set(id, []);
        byDevice.get(id).push(p);
    });

    // Sessions no longer own the trace set — every boat stays visible
    // even inside an ongoing/finished race. (A toggle will come later.)
    byDevice.forEach((pts, id) => {
        // The live overlay already flies this boat: drawing its stored
        // track too doubles the line (same route, twice).
        if (liveSimShown(id)) return;
        const runs = [];
        let cur = [];
        for (const p of pts) {
            if (cur.length && Boolean(cur[cur.length - 1].simulated) !== Boolean(p.simulated)) {
                runs.push(cur);
                cur = [cur[cur.length - 1]];
            }
            cur.push(p);
        }
        if (cur.length) runs.push(cur);
        const color = colorForDevice(id);
        if (liveMins === -1 && !UI.selectedSessionId) return; // "no track" dropdown: arrows only (plain live only)
        runs.forEach((run, ri) => {
            const latlngs = run.map(p => [p.lat, p.lon]);
            const opts = { color, weight: 2, opacity: 0.6 };
            // last point carries the run's own flag (first may be the
            // overlap point from the previous run)
            if (run[run.length - 1].simulated) opts.dashArray = "7 5";
            const line = L.polyline(latlngs, opts).addTo(map);
            line.on("click", e => { const n = findNearestPoint(e.latlng); if (n) { openBoatPanel(n.deviceId, n); scrubToPoint(n); } L.DomEvent.stop(e); });
            if (selectedDeviceIds.size === 1 && id === [...selectedDeviceIds][0] && ri === 0) {
                polyline = line;
            } else {
                polylines.push(line);
            }
        });
    });
    // keep single polyline reference for fitBounds when single selection
    if (selectedDeviceIds.size === 1 && polyline) {
        // already set
    } else if (selectedDeviceIds.size > 0 && polylines.length === 1 && !polyline) {
        polyline = polylines[0];
        polylines = [];
    }

    const latest = points[points.length - 1];

    if (marker) { map.removeLayer(marker); marker = null; }
    fleetMarkers.forEach(m => map.removeLayer(m)); fleetMarkers = [];

    if (selectedDeviceIds.size > 0) {
        const latestByDevice = new Map();
        points.forEach(p => latestByDevice.set(p.deviceId, p));
        latestByDevice.forEach(p => {
            if (!selectedDeviceIds.has(p.deviceId)) return;
            if (liveSimShown(p.deviceId)) return; // live arrow is drawn: one arrow per boat
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
            // A boat with a live-sim overlay already has its symbol on
            // liveSimLayer, drawn from the CURRENT fix. Drawing the DB one
            // too gave every mock boat two arrows: one here at a stale
            // Turso fix (mock uploads never reach the DB), one live. The
            // live arrow wins and this one stands down.
            if (liveSimShown(p.deviceId)) return;
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

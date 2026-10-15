// live.js — split from app.js. Live-sim overlay, live window, session-scope helpers, hover, colors.
// Load order is index.html script order; cross-file names resolve at call time.
// --- Live sim overlay: ephemeral mock tracks (never in Turso).
// Page load starts with an empty overlay and `since=now`, so a refresh
// begins blank and only fills with points that arrive afterwards.
const liveSimLayer = L.layerGroup().addTo(map);
const liveSim = new Map(); // deviceId -> { pts: [], cursor: ms, line, dot }
const liveSimLoadMs = Date.now();
function liveSimScope() {
    const ids = new Set(selectedDeviceIds);
    // Watching a scheduled/live session: its boats stay live even when
    // unticked, so the session's fleet keeps reporting on the map.
    const s = selSession();
    if (s && !["finished", "abandoned"].includes(s.status) && Array.isArray(s.boats)) {
        s.boats.forEach(b => { if (b && b.deviceId) ids.add(b.deviceId); });
    }
    if (ids.size) return [...ids];
    // No selection: only boats with open panels stay live. Nothing selected
    // and nothing open means quiet — no polling boats the user can't see.
    return [...boatPanels.values()].filter(p => p.open).map(p => p.id);
}
// Tear down the live-sim overlay. Called whenever we LEAVE live mode —
// picking a range preset, a custom range, or entering playback. Leaving
// live is the point where "now" stops meaning anything, and a live trace
// pinned to the present instant next to a historical track is just a
// stale artefact. Layers are removed but the buffer is kept, so
// returning to live redraws immediately instead of refetching.
function hideLiveSimTrace() {
    for (const [, st] of liveSim) {
        if (st.line) { liveSimLayer.removeLayer(st.line); st.line = null; }
        if (st.arrow) { liveSimLayer.removeLayer(st.arrow); st.arrow = null; }
        st.shown = false;
    }
}
// Is this boat's live arrow ACTUALLY ON THE MAP right now?
//
// Deliberately not `liveSim.has(id)`: the buffer deliberately outlives the
// layers, so that returning to live redraws without refetching. Testing the
// buffer made the DB-track pass stand its marker down for a boat whose live
// arrow had already been torn down — with live off, a mock boat then had no
// symbol at all, which is the one boat that most needs one (mock uploads
// never reach Turso, so the DB arrow is a stale fix from whenever the boat
// was last real).
function liveSimShown(id) {
    // A finished/abandoned session's map is historical; the live arrow
    // (which tracks where the boat is *now*) would show it a long way
    // from the race it sailed. Suppress it.
    const sx = selSession();
    if (sx && ["finished","abandoned"].includes(sx.status)) return false;
    const st = liveSim.get(id);
    return !!(st && st.shown);
}
// Which boats a selected session owns, or null when nothing is filtered.
// Shared by the DB-track pass and the live-sim overlay so a session
// selection hides BOTH: a mock boat's arrow is its only position, so
// leaving those up would defeat the point.
// --------------------------------------------------
// Live-trace window
//
// The live overlay used to draw every buffered fix since the page loaded,
// so a long session grew an unreadable ribbon behind the boat. This is the
// topbar dropdown: how much of the live trace to SHOW. 0 = all.
//
// Draw-time filtering, not destructive pruning: the buffer keeps its
// history so switching back to "all" is instant. The 2000-point cap in
// pollLiveSim() is a memory backstop and stays, so the oldest points do
// eventually drop out of "all" as well.
// --------------------------------------------------
let liveMins = 15; // minutes; 0 = all
function liveWindowMs() { return liveMins > 0 ? liveMins * 60000 : 0; }
function liveWindowPts(st) {
    if (liveMins === -1 && !UI.selectedSessionId) return []; // no track (plain live only)
    const sessFrom = selectedSessionFromMs();
    const win = liveWindowMs();
    // Session watch shows the full trace (floor only): the dropdown trims
    // plain live, never a watched session.
    const cutoff = win && !isLiveWatch() ? Date.now() - win : 0;
    const floorMs = sessFrom || 0;
    if (!cutoff && !floorMs) return st.pts;
    if (st.pts.length < 2) return st.pts;
    // Points can arrive slightly out of order (sim feed), so scan from the
    // end and keep the longest recent run rather than trusting order.
    let i = st.pts.length - 1;
    while (i > 0) {
        const t = new Date(st.pts[i].receivedAt || st.pts[i].timestamp || 0).getTime();
        if (!isNaN(t) && (cutoff ? t < cutoff : true) && (floorMs ? t < floorMs : true)) break;
        i--;
    }
    return st.pts.slice(i);
}

function selSession() {
    return UI.selectedSessionId
        ? sessionsCache.find(x => String(x.id) === String(UI.selectedSessionId)) || null
        : null;
}
// Live watch: an open (scheduled/live) session viewed with the live feed.
// Replay (closed session, or no selection) is everything else. Trace rules
// key off this, not off scattered flag combinations.
function isLiveWatch() {
    const s = selSession();
    return !!(UI.isLive && UI.selectedSessionId && s && !["finished", "abandoned"].includes(s.status));
}

function selectedSessionBoatSet() {
    const s = selSession();
    if (!s || !Array.isArray(s.boats)) return null;
    const set = new Set(s.boats.map(b => b && b.deviceId).filter(Boolean));
    return set.size ? set : null;
}

// Earliest point that may be drawn while a session is selected: the race
// itself. Anything older belongs to a previous session or a different day
// and only clutters the picture of the race being looked at.
//
// Uses the session's startTime (the gun) when it has one, and falls back
// to the start of its DAY — a scheduled-but-not-yet-started session has no
// meaningful startTime, and zero would silently hide everything.
function selectedSessionFromMs() {
    if (!UI.selectedSessionId) return 0;
    // A custom range explicitly asked for an exact window — even across the
    // gun/pre-gun boundary — so do not let a selected session floor it.
    if (UI.timePreset === "custom") return 0;
    const s = selSession();
    if (!s) return 0;
    // Live watch: everything since the session was created (quitting and
    // coming back shows the whole recorded picture, not a trimmed slice).
    if (UI.isLive && s.createdAt) {
        const c = new Date(s.createdAt).getTime();
        if (!isNaN(c)) return c;
    }
    // A race that has not yet started (gun in the future) should not
    // floor history at the gun — nothing is recorded yet, which would
    // only blank the map. Fall through to the date/00:00 floor so any
    // live trace keeps resolving the boat pre-race.
    if (s.startTime) {
        const t = new Date(s.startTime).getTime();
        if (!isNaN(t) && t <= Date.now()) return t;
    }
    if (s.date) {
        const d = new Date(s.date + "T00:00");
        if (!isNaN(d.getTime())) return d.getTime();
    }
    return 0;
}
// Upper bound of a finished/abandoned session's trace window. Sessions
// do not record an end time, so approximate: races are minutes long but
// real regattas can run an hour; we cap, so later wander (same deviceId
// re-sailing) does not collect on a finished session's map.
function selectedSessionEndMs() {
    if (!UI.selectedSessionId) return 0;
    const s = selSession();
    if (!s || !["finished", "abandoned"].includes(s.status)) return 0;
    if (!s.startTime) return 0;
    const t = new Date(s.startTime).getTime();
    if (isNaN(t)) return 0;
    return t + 90 * 60000;
}
function drawLiveSim(id) {
    const st = liveSim.get(id);
    if (!st) return;
    if (st.line) { liveSimLayer.removeLayer(st.line); st.line = null; }
    if (st.arrow) { liveSimLayer.removeLayer(st.arrow); st.arrow = null; }
    // Cleared up front so every early return below leaves the boat with NO
    // live arrow rather than a stale `shown`, which would keep suppressing
    // the DB marker for a boat that is not drawn.
    st.shown = false;
    // Exactly one arrow per boat, ever. In replay the cursor arrow is the
    // position that means anything, so the live one stands down (the
    // layers above were just removed, and we do not re-add them).
    if (playbackTimer) return;
    if (st.pts.length < 1) return;
    const only = selectedSessionBoatSet();
    if (only && !only.has(id)) return; // another boat's live trace: hidden
    const color = colorForDevice(id);
    const pts = liveWindowPts(st);
    if (pts.length > 1) {
        st.line = L.polyline(pts.map(p => [p.lat, p.lon]),
            { color, weight: 2, opacity: 0.85, dashArray: "7 5" }).addTo(liveSimLayer);
    }
    // The boat symbol always sits on the NEWEST fix, even when the window
    // has hidden older track — otherwise the arrow would vanish with the
    // trace it no longer draws.
    const last = st.pts[st.pts.length - 1];
    // boat symbol: triangle at the newest sim fix, like the DB-driven arrow
    st.arrow = L.marker([last.lat, last.lon], { icon: boatTriangleIcon(id, last.course) }).addTo(liveSimLayer);
    // Mock boats never reach Turso, so this arrow IS their only position:
    // without a handler, clicking the boat resolves to a stale DB point (or
    // none) and the details panel never opens.
    st.arrow.on("click", () => openBoatPanel(id, { ...last, deviceId: id }));
    st.shown = true;
}
async function pollLiveSim() {
    if (!UI.isLive || document.hidden) return;
    // A selected scheduled/live session IS a live view (its fleet keeps
    // reporting); only a closed (finished/abandoned) session freezes the
    // map into a replay, where a live trace pinned to "now" next to a
    // historical track is just a stale artefact.
    const sel = selSession();
    if (UI.selectedSessionId && (!sel || ["finished", "abandoned"].includes(sel.status))) {
        hideLiveSimTrace();
        return;
    }
    const scope = liveSimScope();
    // teardown: drop overlay layers for boats that left the scope (unticked,
    // pruned, or deleted) — otherwise their line+arrow haunt the map forever.
    for (const [id, st] of liveSim) {
        if (!scope.includes(id)) {
            if (st.line) { liveSimLayer.removeLayer(st.line); st.line = null; }
            if (st.arrow) { liveSimLayer.removeLayer(st.arrow); st.arrow = null; }
            liveSim.delete(id);
        }
    }
    for (const id of scope) {
        let st = liveSim.get(id);
        if (!st) { st = { pts: [], cursor: liveSimLoadMs, line: null, dot: null }; liveSim.set(id, st); }
        try {
            const res = await fetch(`/gps/sim-live?deviceId=${encodeURIComponent(id)}`);
            if (!res.ok) continue;
            const pts = await res.json();
            if (!Array.isArray(pts) || !pts.length) continue;
            for (const p of pts) {
                if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
                st.pts.push(p);
                const t = new Date(p.receivedAt || 0).getTime();
                if (!isNaN(t) && t > st.cursor) st.cursor = t;
            }
            while (st.pts.length > 2000) st.pts.shift();
            drawLiveSim(id);
        } catch {}
    }
}
setInterval(pollLiveSim, 3000);

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
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, z: el.style.zIndex };
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
        // Put the stacking back the way it was. Without this the draft keeps
        // z-index 2000 forever once dragged, and from then on it covers every
        // panel the user opens — the topbar buttons would appear dead.
        el.style.zIndex = drag.z;
        drag = null;
        if (map.dragging) map.dragging.enable();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
}

// Click on or near a route point → show Details, else close
function findNearestPoint(latlng, maxMeters = 15) {
    if (liveMins === -1 && !UI.selectedSessionId) return null; // no track: nothing to hover (plain live only)
    let best = null, bestDist = Infinity;
    // Live-sim (mock) boats live only in the overlay, never in Turso — search
    // their newest fix too, otherwise clicks on a mock boat hit nothing.
    const candidates = allPoints.slice();
    liveSim.forEach((st, id) => {
        const last = st.pts[st.pts.length - 1];
        if (last) candidates.push({ ...last, deviceId: id });
    });
    candidates.forEach(p => {
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
// Hover: a dot on the route + a dot on the timeline for the hovered point
let hoverMarker = null;
const timelineHoverEl = document.getElementById("timeline-hover");
const timelineTipEl = document.getElementById("timeline-tip");
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
            const stripeTop = 4 + Math.max(0, order.indexOf(p.deviceId)) * (32 + 6);
            timelineHoverEl.style.top = (stripeTop + 16) + "px";
            // exact fix tooltip above the stripe: time · knots · bearing
            if (timelineTipEl) {
                const spd = typeof p.speed === "number" && !isNaN(p.speed) ? p.speed.toFixed(1) + " kn" : "- kn";
                const brg = (typeof p.course === "number" && !isNaN(p.course)) ? Math.round(p.course) + "&deg;" : "-";
                timelineTipEl.innerHTML = `${escHtml(fmtDateTime(p.timestamp || p.receivedAt))} · ${escHtml(spd)} · ${brg}`;
                timelineTipEl.style.display = "block";
                timelineTipEl.style.left = ((t - bounds.start) / dayMs * 100) + "%";
                timelineTipEl.style.top = Math.max(28, stripeTop) + "px";
            }
        } else {
            timelineHoverEl.style.display = "none";
            if (timelineTipEl) timelineTipEl.style.display = "none";
        }
    }
}
function hideHover() {
    if (hoverMarker) { map.removeLayer(hoverMarker); hoverMarker = null; }
    if (timelineHoverEl) timelineHoverEl.style.display = "none";
    if (timelineTipEl) timelineTipEl.style.display = "none";
}
map.on("click", e => {
    if (typeof sessSuppressClick !== "undefined" && sessSuppressClick) { sessSuppressClick = false; return; }
    if (typeof builderMapClick === "function" && builderMapClick(e)) return;
    const nearest = findNearestPoint(e.latlng);
    if (nearest) { openBoatPanel(nearest.deviceId, nearest); scrubToPoint(nearest); }
    else closeAllBoatPanels();
});
// Hover anywhere on the map (tight radius — dot shows only when deliberate)
map.on("mousemove", e => {
    if (typeof CB !== "undefined" && CB.open && CB.placing) return; // builder gesture in progress
    const n = findNearestPoint(e.latlng, 15);
    if (n) showHoverPoint(n);
    else hideHover();
});
map.on("mouseout", hideHover);


let marker = null;
let polyline = null;
let polylines = [];
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

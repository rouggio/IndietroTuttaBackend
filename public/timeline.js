// timeline.js — split from app.js. Playback, timeline, scrub, clean panel. Unified refresh() lives here.
// Load order is index.html script order; cross-file names resolve at call time.
// --- Playback (south anchored timeline, time-based, interpolated) ---
const playBtn = document.getElementById("playBtn");
const playSlider = document.getElementById("playSlider");
const playSpeedSel = document.getElementById("playSpeed");
const playLabel = document.getElementById("playLabel");
const playTimeEl = document.getElementById("playTime");
const timelineTracksEl = document.getElementById("timeline-tracks");
const timelineCursorEl = document.getElementById("timeline-cursor");

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
    // The live-sim overlay is a boat symbol too. In replay the cursor
    // arrows are the only positions that mean anything, so tear the live
    // ones down as well — otherwise a mock boat shows its live arrow AND
    // its cursor arrow.
    for (const [, st] of liveSim) {
        if (st.line) { liveSimLayer.removeLayer(st.line); st.line = null; }
        if (st.arrow) { liveSimLayer.removeLayer(st.arrow); st.arrow = null; }
    }
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

// Track click → timeline cursor: move the cursor to the clicked point's
// timestamp. In replay/history the cursor markers move too (showTime); in
// live only the cursor state/slider moves, so the live arrows stay up.
function scrubToPoint(p) {
    if (!p) return;
    const t = new Date(p.timestamp || p.receivedAt).getTime();
    if (isNaN(t)) return;
    const bounds = getDayBounds();
    if (t < bounds.start || t > bounds.end) return;
    if (playbackTimer || !UI.isLive) showTime(t);
    else { playbackTime = t; updatePlaybackSlider(); }
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
    hideLiveSimTrace(); // replay: the cursor arrow is the only symbol (see showTime)
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
// Timeline is replay-only: hide it (button untoggles via its observer) and
// stop any running playback. Called on every live entry.
function hideTimeline() {
    try { stopPlayback(); } catch {}
    try {
        const p = document.getElementById("playback");
        if (p) p.style.display = "none";
    } catch {}
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
    playbackSpeed = parseFloat(e.target.value);
    try { saveUI(); } catch {}
    if (playbackTimer) { stopPlayback(); startPlayback(); }
});
// Timeline: click to scrub, drag to select start/end range
const timelineEl = document.getElementById("timeline");
const timelineSelectionEl = document.getElementById("timeline-selection");
let timelineDrag = null;

// Range captured from a timeline drag, kept ONLY so the Clean panel can
// act on it. The drag itself is consumed as a view filter (it overwrites
// customStart/customEnd and calls refresh()), so these bounds would
// otherwise be lost. Deliberately NOT derived from customStart/customEnd:
// those persist after the view moves on, which would let the panel delete
// a range the user can no longer see selected.
let timelineSelStart = null;
let timelineSelEnd = null;
function getTimelineRatio(clientX){
    const rect = timelineEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}
function hideTimelineSelection(){
    if(timelineSelectionEl){ timelineSelectionEl.style.display="none"; timelineSelectionEl.style.left="0%"; timelineSelectionEl.style.width="0%"; }
    if(timelineEl) timelineEl.classList.remove("dragging");
}

// --------------------------------------------------
// Clean panel: delete the points inside a timeline-selected range.
// --------------------------------------------------
const cleanPanel = document.getElementById("clean-panel");
const cleanBody = document.getElementById("clean-body");
const cleanMsg = document.getElementById("clean-msg");
let cleanPendingCount = null;
let cleanBusy = false;

function captureTimelineSelection(start, end) {
    timelineSelStart = start;
    timelineSelEnd = end;
    cleanPendingCount = null;
    if (cleanMsg) cleanMsg.textContent = "";
    renderCleanPanel();
}

function clearTimelineSelection() {
    timelineSelStart = null;
    timelineSelEnd = null;
    cleanPendingCount = null;
    if (cleanMsg) cleanMsg.textContent = "";
    renderCleanPanel();
}

// Only the boats the user has selected can be deleted — an empty
// selection means "nothing visible", never "every boat".
function cleanTargetIds() {
    return selectedDeviceIds.size ? [...selectedDeviceIds] : [];
}

function renderCleanPanel() {
    if (!cleanBody) return;
    const ids = cleanTargetIds();
    if (!timelineSelStart || !timelineSelEnd) {
        cleanBody.innerHTML = `<div class="device-meta">No range selected. Drag on the timeline under the map.</div>`;
        return;
    }
    if (ids.length === 0) {
        cleanBody.innerHTML = `<div class="device-meta">Range ${fmtDateTime(timelineSelStart)} &rarr; ${fmtDateTime(timelineSelEnd)}<br><b>No boat selected.</b> Pick a boat first — only selected boats are ever deleted.</div>`;
        return;
    }
    const names = ids.map(id => escHtml(boatDisplayName(id))).join(", ");
    // Count what is actually loaded for those boats in the window; the
    // server is asked for the authoritative number before confirming.
    const inRange = allPoints.filter(p => ids.includes(p.deviceId) &&
        (() => { const t = new Date(p.timestamp || p.receivedAt).getTime(); return t >= timelineSelStart && t <= timelineSelEnd; })());
    const count = cleanPendingCount != null ? cleanPendingCount : inRange.length;
    cleanBody.innerHTML = `
        <div class="device-meta">
            <b>${escHtml(names)}</b><br>
            ${fmtDateTime(timelineSelStart)} &rarr; ${fmtDateTime(timelineSelEnd)}<br>
            <b style="font-size:15px">${count}</b> point${count === 1 ? "" : "s"} will be deleted.
        </div>
        <div class="builder-row" style="margin-top:8px">
            <button id="cleanGo" ${cleanBusy ? "disabled" : ""}>Delete points&hellip;</button>
            <button id="cleanClear">Clear range</button>
        </div>
        <div class="device-meta">Permanent — there is no undo. Server must have <code>ENABLE_GPS_EDIT</code> set.</div>
    `;
    document.getElementById("cleanGo")?.addEventListener("click", () => confirmCleanDelete(ids));
    document.getElementById("cleanClear")?.addEventListener("click", clearTimelineSelection);
}

// Ask the server how many rows it would remove, then confirm with the
// real number rather than the client-side guess.
async function confirmCleanDelete(ids) {
    if (cleanBusy) return;
    const params = new URLSearchParams();
    params.set("start", new Date(timelineSelStart).toISOString());
    params.set("end", new Date(timelineSelEnd).toISOString());
    ids.forEach(id => params.append("deviceId", id));
    params.set("preview", "1");
    cleanBusy = true;
    if (cleanMsg) { cleanMsg.textContent = "Checking…"; cleanMsg.style.color = ""; }
    renderCleanPanel();
    try {
        const r = await fetch(`/gps?${params.toString()}`, { method: "DELETE" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `http ${r.status}`);
        cleanPendingCount = data.count || 0;
        if (cleanPendingCount === 0) {
            cleanBusy = false;
            if (cleanMsg) { cleanMsg.textContent = "Nothing to delete in that range."; cleanMsg.style.color = ""; }
            renderCleanPanel();
            return;
        }
        const names = ids.map(id => boatDisplayName(id)).join(", ");
        const ok = window.confirm(
            `Delete ${cleanPendingCount} point${cleanPendingCount === 1 ? "" : "s"} for ${names}?\n\n` +
            `${fmtDateTime(timelineSelStart)} → ${fmtDateTime(timelineSelEnd)}\n\n` +
            `This cannot be undone.`);
        if (!ok) {
            cleanBusy = false;
            if (cleanMsg) { cleanMsg.textContent = "Cancelled."; cleanMsg.style.color = ""; }
            renderCleanPanel();
            return;
        }
        params.delete("preview");
        const del = await fetch(`/gps?${params.toString()}`, { method: "DELETE" });
        const out = await del.json().catch(() => ({}));
        if (!del.ok) throw new Error(out.error || `http ${del.status}`);
        cleanBusy = false;
        clearTimelineSelection();
        if (cleanMsg) { cleanMsg.textContent = `Deleted ${out.deleted} point${out.deleted === 1 ? "" : "s"}.`; cleanMsg.style.color = "#16a34a"; }
        liveCache = new Map();
        await refresh();
        updateTimelineTracks();
    } catch (e) {
        cleanBusy = false;
        if (cleanMsg) { cleanMsg.textContent = String(e.message || e); cleanMsg.style.color = "#dc2626"; }
        renderCleanPanel();
    }
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
        captureTimelineSelection(selStart, selEnd);
        // apply as custom range
        UI.timePreset = "custom";
        if(presetSelect) presetSelect.value = "custom";
        UI.customStart = toLocalDatetimeValue(new Date(selStart));
        UI.customEnd = toLocalDatetimeValue(new Date(selEnd));
        if(startPicker) startPicker.value = UI.customStart;
        if(endPicker) endPicker.value = UI.customEnd;
        setMode(false, "timeline");

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
        captureTimelineSelection(selStart, selEnd);
        UI.timePreset="custom"; if(presetSelect) presetSelect.value="custom";
        UI.customStart = toLocalDatetimeValue(new Date(selStart)); UI.customEnd = toLocalDatetimeValue(new Date(selEnd));
        if(startPicker) startPicker.value=UI.customStart; if(endPicker) endPicker.value=UI.customEnd;
        setMode(false, "timeline"); saveUI(); playbackTime=selStart; hideTimelineSelection();
        refresh().then(()=>{ updateTimelineTracks(); playbackTime=selStart; updatePlaybackSlider(); showTime(selStart); });
    } else {
        hideTimelineSelection();
    }
});
// Single refresh entry: tracks first, then the timeline follows the same
// data (cursor, stripes, slider). Skipped while replaying — the cursor owns
// the map there and a track redraw would fight it.
async function refresh(recenter) {
    if (playbackTimer) return refreshTracks(recenter);
    await refreshTracks(recenter);
    updateTimelineTracks();
    if (playbackTime === null) playbackTime = getDayBounds().start;
    updatePlaybackSlider();
    if (playbackMarkers.size) showTime(playbackTime);
}

// mode.js — split from app.js. Time controls, UI store, Bus, setMode, live/replay transitions.
// Load order is index.html script order; cross-file names resolve at call time.
// --- Controls: Live vs range (rich time selector) ---
const liveBtn = document.getElementById("liveBtn");
const presetSelect = document.getElementById("presetSelect");
const startPicker = document.getElementById("startPicker");
const endPicker = document.getElementById("endPicker");
const applyRangeBtn = document.getElementById("applyRangeBtn");
const rangeSep = document.getElementById("rangeSep");

function todayStr() {
    // Local calendar day, NOT UTC: toISOString is yesterday until 02:00
    // in UTC+2, which misdates sessions created just after midnight.
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
    if(preset==="lastWeek"){
        // The week BEFORE the current one: Monday 00:00:00.000 through the
        // Sunday that ends just before this week starts. Not "the last 7
        // days" — a stable Mon–Sun window, matching thisWeek's Monday start.
        const thisMon = startOfWeek(now);
        const lastMon = new Date(thisMon); lastMon.setDate(lastMon.getDate() - 7);
        const lastSun = new Date(thisMon); lastSun.setDate(lastSun.getDate() - 1); lastSun.setHours(23,59,59,999);
        return { start: lastMon.getTime(), end: lastSun.getTime() };
    }
    if(preset==="custom" && cStart && cEnd){
        const s=new Date(cStart), e=new Date(cEnd);
        if(!isNaN(s.getTime()) && !isNaN(e.getTime())) return { start: s.getTime(), end: e.getTime() };
    }
    return { start: startOfDay(now).getTime(), end: endOfDay(now).getTime() };
}

// Canonical UI state (step 2: the flag lives behind the store).
// Mode WRITES funnel exclusively through setMode()/transitions; every other
// line READS via UI.* — there are no bare mode bindings anymore.
const UI = {
    isLive: true,
    timePreset: "today",
    customStart: "",
    customEnd: "",
    selectedSessionId: null,
};
let showSimPreview = true; // scripted-route preview on the map (persisted)
let selectedDate = todayStr(); // compat
// init defaults then override via loadUI
loadUI();
// Screen load always lands in live: ignore any persisted history view
UI.isLive = true;
UI.timePreset = "today";
// ensure defaults if loadUI missing values
if(!UI.timePreset) UI.timePreset="today";
if(presetSelect) presetSelect.value = UI.timePreset;
// if legacy selectedDate was custom, hydrate custom inputs
if(UI.timePreset==="custom" && selectedDate && !UI.customStart){
    const d=new Date(selectedDate+"T00:00"); if(!isNaN(d.getTime())){ UI.customStart=toLocalDatetimeValue(startOfDay(d)); UI.customEnd=toLocalDatetimeValue(endOfDay(d)); }
}
if(startPicker) startPicker.value = UI.customStart;
if(endPicker) endPicker.value = UI.customEnd;

// Sessions filter toolbar (todo 10): bind once at startup. The filter state
// itself is RAM-only, so there is nothing to restore here — this just
// attaches the handlers.
if (typeof wireSessionFilters === "function") wireSessionFilters();

// Live-trace window dropdown. Restored after loadUI() so the stored pref
// wins, then wired so a change repaints every boat immediately (the poll
// only redraws boats it is already tracking, up to 3s later).
{
    const sel = document.getElementById("liveMinsSelect");
    if (sel) {
        sel.value = String(liveMins);
        sel.addEventListener("change", () => {
            const v = Number(sel.value);
            liveMins = [-1, 0, 2, 5, 15, 60].includes(v) ? v : 15;
            try { saveUI(); } catch {}
            for (const id of [...liveSim.keys()]) drawLiveSim(id);
            // The solid live tracks are windowed in refresh(), so a change
            // has to re-run it — redrawing the mock overlay alone is not
            // enough (that is what made the dropdown look inert at first).
            if (UI.isLive && !playbackTimer && selectedDeviceIds.size > 0) refresh();
        });
    }
}

function updateTimeControlsVisibility(){
    const isCustom = UI.timePreset==="custom" && !UI.isLive;
    if(presetSelect) presetSelect.style.display = UI.isLive ? "none" : "";
    if(startPicker) startPicker.style.display = isCustom ? "" : "none";
    if(rangeSep) rangeSep.style.display = isCustom ? "" : "none";
    if(endPicker) endPicker.style.display = isCustom ? "" : "none";
    if(applyRangeBtn) applyRangeBtn.style.display = isCustom ? "" : "none";
    if(presetSelect) presetSelect.disabled = !!UI.isLive;
    // The live-trace window only applies to plain live (the windowing is
    // scoped to isLive with no session): in a watched session the trace is
    // full since creation, so the control hides there rather than offering
    // a setting that does nothing.
    const lm = document.getElementById("liveMinsSelect");
    if(lm) lm.style.display = (UI.isLive && !UI.selectedSessionId) ? "" : "none";
    // Timeline is replay-only: parked (not just untoggled) while live.
    const tb = document.getElementById("timelineToggleBtn");
    if(tb) {
        tb.disabled = UI.isLive;
        tb.title = UI.isLive ? "Timeline is replay-only" : "Show/hide the timeline";
    }
}
function getCurrentRange(){
    if(UI.isLive){
        const now=new Date(); return { start: startOfDay(now).getTime(), end: endOfDay(now).getTime() };
    }
    return computeRangeForPreset(UI.timePreset, UI.customStart, UI.customEnd);
}

// --- UI event bus + canonical live/replay transitions --------------------------
//
// Live <-> replay used to be flipped inline in ~10 handlers, each hand-rolling
// half a transition (flag here, button class there, controls update missing) —
// that is the bug class behind every stale-trace/topbar issue so far. Now every
// mode change goes through setMode() (single flag flip + topbar chrome +
// "modechange" broadcast) and one of the three transitions below. Components
// that must react coherently subscribe to the bus instead of being poked by
// each caller.
const Bus = {
    _m: new Map(),
    on(evt, fn) {
        if (!this._m.has(evt)) this._m.set(evt, new Set());
        this._m.get(evt).add(fn);
        return () => { try { this._m.get(evt)?.delete(fn); } catch {} };
    },
    emit(evt, data) {
        (this._m.get(evt) || []).forEach(fn => { try { fn(data); } catch (e) { console.error("bus", evt, e); } });
    },
};
function setMode(live, reason) {
    UI.isLive = !!live;
    if (liveBtn) liveBtn.classList.toggle("active", UI.isLive);
    updateTimeControlsVisibility();
    try {
        // Transition journal: one paste (`__modeLog`) shows exactly how the
        // page reached its current mode — no guessing from fragments.
        window.__modeLog = window.__modeLog || [];
        window.__modeLog.push({
            t: new Date().toISOString().slice(11, 19),
            mode: UI.isLive ? "live" : "replay",
            reason: reason || "", sel: UI.selectedSessionId,
        });
        if (window.__modeLog.length > 50) window.__modeLog.shift();
    } catch {}
    Bus.emit("modechange", { mode: UI.isLive ? "live" : "replay", reason: reason || "", selectedSessionId: UI.selectedSessionId });
}
// Leaving live orphans the live-sim layers (polling stops but the drawn line
// + arrow stay): every replay entry tears them down in one place, so callers
// must NOT do it inline anymore.
Bus.on("modechange", ({ mode }) => {
    if (mode !== "live") { try { hideLiveSimTrace(); } catch {} }
});
// Full live: no session, today's window, topbar in live shape.
function enterLiveMode(reason) {
    UI.selectedSessionId = null;
    clearSelPreview();
    clearSimOverlay();
    clearSessDetailTimers();
    const b = document.getElementById("tab-session-detail");
    if (b) b.innerHTML = "";
    const p = document.getElementById("session-detail-panel");
    if (p) p.style.display = "none";
    UI.timePreset = "today";
    if (presetSelect) presetSelect.value = "today";
    const r = computeRangeForPreset("today");
    UI.customStart = toLocalDatetimeValue(new Date(r.start));
    UI.customEnd = toLocalDatetimeValue(new Date(r.end));
    if (startPicker) startPicker.value = UI.customStart;
    if (endPicker) endPicker.value = UI.customEnd;
    hideTimeline(); // replay-only: never open on live entry
    try { renderSessionsList(); } catch {}
    setMode(true, reason);
    try { saveUI(); } catch {}
    try { refresh(); } catch {}
}
// Legacy alias: everything that "clears the session" is entering live.
function unselectSession(reason) { enterLiveMode(reason || "unselect"); }
// Watching a scheduled/live session: live feed scoped to its fleet.
function enterLiveWatch(id, reason) {
    UI.selectedSessionId = id;
    const s = sessionsCache.find(x => String(x.id) === String(id));
    if (s && Array.isArray(s.boats)) s.boats.forEach(x => { if (x && x.deviceId) selectedDeviceIds.add(x.deviceId); });
    UI.timePreset = "today";
    if (presetSelect) presetSelect.value = "today";
    hideTimeline(); // replay-only: never open on live-session watch
    setMode(true, reason);
    try { saveUI(); } catch {}
    renderSessionsList();
    try { refresh(); } catch {}
    if (UI.selectedSessionId) openSessionDetail();
}
// Replaying a closed session (or an explicit replay action): frozen window.
function enterFrozenReplay(id, fromMs, toMs, reason) {
    UI.selectedSessionId = id;
    UI.timePreset = "custom";
    if (presetSelect) presetSelect.value = "custom";
    UI.customStart = toLocalDatetimeValue(new Date(fromMs));
    UI.customEnd = toLocalDatetimeValue(new Date(toMs));
    if (startPicker) startPicker.value = UI.customStart;
    if (endPicker) endPicker.value = UI.customEnd;
    setMode(false, reason);
    try { saveUI(); } catch {}
    renderSessionsList();
    try { refresh(); } catch {}
    if (UI.selectedSessionId) openSessionDetail();
}

updateTimeControlsVisibility();
if (UI.isLive) liveBtn.classList.add("active"); else liveBtn.classList.remove("active");
if (presetSelect) presetSelect.value = UI.timePreset;

liveBtn.addEventListener("click", () => {
    stopPlayback();
    if (UI.isLive) {
        // Live -> history: freeze on today's range (session watch cleared).
        UI.selectedSessionId = null;
        clearSelPreview();
        clearSimOverlay();
        clearSessDetailTimers();
        const b = document.getElementById("tab-session-detail");
        if (b) b.innerHTML = "";
        const dp = document.getElementById("session-detail-panel");
        if (dp) dp.style.display = "none";
        try { renderSessionsList(); } catch {}
        setMode(false, "liveBtn");
        try { saveUI(); } catch {}
        refresh(true);
    } else {
        enterLiveMode("liveBtn");
        refresh(true).then(() => { updateTimelineTracks(); });
    }
});

if(presetSelect) presetSelect.addEventListener("change", () => {
    UI.timePreset = presetSelect.value;
    setMode(false, "preset");
    // if switching to custom and no values, seed with today range
    if(UI.timePreset==="custom" && (!UI.customStart || !UI.customEnd)){
        const r=computeRangeForPreset("today"); UI.customStart=toLocalDatetimeValue(new Date(r.start)); UI.customEnd=toLocalDatetimeValue(new Date(r.end));
        if(startPicker) startPicker.value=UI.customStart; if(endPicker) endPicker.value=UI.customEnd;
    }
    // keep compat selectedDate for custom
    if(UI.timePreset==="custom"){ const r=computeRangeForPreset(UI.timePreset, UI.customStart, UI.customEnd); selectedDate=new Date(r.start).toISOString().slice(0,10); }

    saveUI();
    refresh(true);
});

function applyCustomRange(){
    if(startPicker) UI.customStart=startPicker.value;
    if(endPicker) UI.customEnd=endPicker.value;
    if(UI.timePreset!=="custom"){ UI.timePreset="custom"; if(presetSelect) presetSelect.value="custom"; }
    setMode(false, "custom");

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

// Frontend behaviour checks: core live flow (static + live HTTP).
//
// Usage: node tools/check-frontend.js [filter]
//   filter: optional substring, only tests whose name contains it run.
// Exit code: 0 when every executed test passes, 1 otherwise.
//
// Static tests grep the frontend bundle (public/*.js in index.html script
// order) + public/index.html for the invariants the live/history/session/
// boat/playback interactions depend on.
// HTTP tests hit the local backend (:3000) the same way the page does on load.
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:3000";
const PUB = path.join(__dirname, "..", "public");
const indexHtml = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
// Bundle = local scripts in page order (was a single app.js before the split).
const bundleFiles = [...indexHtml.matchAll(/<script src="(?!https?:)([^"]+\.js)"/g)].map(m => m[1]);
if (!bundleFiles.length) { console.log("FAIL  no frontend bundle scripts in index.html"); process.exit(1); }
const appJs = bundleFiles.map(f => fs.readFileSync(path.join(PUB, f), "utf8")).join("\n");
const css = fs.readFileSync(path.join(PUB, "style.css"), "utf8");

const results = [];
const FILTER = process.argv[2] || "";
function shouldRun(name) { return !FILTER || name.includes(FILTER); }
function check(name, ok, detail) {
    if (!shouldRun(name) && !name.startsWith("http:")) {
        // static test skipped by filter: don't record, don't print
        return;
    }
    results.push({ name, ok: !!ok, detail: detail || "" });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

function hasAll(src, subs) {
    const missing = subs.filter(s => !src.includes(s));
    return { ok: !missing.length, missing };
}

// --- static: boot lands in live -------------------------------------------
{
    const t = hasAll(indexHtml, ['id="liveBtn"', 'class="active"']);
    check("boot-live: liveBtn toggled in index.html", t.ok, t.missing.join(","));
    const i = appJs.indexOf("// Screen load always lands in live");
    const forced = i >= 0 && appJs.slice(i, i + 200).includes("UI.isLive = true")
        && appJs.slice(i, i + 200).includes('UI.timePreset = "today"');
    check("boot-live: mode forces UI.isLive+today after loadUI()", forced);
    const order = bundleFiles;
    check("structure: bundle split in dependency order, app.js gone",
        !indexHtml.includes('src="app.js"') && order.length >= 10
        && order[0] === "core.js" && order[1] === "chrome.js" && order[order.length - 1] === "boot.js"
        && order.indexOf("core.js") < order.indexOf("chrome.js")
        && order.indexOf("chrome.js") < order.indexOf("panes.js")
        && order.indexOf("mode.js") < order.indexOf("race.js")
        && order.indexOf("race.js") < order.indexOf("boot.js"));
}

// --- static: bus + canonical transitions -------------------------------------------
{
    check("bus: event bus with modechange broadcast",
        hasAll(appJs, ["const Bus =", "modechange", "Bus.emit(\"modechange\""]).ok);
    const sub = appJs.slice(appJs.indexOf('Bus.on("modechange"'), appJs.indexOf('Bus.on("modechange"') + 200);
    check("bus: leaving live tears down the live trace via subscription",
        sub.includes('mode !== "live"') && sub.includes("hideLiveSimTrace()")
        && !appJs.includes("hideLiveSimTrace(); // historical range"));
    check("bus: single flag flip + topbar chrome in setMode",
        hasAll(appJs, ["function setMode(live, reason)", "liveBtn.classList.toggle(\"active\"",
            "updateTimeControlsVisibility();", "Bus.emit(\"modechange\""]).ok);
    check("bus: enterLiveMode/enterLiveWatch/enterFrozenReplay exist",
        hasAll(appJs, ["function enterLiveMode(reason)", "function enterLiveWatch(id, reason)",
            "function enterFrozenReplay(id, fromMs, toMs, reason)"]).ok);
    check("structure: single refresh entry (tracks + timeline, no wrapper reassign)",
        appJs.includes("async function refreshTracks(recenter = false)")
        && appJs.includes("async function refresh(recenter)")
        && !appJs.includes("origRefresh"));
    check("store: isLive lives behind UI (no bare binding, setMode sole writer)",
        hasAll(appJs, ["const UI = {", "isLive: true,"]).ok && !appJs.includes("let isLive")
        && !/[^.]isLive\s*=\s*(true|false|!!live)/.test(appJs));
    check("store: range + selection live behind UI (no bare bindings)",
        !/let (timePreset|customStart|customEnd|selectedSessionId)\b/.test(appJs)
        && !/[^.A-Za-z0-9_](timePreset|customStart|customEnd|selectedSessionId)\s*=\s*[^=]/.test(
            appJs.replace(/\/\/.*/g, "").replace(/d\.(timePreset|customStart|customEnd)/g, "")));
}

// --- static: live toggle ----------------------------------------------------
{
    const t = hasAll(appJs, ["liveBtn.addEventListener(\"click\"", "enterLiveMode(\"liveBtn\")", "setMode(false, \"liveBtn\")"]);
    check("live-toggle: liveBtn toggles via transitions", t.ok, t.missing.join(","));
}

// --- static: leaving live ----------------------------------------------------
{
    let t = hasAll(appJs, ['presetSelect.addEventListener("change"', "setMode(false, \"preset\")"]);
    check("leave-live: preset change exits live via setMode", t.ok, t.missing.join(","));
    t = hasAll(appJs, ["function applyCustomRange()", "setMode(false, \"custom\")"]);
    check("leave-live: custom range exits live via setMode", t.ok, t.missing.join(","));
    t = hasAll(appJs, ["boatCalPick = function", "setMode(false, \"calendar\")", 'timePreset = "custom"']);
    check("leave-live: boat calendar day exits live to custom", t.ok, t.missing.join(","));
    const cap = appJs.indexOf("captureTimelineSelection(selStart, selEnd)");
    const dragExits = cap >= 0 && appJs.slice(cap, cap + 800).includes("setMode(false, \"timeline\")");
    check("leave-live: timeline drag exits live via setMode + captures clean range", dragExits);
}

// --- static: session scoping --------------------------------------------------
{
    const t = hasAll(appJs, ["enterFrozenReplay(id, fromMs, toMs, \"row-select\")", "enterLiveWatch(id, \"row-select\")", "enterLiveMode(\"row-toggle\")"]);
    check("session-scope: row select routes via transitions", t.ok, t.missing.join(","));
    const pollGated = appJs.slice(appJs.indexOf("async function pollLiveSim()"), appJs.indexOf("async function pollLiveSim()") + 1000).includes("hideLiveSimTrace()");
    check("session-scope: pollLiveSim suppresses live overlay on closed-session replay", pollGated);
    const floorCap = appJs.includes("selectedSessionFromMs()") && appJs.includes("selectedSessionEndMs()");
    check("session-scope: refresh floors/caps trace at session window", floorCap);
    const histArrow = appJs.slice(appJs.indexOf("function liveSimShown(id)"), appJs.indexOf("function liveSimShown(id)") + 700).includes("finished");
    check("session-scope: finished/abandoned session hides live arrow", histArrow);
    check("session-finished: no scripted mock overlay on finished/abandoned sessions",
        appJs.includes('if (!["finished", "abandoned"].includes(s.status)) renderSimOverlay(false);'));
}

// --- static: scheduled/live sessions watch the live feed ---------------------------
{
    const at = appJs.indexOf("function enterLiveWatch(id, reason)");
    const w = at >= 0 ? appJs.slice(at, at + 900) : "";
    check("session-live: live watch keeps the live feed",
        at >= 0 && w.includes("setMode(true") && w.includes('timePreset = "today"'));
    const poll = appJs.slice(appJs.indexOf("async function pollLiveSim()"), appJs.indexOf("async function pollLiveSim()") + 1000);
    check("session-live: live-sim overlay runs while watching scheduled/live",
        poll.includes('["finished", "abandoned"].includes(sel.status)'));
    const fromMs = appJs.slice(appJs.indexOf("function selectedSessionFromMs()"), appJs.indexOf("function selectedSessionFromMs()") + 900);
    check("session-live: watch floors at creation (quit-and-back shows all)",
        fromMs.includes("s.createdAt") && fromMs.includes("UI.isLive"));
    check("session-live: dropdown bypassed in watch (full trace)",
        appJs.includes("const cutoff = win && !isLiveWatch() ? Date.now() - win : 0;")
        && appJs.includes("const _liveFrom = (UI.isLive && !playbackTimer && !isLiveWatch()) ? liveWindowMs() : 0;")
        && appJs.includes("if (liveMins === -1 && !UI.selectedSessionId) return [];")
        && appJs.includes('if (liveMins === -1 && !UI.selectedSessionId) return; // "no track" dropdown'));
    const scope = appJs.slice(appJs.indexOf("function liveSimScope()"), appJs.indexOf("function liveSimScope()") + 900);
    check("session-live: session boats join the live scope", scope.includes("s.boats.forEach"));
    check("session-live: stored track stands down where the live overlay flies (no doubled line)",
        appJs.includes("if (liveSimShown(id)) return;"));
    // Leaving replay must not leave a cursor boat (or the old stored-fix
    // marker) on the map in live mode.
    check("live-entry: playback cursor boats are torn down on live entry",
        hasAll(appJs, ["function clearPlaybackMarkers()",
            "try { clearPlaybackMarkers(); } catch {}"]).ok);
    check("live-entry: buffered live arrow returns immediately (no ghost marker gap)",
        appJs.includes("for (const id of liveSimScope())")
        && appJs.includes("if (liveSim.has(id)) drawLiveSim(id);"));
    // A watched session that terminates hands over to its own frozen replay,
    // so the timeline is usable without unselect/reselect.
    const ld = appJs.slice(appJs.indexOf("async function loadSessions("), appJs.indexOf("async function loadSessions(") + 2200);
    check("session-live: terminated watch hands over to frozen replay",
        ld.includes('enterFrozenReplay(sel.id, fromMs, toMs, "session-closed")')
        && ld.includes('["finished", "abandoned"].includes(sel.status)'));
    check("session-finished: replay window spans the recorded run (no 60s cap)",
        hasAll(appJs, ["async function closedSessionWindow(s)", "toMs = gun.getTime() + 90 * 60 * 1000;", "toMs = Math.max(toMs"]).ok);
    // Todo 4 close-out: session-scoped replay, no dead replay button.
    const fr = appJs.slice(appJs.indexOf("function enterFrozenReplay("), appJs.indexOf("function enterFrozenReplay(") + 1500);
    check("replay: scoped to the session's boats (timeline, cursors, poll scope)",
        fr.includes("s.boats.forEach") && fr.includes("updateTimelineTracks()"));
    check("replay: no dead Replay-button handler left",
        !appJs.includes("data-sess-r") && !appJs.includes("row-replay"));
    // Todo 10 close-out: the filter marker belongs to the button that opens
    // the filtered pane ("Sessions"), not to "New session".
    check("sessions-filter: active-filter marker on the Sessions button",
        appJs.includes('document.getElementById("sessionsTopBtn")')
        && appJs.includes("btn.classList.toggle(\"filtered\", sessFilterActive())")
        && css.includes("#sessionsTopBtn.filtered::after")
        && !appJs.includes('document.getElementById("sessionsToggleBtn");\n    if (btn) btn.classList.toggle("filtered"'));
    // The binder lives in race.js, which loads AFTER mode.js — wiring it from
    // mode.js was silently skipped by the typeof guard, so the chips filtered
    // nothing while looking live. Only boot.js may call it.
    const bootJs = fs.readFileSync(path.join(PUB, "boot.js"), "utf8");
    check("sessions-filter: wired from boot (race.js loads after mode.js)",
        bootJs.includes("wireSessionFilters();")
        && !appJs.slice(0, appJs.indexOf("fleet.js")).includes("wireSessionFilters();"));
}

// --- static: traces dropdown governs stored + live -----------------------------------
{
    check("traces-dropdown: single window trims overlay + stored tracks in plain live",
        appJs.includes("function liveWindowMs()")
        && appJs.includes("const _liveFrom = (UI.isLive && !playbackTimer && !isLiveWatch()) ? liveWindowMs() : 0;"));
    check("traces-dropdown: session floor applies to overlay + stored",
        appJs.includes("const sessFrom = selectedSessionFromMs();")
        && appJs.includes("const _sessFrom = selectedSessionFromMs();"));
    check("traces-dropdown: control visible in plain live only (hidden in watch)",
        appJs.includes('if(lm) lm.style.display = (UI.isLive && !UI.selectedSessionId) ? "" : "none";'));
}

// --- static: session exit returns to live --------------------------------------
{
    check("session-exit: unselectSession() delegates to enterLiveMode",
        hasAll(appJs, ["function unselectSession(reason)", "enterLiveMode(reason"]).ok);
    check("session-exit: clicking selected session toggles back to live",
        appJs.includes("if (id === UI.selectedSessionId)") && appJs.includes('enterLiveMode("row-toggle")'));
    // live <-> replay are two distinct states: leaving replay must restore
    // the full live topbar (today + start/end hidden), and going live must
    // clear the session list highlight.
    const un = appJs.slice(appJs.indexOf("function enterLiveMode(reason)"), appJs.indexOf("function enterLiveMode(reason)") + 1200);
    check("live-replay: enterLiveMode resets to today + hides start/end + clears list highlight",
        un.includes("selectedSessionId = null") && un.includes('timePreset = "today"')
        && un.includes("setMode(true") && un.includes("renderSessionsList()"));
    const del = appJs.slice(appJs.indexOf('getElementById("sess-del")'), appJs.indexOf('getElementById("sess-del")') + 700);
    check("session-delete: deleting returns to full live (traces obey dropdown)",
        del.includes("unselectSession()") && del.includes("loadSessions()"));
    const oc = appJs.slice(appJs.indexOf("function openSessionCreate()"), appJs.indexOf("function openSessionCreate()") + 1200);
    check("session-create-open: New session opens on the live feed with fleet ticked",
        oc.includes("unselectSession()") && oc.includes("selectedDeviceIds.add(d.deviceId)"));
    check("session-create-open: draft origin resets so the course lands at map center",
        oc.includes("SESSDRAFT.origin = null"));
}

// --- static: creating a session replays the new one ------------------------------
{
    const at = appJs.indexOf("openSessionsPanel(j.id)");
    const w = at >= 0 ? appJs.slice(Math.max(0, at - 200), at + 200) : "";
    check("session-create: creating watches the new session live",
        w.includes("enterLiveWatch(j.id") && appJs.includes("return loadSessions(selectId)"));
}

// --- static: boat select ---------------------------------------------------------
{
    const t = hasAll(appJs, ["data-check", "selectedDeviceIds.add(id)", "selectedDeviceIds.delete(id)", "updateTimelineTracks()", "refresh(true)"]);
    check("boat-select: checkbox drives selection + timeline + refresh", t.ok, t.missing.join(","));
    const clickPanel = appJs.includes("findNearestPoint(e.latlng)") && appJs.includes("openBoatPanel(nearest.deviceId, nearest)");
    check("boat-select: map click opens boat panel", clickPanel);
}

// --- static: playback keeps one arrow per boat --------------------------------------
{
    const t = hasAll(appJs, ["function startPlayback()", "hideLiveSimTrace()", "function showTime(timeMs)", "function stopPlayback()"]);
    check("playback: start hides live trace, showTime/stop exist", t.ok, t.missing.join(","));
    const pauseBtn = appJs.includes('playBtn.textContent = "⏸"') && appJs.includes('playBtn.textContent = "▶"');
    check("playback: play button shows pause while running", pauseBtn);
    check("playback: speed remembered in browser storage",
        appJs.includes("playbackSpeed: playbackSpeed") && appJs.includes("if ([1,2,5,10,20].includes(Number(d.playbackSpeed)))"));
    const oneArrow = appJs.includes("if (liveSimShown(p.deviceId)) return;")
        && appJs.includes("if (playbackTimer) return;");
    check("playback: exactly one arrow per boat (live stands down in replay)", oneArrow);
}

// --- static: timeline scrub ------------------------------------------------------------
{
    const t = hasAll(appJs, ["function updateTimelineTracks()", "function updatePlaybackSlider()", "showTime(selStart)"]);
    check("timeline: tracks + slider + cursor show after range change", t.ok, t.missing.join(","));
    check("timeline: no close button, top-bar toggle only", !indexHtml.includes("playbackClose") && appJs.includes('toggleEl("playback")'));
    check("timeline: replay-only — hidden on live entry, toggle parked while live",
        appJs.includes("function hideTimeline()")
        && hasAll(appJs, ["hideTimeline(); // replay-only: never open on live entry",
            "hideTimeline(); // replay-only: never open on live-session watch",
            "if (UI.isLive) return; // replay-only: parked while live"]).ok);
    const s = hasAll(appJs, ["function scrubToPoint(p)", "scrubToPoint(nearest)", "scrubToPoint(n)"]);
    check("map-click: track click scrubs timeline cursor", s.ok, s.missing.join(","));
    check("boat-panel: opens with live-sim/server fallback when window is empty",
        hasAll(appJs, ["async function resolveBoatPoint(id)", "async function openBoatPanel(id, point)",
            "/gps/latest?deviceId="]).ok);
    check("structure: isLiveWatch names the watch concept",
        hasAll(appJs, ["function isLiveWatch()", "!isLiveWatch()"]).ok);
    check("live-refresh: window focus kicks a refresh (throttled background timers)",
        appJs.includes('window.addEventListener("focus"'));
    check("session-ghost: deleted selection falls back to full live",
        appJs.includes('unselectSession("ghost-drop")'));
    check("session-list: open list reloads on focus/visibility",
        appJs.includes("reloadSessionListIfOpen"));
    const tip = hasAll(appJs, ["timelineTipEl", "fmtDateTime(p.timestamp || p.receivedAt)", 'toFixed(1) + " kn"']);
    check("timeline-hover: tooltip shows exact time, knots and bearing", tip.ok && indexHtml.includes('id="timeline-tip"'), tip.missing.join(",") || "tip div");
}

// --- static: dead code stays dead ------------------------------------------------------
{
    const corpses = ["function fmtTime(", "function segLenM(", "playbackPoints", "getPlaybackSteps",
        "showPlaybackPoint", "playbackIdx", "datePicker", "syncSelected", "function lighten("];
    const found = corpses.filter(c => appJs.includes(c) || indexHtml.includes(c));
    check("deadcode: playback v1 / compat shims / dup helpers stay removed", !found.length, found.join(","));
    check("deadcode: single-select compat gone (Set is the source of truth)",
        !/selectedDeviceId\b/.test(appJs.replace(/selectedDeviceIds/g, "")));
    check("session-detail: no re-open button (abandon is terminal in the UI)",
        !appJs.includes("sess-reopen"));
}

// --- live HTTP: what the page fetches on load ------------------------------------------
async function http(name, url, validate) {
    if (FILTER && !(("http: " + name).includes(FILTER))) return;
    try {
        const r = await fetch(url);
        const body = await r.text();
        const ok = r.ok && (validate ? validate(body, r) : true);
        check(`http: ${name}`, ok, `status ${r.status}`);
    } catch (e) {
        check(`http: ${name}`, false, String(e.message || e));
    }
}

(async () => {
    const filter = process.argv[2];
    const onlyStatic = filter && !filter.startsWith("http");
    // static tests already ran unfiltered; re-filter their display is skipped for brevity
    if (!onlyStatic) {
        await http("health returns ok", `${BASE}/health`, b => b.includes('"status"'));
        await http("boats list", `${BASE}/boats`, b => b.startsWith("["));
        await http("sessions list", `${BASE}/sessions`, b => b.startsWith("["));
        const now = new Date();
        const s = new Date(now); s.setHours(0, 0, 0, 0);
        const e = new Date(now); e.setHours(23, 59, 59, 999);
        try {
            const boats = await (await fetch(`${BASE}/boats`)).json();
            const bid = Array.isArray(boats) && boats.length ? boats[0].deviceId : null;
            if (bid) await http("gps today range", `${BASE}/gps?deviceId=${encodeURIComponent(bid)}&start=${s.toISOString()}&end=${e.toISOString()}`, b => b.startsWith("["));
            else check("http: gps today range", true, "no boats, skipped");
        } catch (err) { check("http: gps today range", false, String(err.message || err)); }
        for (const f of bundleFiles) {
            await http(`serves ${f}`, `${BASE}/${f}`, b => b.length > 1000);
        }
        await http("serves mode.js with live-force", `${BASE}/mode.js`, b => b.includes("Screen load always lands in live"));
        await http("serves index.html with liveBtn", `${BASE}/index.html`, b => b.includes('id="liveBtn"'));
    }
    const fails = results.filter(r => !r.ok && (!filter || r.name.includes(filter)));
    console.log(`\n${results.length - fails.length}/${results.length} passed${filter ? ` (filter "${filter}")` : ""}`);
    process.exit(fails.length ? 1 : 0);
})();

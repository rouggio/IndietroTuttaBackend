// boot.js — startup sequence. Loads last: everything above only defines.
// Boot always lands live, and the timeline is replay-only: a restored-open
// playback panel hides again (button untoggles via its observer).
if (UI.isLive) { try { hideTimeline(); } catch {} }
refresh(true);
refreshDevices();

setInterval(() => {
    // Boat list rides the event stream while subscribed to boat topics
    // (boat.mock/created/deleted, device.status); otherwise it polls — but
    // only while the Boats pane is actually visible. Nothing open, no requests.
    const boatsOpen = panelVisible(document.getElementById("device-panel"));
    if (boatsOpen && !sessSubbed("boat")) refreshDevices();
    if (UI.isLive && !playbackTimer) refresh();
}, 5000);

// Also refresh when tab becomes visible — and when the window regains focus:
// background tabs get their timers throttled by the browser, so the live
// feed can sit stale until something kicks a refresh. An open Sessions pane
// reloads its list too, so deleted sessions drop out instead of stranding
// the map on ghosts.
const reloadSessionListIfOpen = () => {
    if (panelVisible(document.getElementById("session-panel"))) loadSessions();
};
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refresh(); refreshDevices(); reloadSessionListIfOpen(); }
});
window.addEventListener("focus", () => { refresh(); refreshDevices(); reloadSessionListIfOpen(); });

// Initialize timeline after first refresh
setTimeout(async () => {
    await refresh();
    updateTimelineTracks();
    if (playbackTime === null) playbackTime = getDayBounds().start;
    updatePlaybackSlider();
}, 800);

makeFloatingDraggable(document.getElementById("device-panel"));
makeFloatingDraggable(document.getElementById("wind-panel"));
makeFloatingDraggable(document.getElementById("course-panel"));
makeFloatingDraggable(document.getElementById("session-panel"));
makeFloatingDraggable(document.getElementById("session-create-panel"));
makeFloatingDraggable(document.getElementById("session-detail-panel"));
makeFloatingDraggable(document.getElementById("settings-panel"));
makeFloatingDraggable(document.getElementById("clean-panel"));
makeFloatingDraggable(document.getElementById("features-panel"));
makeFloatingDraggable(document.getElementById("builder-panel"));
// Panes restored visible by loadUI() can come back at the same stale
// coordinates. Settle them once layout is real — and again after the async
// content below has populated, since that grows their heights.
settleAllPanelsWhenReady();
// populate panels restored visible (their content loads on toggle otherwise)
if (panelVisible(document.getElementById("course-panel"))) loadCourses();
if (panelVisible(document.getElementById("session-panel"))) loadSessions();
syncEventStream(); // baseline topics from boot; panes resubscribe on toggle
if (panelVisible(document.getElementById("wind-panel"))) refreshWind();
if (panelVisible(document.getElementById("session-create-panel"))) renderSessionCreate();
if (panelVisible(document.getElementById("features-panel"))) {
    loadFeatures().then(renderFeatures).catch(e => {
        const list = document.getElementById("features-list");
        if (list) list.innerHTML = `<div class="device-meta">Could not load features.json (${escHtml(e.message)})</div>`;
    });
}
// The detail pane's selection is not persisted, so a pane restored visible has
// nothing to render (and loadSessions() only runs when the LIST panel is open).
// Hide it rather than leaving an empty "Session details" box.
if (panelVisible(document.getElementById("session-detail-panel"))) {
    document.getElementById("tab-session-detail").innerHTML = "";
    document.getElementById("session-detail-panel").style.display = "none";
    try { saveUI(); } catch {}
}

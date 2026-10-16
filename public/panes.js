// panes.js — split from app.js. Topbar toggles, wind, clean, settings, features panes.
// Load order is index.html script order; cross-file names resolve at call time.
// --- Top menu: toggle panes (all hidden at start) ---
let floatZ = 1001; // bring-to-front counter for floating panels

// Raise a pane above its floating siblings. Shared by the topbar toggles
// and the header drag, because "I just opened it" and "I just grabbed it"
// mean the same thing to the user: this one is now the front pane. The
// counter only ever climbs (reset on reload), so the newest raise wins
// every tie against the older, lower values.
function bringPanelToFront(el) {
    if (!el) return;
    el.style.zIndex = String(++floatZ);
}

function toggleEl(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    if (typeof show === "boolean") el.style.display = show ? "block" : "none";
    else el.style.display = el.style.display === "none" || !el.style.display ? "block" : "none";
    saveUI();
    // Re-check the whole set when a pane becomes visible: it may collide
    // with one that was already open. Deferred a frame so the newly shown
    // pane has a real box to measure (a zero-size box would cascade to a
    // bogus position).
    if (panelVisible(el)) {
        // Opening a pane from the topbar must also raise it: otherwise it
        // opens UNDER whatever pane happens to sit on top, and the button
        // looks like it did nothing.
        bringPanelToFront(el);
        requestAnimationFrame(() => { if (panelVisible(el)) settleAllPanels(); });
    }
}
const boatsBtn = document.getElementById("boatsToggleBtn");
const devicePanel = document.getElementById("device-panel");
if (boatsBtn && devicePanel) {
    const syncBoatsBtn = () => boatsBtn.classList.toggle("active", devicePanel.style.display !== "none" && devicePanel.style.display !== "");
    boatsBtn.addEventListener("click", () => { toggleEl("device-panel"); avoidPanelOverlap(devicePanel); syncBoatsBtn(); saveUI(); if (panelVisible(devicePanel)) refreshDevices(); syncEventStream(); });
    // keep in sync if panel toggled elsewhere
    new MutationObserver(syncBoatsBtn).observe(devicePanel, { attributes:true, attributeFilter:["style"] });
}
document.getElementById("deviceClose")?.addEventListener("click", () => { toggleEl("device-panel", false); syncEventStream(); });
const timelineBtn = document.getElementById("timelineToggleBtn");
const playbackEl = document.getElementById("playback");
if (timelineBtn && playbackEl) {
    const syncTimelineBtn = () => timelineBtn.classList.toggle("active", playbackEl.style.display !== "none" && playbackEl.style.display !== "");
    timelineBtn.addEventListener("click", () => {
        if (UI.isLive) return; // replay-only: parked while live
        toggleEl("playback"); syncTimelineBtn(); updateTimelineTracks();
    });
    new MutationObserver(syncTimelineBtn).observe(playbackEl, { attributes:true, attributeFilter:["style"] });
    syncTimelineBtn();
}
// --- Wind indicator: same provider as the builder (GET /wind), map center ---
const windBtn = document.getElementById("windToggleBtn");
const windPanel = document.getElementById("wind-panel");
function compass16(deg) {
    const names = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
async function refreshWind() {
    const body = document.getElementById("wind-body");
    if (!body || !panelVisible(windPanel)) return;
    const c = map.getCenter();
    const lat = +c.lat.toFixed(4), lon = +c.lng.toFixed(4);
    // Don't blank existing content on refresh — swap silently when the
    // new data arrives so the pane never flickers on toggle/tick.
    const firstLoad = !body.dataset.loaded;
    if (firstLoad) body.innerHTML = '<div class="device-meta">Loading…</div>';
    let w = null;
    try {
        const res = await fetch(`/wind?lat=${lat}&lon=${lon}&provider=${windProvider}`, { signal: AbortSignal.timeout(15000) });
        if (res.ok) w = await res.json();
    } catch {}
    if (!w || typeof w.dir !== "number" || typeof w.speedKn !== "number") {
        if (firstLoad) body.innerHTML = '<div class="boat-info-err">No wind source available.</div>';
        return;
    }
    body.dataset.loaded = "1";
    // dir = where the wind comes FROM; arrow points downwind (dir+180)
    const rot = (((w.dir % 360) + 360) % 360 + 180) % 360;
    const age = w.ageMin != null ? `${w.ageMin} min old` : "live model";
    const dist = w.distKm != null ? ` · ${w.distKm} km away` : "";
    const gust = w.gustKn != null ? ` <span style="color:#64748b">gusts ${w.gustKn}</span>` : "";
    body.innerHTML = `
        <div style="display:flex;gap:12px;align-items:center">
            <svg width="110" height="110" viewBox="0 0 110 110">
                <circle cx="55" cy="55" r="48" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
                <text x="55" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#334155">N</text>
                <text x="55" y="102" text-anchor="middle" font-size="11" fill="#64748b">S</text>
                <text x="98" y="59" text-anchor="middle" font-size="11" fill="#64748b">E</text>
                <text x="12" y="59" text-anchor="middle" font-size="11" fill="#64748b">W</text>
                <g transform="rotate(${rot} 55 55)">
                    <line x1="55" y1="88" x2="55" y2="30" stroke="#2563eb" stroke-width="4" stroke-linecap="round"/>
                    <polygon points="55,20 48,34 62,34" fill="#2563eb"/>
                </g>
                <circle cx="55" cy="55" r="5" fill="#0f172a"/>
            </svg>
            <div>
                <div style="font-size:26px;font-weight:800">${w.dir}&deg; <span style="font-size:14px;font-weight:600;color:#475569">${compass16(w.dir)}</span></div>
                <div style="font-size:15px;font-weight:700">${w.speedKn} kn${gust}</div>
                <div class="device-meta">blowing toward ${compass16(rot)}</div>
            </div>
        </div>
        <div class="device-meta" style="margin-top:6px">${escHtml(w.source || "")} · ${age}${dist}<br>at map center ${lat}, ${lon}</div>`;
}
if (windBtn && windPanel) {
    const syncWindBtn = () => windBtn.classList.toggle("active", panelVisible(windPanel));
    windBtn.addEventListener("click", () => { toggleEl("wind-panel"); avoidPanelOverlap(windPanel); syncWindBtn(); refreshWind(); });
    new MutationObserver(syncWindBtn).observe(windPanel, { attributes:true, attributeFilter:["style"] });
    syncWindBtn();
}
document.getElementById("windClose")?.addEventListener("click", () => toggleEl("wind-panel", false));
// Wind auto-refresh rate lives in Settings (5/10/20/30 min, or off). The
// header ↻ is a one-off refresh only.
let windTimer = null;
function applyWindRefresh() {
    if (windTimer) { clearInterval(windTimer); windTimer = null; }
    if (windRefreshMin > 0) {
        windTimer = setInterval(() => { try { if (panelVisible(windPanel)) refreshWind(); } catch {} }, windRefreshMin * 60000);
    }
    const b = document.getElementById("windRefresh");
    if (b) b.title = windRefreshMin > 0 ? `Refresh now (auto every ${windRefreshMin} min)` : "Refresh now";
}
function setWindRefreshMin(min) {
    windRefreshMin = [5, 10, 20, 30].includes(Number(min)) ? Number(min) : 0;
    applyWindRefresh();
    try { saveUI(); } catch {}
}
function setWindProvider(p) {
    windProvider = ["auto", "wu", "wc", "om"].includes(p) ? p : "auto";
    try { saveUI(); } catch {}
}
document.getElementById("windRefresh")?.addEventListener("click", () => { refreshWind(); });
applyWindRefresh();

// --- Clean (delete points) pane ---------------------------------------
const cleanBtn = document.getElementById("cleanToggleBtn");
if (cleanBtn && cleanPanel) {
    const syncCleanBtn = () => cleanBtn.classList.toggle("active", panelVisible(cleanPanel));
    cleanBtn.addEventListener("click", () => {
        toggleEl("clean-panel");
        avoidPanelOverlap(cleanPanel);
        syncCleanBtn();
        saveUI();
        renderCleanPanel();
    });
    document.getElementById("cleanClose")?.addEventListener("click", () => {
        toggleEl("clean-panel", false);
        syncCleanBtn();
        saveUI();
    });
    // Same shape as every other pane button: keep the topbar state in step
    // with the panel, whoever changed it. The initial call is what fixes a
    // reload — loadUI() restores the panel's display, so without it the
    // pane reappears while its button stays untoggled.
    new MutationObserver(syncCleanBtn).observe(cleanPanel, { attributes: true, attributeFilter: ["style"] });
    syncCleanBtn();
}

// --- Settings pane ---------------------------------------------------
const settingsBtn = document.getElementById("settingsToggleBtn");
const settingsPanel = document.getElementById("settings-panel");
if (settingsBtn && settingsPanel) {
    const syncSettingsBtn = () => settingsBtn.classList.toggle("active", panelVisible(settingsPanel));
    settingsBtn.addEventListener("click", () => { toggleEl("settings-panel"); avoidPanelOverlap(settingsPanel); syncSettingsBtn(); saveUI(); });
    new MutationObserver(syncSettingsBtn).observe(settingsPanel, { attributes: true, attributeFilter: ["style"] });
    syncSettingsBtn();
}
document.getElementById("settingsClose")?.addEventListener("click", () => toggleEl("settings-panel", false));

// TODO pane: the parked roadmap (feats + bugs) with a cost score per item.
// Data lives in public/features.json (mirrors ROADMAP.md § Actionable todos), fetched lazily
// on first open and cached - it changes with the repo, not with the session.
let featuresData = null;
async function loadFeatures() {
    if (featuresData) return featuresData;
    const r = await fetch("/features.json");
    if (!r.ok) throw new Error("features.json " + r.status);
    featuresData = await r.json();
    return featuresData;
}
// Pane order is computed, not numeric: topological by deps, then priority,
// then cost, then n (Kahn's algorithm, ready set kept sorted). Unknown deps
// are ignored; a dependency cycle falls back to plain rank order.
function sortFeatures(feats) {
    const byN = new Map(feats.map(f => [f.n, f]));
    const indeg = new Map();
    const adj = new Map();
    for (const f of feats) {
        const deps = [...new Set(f.deps || [])].filter(d => byN.has(d) && d !== f.n);
        indeg.set(f.n, deps.length);
        for (const d of deps) {
            if (!adj.has(d)) adj.set(d, []);
            adj.get(d).push(f.n);
        }
    }
    const cmpF = (a, b) => (a.priority ?? 5) - (b.priority ?? 5) ||
        (a.cost ?? 5) - (b.cost ?? 5) || a.n - b.n;
    const ready = feats.filter(f => indeg.get(f.n) === 0).sort(cmpF);
    const out = [];
    while (ready.length) {
        const f = ready.shift();
        out.push(f);
        for (const m of (adj.get(f.n) || [])) {
            indeg.set(m, indeg.get(m) - 1);
            if (indeg.get(m) === 0) {
                const mf = byN.get(m);
                let i = ready.findIndex(g => cmpF(mf, g) < 0);
                if (i < 0) i = ready.length;
                ready.splice(i, 0, mf);
            }
        }
    }
    if (out.length < feats.length) {
        for (const f of feats.filter(f => !out.includes(f)).sort(cmpF)) out.push(f);
    }
    return out;
}
function renderFeatures(data) {
    const list = document.getElementById("features-list");
    const legend = document.getElementById("features-legend");
    if (!list || !legend) return;
    legend.textContent = `${data.scale || ""} - ${data.features.length} open, ordered by dependency/priority/cost (P = build priority, 1 first)`;
    const rows = (featSortKey ? manualSortFeatures(data.features) : sortFeatures(data.features)).map(f => {
        const deps = [...new Set(f.deps || [])].filter(d => d !== f.n);
        const depHint = deps.length ? ` (depends on ${deps.join(", ")})` : "";
        const pri = Math.max(1, Number(f.priority) || 5);
        return `
        <div class="feature-row">
            <span class="feature-n">${escHtml(f.n)}</span>
            <span class="feature-title${f.inProgress ? " inprog" : ""}" title="${escHtml("todo " + f.n + depHint + (f.inProgress ? " (in progress)" : ""))}">${escHtml(f.title)}${f.inProgress ? " ✨" : ""}</span>
            <span class="feature-pri p${Math.min(8, pri)}" title="Build priority ${pri} of 8 (1 first)${depHint}">P${pri}</span>
            <span class="feature-cost c${Math.min(5, Math.max(1, Number(f.cost) || 1))}" title="Cost ${escHtml(f.cost)} of 5">${escHtml(f.cost)}</span>
        </div>`;
    }).join("");
    list.innerHTML = rows;
}
// Manual column sort for the TODO pane. Click a header: ascending,
// again: descending, third click: back to computed order (featSortKey null).
// Session-only, not persisted.
let featSortKey = null; // "n" | "title" | "priority" | "cost" | null
let featSortDir = 1;
function manualSortFeatures(feats) {
    const dir = featSortDir;
    const priOf = f => Math.max(1, Number(f.priority) || 5);
    const cmp = {
        n: (a, b) => a.n - b.n,
        title: (a, b) => String(a.title).localeCompare(String(b.title)),
        priority: (a, b) => priOf(a) - priOf(b) || (a.cost ?? 5) - (b.cost ?? 5) || a.n - b.n,
        cost: (a, b) => (a.cost ?? 5) - (b.cost ?? 5) || a.n - b.n,
    }[featSortKey] || ((a, b) => 0);
    return [...feats].sort((a, b) => cmp(a, b) * dir);
}
function syncFeatSortBtns() {
    document.querySelectorAll("#features-sort button[data-sort]").forEach(b => {
        const k = b.getAttribute("data-sort");
        const on = featSortKey === k;
        b.classList.toggle("active", on);
        const base = { n: "#", title: "Title", priority: "P", cost: "Cost" }[k] || k;
        b.textContent = on ? `${base} ${featSortDir > 0 ? "▲" : "▼"}` : base;
    });
}
document.querySelectorAll("#features-sort button[data-sort]").forEach(b => {
    b.addEventListener("click", async () => {
        const k = b.getAttribute("data-sort");
        if (featSortKey !== k) { featSortKey = k; featSortDir = 1; }
        else if (featSortDir > 0) { featSortDir = -1; }
        else { featSortKey = null; featSortDir = 1; }
        syncFeatSortBtns();
        try { renderFeatures(await loadFeatures()); } catch {}
    });
});
const featuresBtn = document.getElementById("featuresToggleBtn");
const featuresPanel = document.getElementById("features-panel");
if (featuresBtn && featuresPanel) {
    const syncFeaturesBtn = () => featuresBtn.classList.toggle("active", panelVisible(featuresPanel));
    featuresBtn.addEventListener("click", async () => {
        toggleEl("features-panel");
        avoidPanelOverlap(featuresPanel);
        syncFeaturesBtn();
        saveUI();
        const list = document.getElementById("features-list");
        if (list && !list.childElementCount) {
            try {
                renderFeatures(await loadFeatures());
            } catch (e) {
                if (list) list.innerHTML = `<div class="device-meta">Could not load features.json (${escHtml(e.message)})</div>`;
            }
        }
    });
    new MutationObserver(syncFeaturesBtn).observe(featuresPanel, { attributes: true, attributeFilter: ["style"] });
    syncFeaturesBtn();
}
document.getElementById("featuresClose")?.addEventListener("click", () => toggleEl("features-panel", false));
function syncSettingsForm() {
    const p = document.getElementById("setWindProvider");
    const r = document.getElementById("setWindRefresh");
    if (p) p.value = windProvider;
    if (r) r.value = String(windRefreshMin);
}
document.getElementById("setWindProvider")?.addEventListener("change", e => {
    setWindProvider(e.target.value);
    refreshWind();
});
document.getElementById("setWindRefresh")?.addEventListener("change", e => setWindRefreshMin(e.target.value));
syncSettingsForm();
document.getElementById("boatFilter")?.addEventListener("input", () => { saveUI(); refreshDevices(); });

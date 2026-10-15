// Runtime smoke for the frontend bundle: loads public/*.js (index.html order)
// under stubbed DOM/Leaflet/fetch and exercises the live/replay transitions.
// Static ft proves wiring; this proves the code RUNS (no ReferenceError on
// load, transitions flip UI state, refresh resolves on empty data).
//
// Usage: node tools/check-frontend-runtime.js   (no server needed; all IO stubbed)
// Exit code: 0 all assertions pass, 1 otherwise.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PUB = path.join(__dirname, "..", "public");
const failures = [];
function t(name, cond, detail) {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
    if (!cond) failures.push(name);
}

// --- stubs ---------------------------------------------------------------
function makeEl(id) {
    const el = {
        id, value: "", innerHTML: "", textContent: "",
        style: {}, dataset: {}, _cls: {},
        classList: {
            toggle(c, f) { el._cls[c] = f === undefined ? !el._cls[c] : !!f; },
            add(c) { el._cls[c] = true; },
            remove(c) { delete el._cls[c]; },
            contains: (c) => !!el._cls[c],
        },
        addEventListener() {}, removeEventListener() {},
        querySelectorAll: () => [], querySelector: () => null,
        appendChild() {}, remove() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        setPointerCapture() {}, closest: () => null,
        options: [], selectedIndex: 0,
        parentElement: { style: {} },
    };
    return el;
}
const els = new Map();
const getEl = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
};
const memStore = new Map();
const containerStub = {
    addEventListener() {}, style: {}, setPointerCapture() {},
};
const mapStub = {
    setView() { return this; }, getCenter: () => ({ lat: 45, lng: 9 }),
    getZoom: () => 13, setZoom() {}, fitBounds() {}, panTo() {},
    removeLayer() {}, on() {}, getBounds: () => ({ contains: () => true }),
    getContainer: () => containerStub,
    dragging: { disable() {}, enable() {} },
    latLngToContainerPoint: () => ({ x: 0, y: 0 }),
    containerPointToLatLng: () => ({ lat: 0, lng: 0 }),
    mouseEventToContainerPoint: () => ({ x: 0, y: 0 }),
    distance: () => 0,
};
const layerStub = () => ({
    addTo() { return this; }, removeLayer() {}, eachLayer() {},
    setLatLngs() {}, setLatLng() {}, getLatLngs: () => [], getLatLng: () => ({ lat: 0, lng: 0 }),
    on() {}, setContent() { return this; },
});
const jsonRes = (body) => ({
    ok: true, status: 200,
    json: async () => JSON.parse(JSON.stringify(body)),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const errRes = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "" });
const stubSession = {
    id: 999, name: "smoke", date: "2026-10-15", mode: "practice", status: "finished",
    courseVersion: 1, marks: [], windDir: 0, windSpeed: 0, scale: 1,
    startLine: null, finishLine: null, boats: [],
    startTime: new Date(Date.now() - 3600000).toISOString(),
};
function stubFetch(url) {
    const u = String(url);
    const freshSim = [{
        lat: 45.0, lon: 9.0, speed: 5.1, course: 180, altitude: 5, sats: 9,
        timestamp: new Date().toISOString(), receivedAt: new Date().toISOString(),
        deviceId: "BOAT1", username: "Smoke", simulated: 1,
    }];
    if (u.includes("/gps/sim-live")) return Promise.resolve(jsonRes(freshSim));
    if (u.includes("/sessions/") && u.includes("/runs")) return Promise.resolve(jsonRes([]));
    if (u.includes("/sessions/") && u.includes("/signals")) return Promise.resolve(jsonRes([]));
    if (/\/sessions\/\d+/.test(u)) return Promise.resolve(jsonRes({
        id: 84, name: "Smoke race", date: "2026-10-15", mode: "practice", status: "scheduled",
        courseVersion: 1, marks: [], windDir: 0, windSpeed: 0, scale: 1,
        startLine: null, finishLine: null, boats: [{ deviceId: "BOAT1", startOffsetSec: 0 }],
        startTime: new Date(Date.now() + 60000).toISOString(),
        createdAt: new Date().toISOString(),
    }));
    if (/\/sessions\/\d+/.test(u)) return Promise.resolve(jsonRes(stubSession));
    if (u.includes("/sessions")) return Promise.resolve(jsonRes([]));
    if (u.includes("/sim/routes")) return Promise.resolve(errRes(404));
    if (u.includes("/sim/")) return Promise.resolve(jsonRes([]));
    if (u.includes("/boats") || u.includes("/devices")) return Promise.resolve(jsonRes([]));
    if (u.includes("/courses")) return Promise.resolve(jsonRes([]));
    if (u.includes("/gps")) return Promise.resolve(jsonRes([]));
    if (u.includes("/wind")) return Promise.resolve(errRes(404));
    if (u.includes("/events")) return Promise.resolve(errRes(404));
    if (u.includes("/features.json")) return Promise.resolve(jsonRes({ scale: "smoke", features: [] }));
    return Promise.resolve(jsonRes([]));
}
class MutationObserverStub { constructor() {} observe() {} disconnect() {} }
const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0,
    localStorage: {
        getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
        setItem: (k, v) => memStore.set(k, String(v)),
        removeItem: (k) => memStore.delete(k),
    },
    fetch: stubFetch,
    URLSearchParams,
    URL,
    document: {
        getElementById: getEl,
        createElement: () => makeEl("dyn"),
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() {},
        body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, style: {} },
    },
    window: { addEventListener() {} },
    MutationObserver: MutationObserverStub,
    AbortSignal: { timeout: () => ({}) },
    L: {
        map: () => mapStub,
        tileLayer: () => ({ addTo() {} }),
        layerGroup: layerStub,
        marker: layerStub, circleMarker: layerStub, circle: layerStub,
        polyline: layerStub, polygon: layerStub, tooltip: layerStub,
        divIcon: (o) => o,
        control: () => ({ onAdd: null, addTo() { return this; }, _div: makeEl("ctl") }),
        DomUtil: { create: () => makeEl("dom") },
        latLng: (a, b) => [a, b],
        latLngBounds: () => ({ pad: () => ({}), contains: () => true }),
    },
};
sandbox.window.document = sandbox.document;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// --- load bundle in page order --------------------------------------------
const indexHtml = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
const files = [...indexHtml.matchAll(/<script src="(?!https?:)([^"]+\.js)"/g)].map((m) => m[1]);
t("bundle loads in page order", files[0] === "core.js" && files[files.length - 1] === "boot.js", files.join(","));
try {
    for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(PUB, f), "utf8"), sandbox, { filename: f });
    }
    t("bundle evaluates without throwing", true);
} catch (e) {
    t("bundle evaluates without throwing", false, String((e && e.stack) || e).split("\n").slice(0, 3).join(" | "));
    console.log(`\n0/${1} passed`);
    process.exit(1);
}
const run = (src) => vm.runInContext(src, sandbox);

// --- assertions ------------------------------------------------------------
try {
    t("boot lands live", run("UI.isLive") === true);
    t("boot window is today", run("UI.timePreset") === "today");
    t("live button toggled", getEl("liveBtn")._cls["active"] === true);
} catch (e) { t("boot state readable", false, String(e).slice(0, 120)); }

try {
    run("enterFrozenReplay(999, Date.now()-60000, Date.now()+60000, 'smoke')");
    t("replay exits live", run("UI.isLive") === false);
    t("replay window is custom", run("UI.timePreset") === "custom");
    t("replay selects session", run("UI.selectedSessionId") === 999);
    run("enterLiveMode('smoke')");
    t("back to live", run("UI.isLive") === true);
    t("selection cleared", run("UI.selectedSessionId") === null);
    t("window back to today", run("UI.timePreset") === "today");
    t("timeline hidden on live entry", getEl("playback").style.display === "none");
} catch (e) { t("transitions run", false, String(e).slice(0, 160)); }

try {
    run("enterLiveWatch(7, 'smoke')");
    t("live watch keeps live", run("UI.isLive") === true && run("UI.selectedSessionId") === 7);
    run("enterLiveMode('smoke')");
} catch (e) { t("live watch runs", false, String(e).slice(0, 160)); }

(async () => {
    try {
        // Scheduled session created an hour ago, gun still ahead, boat engaged.
        run(`sessionsCache = [{ id: 84, name: "Smoke race", date: "${new Date().toISOString().slice(0, 10)}",
            mode: "practice", status: "scheduled", courseVersion: 1, marks: [], windDir: 0, windSpeed: 0,
            scale: 1, startLine: null, finishLine: null, boats: [{ deviceId: "BOAT1", startOffsetSec: 0 }],
            startTime: new Date(Date.now() + 60000).toISOString(),
            createdAt: new Date(Date.now() - 3600000).toISOString() }]`);
        run(`enterLiveWatch(84, 'smoke')`);
        await run(`pollLiveSim()`);
        t("live watch draws the live arrow", run(`!!(liveSim.get("BOAT1") && liveSim.get("BOAT1").shown && liveSim.get("BOAT1").arrow)`));
        // A 30-min-old in-session fix: trimmed in plain live, kept in watch.
        run(`liveSim.get("BOAT1").pts.unshift({ lat: 45, lon: 9, speed: 4, course: 90,
            receivedAt: new Date(Date.now() - 1800000).toISOString(),
            timestamp: new Date(Date.now() - 1800000).toISOString() })`);
        t("watch keeps full trace since creation (dropdown bypassed)",
            run(`liveWindowPts(liveSim.get("BOAT1")).length >= 2`));
        run("enterLiveMode('smoke')");
    } catch (e) { t("live watch draws the live arrow", false, String(e).slice(0, 200)); }
    try {
        await run("refresh(true)");
        t("refresh resolves on empty data", true);
    } catch (e) { t("refresh resolves on empty data", false, String(e).slice(0, 160)); }
    try {
        const raw = memStore.get("indietrotutta:ui");
        const saved = raw ? JSON.parse(raw) : null;
        t("prefs blob persisted", !!(saved && saved.timePreset === "today" && saved.isLive === true));
    } catch (e) { t("prefs blob persisted", false, String(e).slice(0, 120)); }
    console.log(`\n${14 - failures.length}/14 passed`);
    process.exit(failures.length ? 1 : 0);
})();

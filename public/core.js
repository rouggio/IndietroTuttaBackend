// core.js — split from app.js. Map, tiles, saved viewport, sim wander anchor. Loads first: defines `map`.
// Load order is index.html script order; cross-file names resolve at call time.
const map = L.map('map', { zoomControl: false, maxZoom: 22 }).setView([39.92, 9.65], 13);

// --- Base map: streets or satellite (user, 2026-11-08) ----------------------
// Two tile layers, swapped by the Settings pane ("Base map"), persisted in the UI
// prefs. The satellite layer is Esri World Imagery: public, no API key, and the
// usual Leaflet-providers entry. Both stay in Leaflet's tilePane, i.e. UNDER the
// tracks and every other overlay, so swapping them never re-orders the chart.
const BASE_TILES = {
    osm: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        opts: {
            attribution: '&copy; OpenStreetMap contributors',
            referrerPolicy: 'strict-origin-when-cross-origin',
            maxNativeZoom: 19, // OSM serves to z19; beyond that tiles scale up
            maxZoom: 22,
        },
    },
    sat: {
        // Esri asks for the source credit to stay visible; the imagery is
        // generally best around z17-19, so it scales up past that like OSM.
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        opts: {
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
            maxNativeZoom: 19,
            maxZoom: 22,
        },
    },
};
let baseMapLayer = null;
function setBaseMap(kind) {
    const want = BASE_TILES[kind] ? kind : 'osm';
    if (baseMapLayer) { map.removeLayer(baseMapLayer); baseMapLayer = null; }
    const spec = BASE_TILES[want];
    baseMapLayer = L.tileLayer(spec.url, spec.opts).addTo(map);
    return want;
}
setBaseMap('osm');

// Remember last map position across reloads
let restoredMapView = false;
try {
    const saved = JSON.parse(localStorage.getItem("indietrotutta:map") || "null");
    if (saved && isFinite(saved.lat) && isFinite(saved.lon)) {
        map.setView([saved.lat, saved.lon], isFinite(saved.zoom) ? saved.zoom : map.getZoom());
        restoredMapView = true;
    }
} catch {}
map.on("moveend", () => {
    try {
        const c = map.getCenter();
        localStorage.setItem("indietrotutta:map", JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() }));
    } catch {}
    pushWanderAnchorDebounced();
});
// Sim wander anchor = the map viewport (sessions ignored): tell the
// backend where the user is looking — on load, on pan (debounced) and
// every minute as keep-alive. A page refresh re-anchors the walk at
// the restored center.
let wanderAnchorTimer = null;
function pushWanderAnchor() {
    try {
        const c = map.getCenter();
        fetch("/sim/anchor", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6) }),
        }).catch(() => {});
    } catch {}
}
function pushWanderAnchorDebounced() {
    if (wanderAnchorTimer) clearTimeout(wanderAnchorTimer);
    wanderAnchorTimer = setTimeout(pushWanderAnchor, 2000);
}
pushWanderAnchor();
setInterval(pushWanderAnchor, 60 * 1000);

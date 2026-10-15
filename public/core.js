// core.js — split from app.js. Map, tiles, saved viewport, sim wander anchor. Loads first: defines `map`.
// Load order is index.html script order; cross-file names resolve at call time.
const map = L.map('map', { zoomControl: false, maxZoom: 22 }).setView([39.92, 9.65], 13);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '&copy; OpenStreetMap',
        referrerPolicy: 'strict-origin-when-cross-origin',
        maxNativeZoom: 19, // OSM serves to z19; beyond that tiles scale up
        maxZoom: 22
    }
).addTo(map);

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

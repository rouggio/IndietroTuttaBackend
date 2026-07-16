const map = L.map('map').setView([39.92, 9.65], 13);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '&copy; OpenStreetMap',
        referrerPolicy: 'strict-origin-when-cross-origin'
    }
).addTo(map);

let marker = null;
let polyline = null;

async function refresh() {

    const response = await fetch("/gps");
    const points = await response.json();

    if (points.length === 0)
        return;

    const latlngs = points.map(p => [p.lat, p.lon]);

    if (polyline)
        map.removeLayer(polyline);

    polyline = L.polyline(latlngs, {
        color: "blue",
        weight: 4
    }).addTo(map);

    const last = latlngs[latlngs.length - 1];

    if (marker)
        marker.remove();

    marker = L.marker(last)
        .addTo(map)
        .bindPopup("Latest position");

    // map.fitBounds(polyline.getBounds(), {
    //     padding: [40,40]
    // });
}

refresh();

setInterval(refresh, 5000);
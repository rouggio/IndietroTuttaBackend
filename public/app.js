const map = L.map('map').setView([39.92, 9.65], 13);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '&copy; OpenStreetMap',
        referrerPolicy: 'strict-origin-when-cross-origin'
    }
).addTo(map);

const info = L.control({ position: "topright" });

info.onAdd = function () {
    this._div = L.DomUtil.create("div", "gps-info");
    this.update();
    return this._div;
};

info.update = function (p) {
    if (!p) {
        this._div.innerHTML = "<b>Latest GPS</b><br>No data";
        return;
    }

    this._div.innerHTML = `
        <h4>Latest GPS</h4>
        <table>
            <tr><td>Time</td><td>${p.deviceId}</td></tr>
            <tr><td>Lat</td><td>${p.lat.toFixed(6)}</td></tr>
            <tr><td>Lon</td><td>${p.lon.toFixed(6)}</td></tr>
            <tr><td>Speed</td><td>${p.speed ?? "-"} knots</td></tr>
            <tr><td>Course</td><td>${p.course ?? "-"}°</td></tr>
            <tr><td>Altitude</td><td>${p.altitude ?? "-"} m</td></tr>
            <tr><td>Sats</td><td>${p.sats ?? "-"}</td></tr>
            <tr><td>Time</td><td>${p.timestamp}</td></tr>
        </table>
    `;
};

info.addTo(map);


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

    const latest = points[points.length - 1];
    info.update(latest);

}

refresh();

setInterval(refresh, 5000);
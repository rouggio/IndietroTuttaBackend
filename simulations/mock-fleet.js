const fetch = require('node-fetch');
const base = 'http://localhost:3000';

const fleet = [
  { deviceId: 'AA:BB:CC:DD:EE:01', username: 'Azzurra', offsetLat: 0.00015, offsetLon: 0.00015 },
  { deviceId: 'AA:BB:CC:DD:EE:02', username: 'Moro', offsetLat: -0.00015, offsetLon: 0.00010 },
  { deviceId: 'AA:BB:CC:DD:EE:03', username: 'Luna Rossa', offsetLat: 0.00010, offsetLon: -0.00012 },
];

const windward = { lat: 39.918590931732766, lon: 9.697194099426271 };
const gatePort = { lat: 39.916780244339165, lon: 9.694404602050783 };
const start = { lat: 39.9155, lon: 9.6955 };

function lerp(a,b,t){ return a + (b-a)*t; }

async function post(deviceId, username, lat, lon) {
  const body = { lat, lon, speed: 5.5 + Math.random()*1.5, course: 180, altitude: 5, sats: 8, username, timestamp: new Date().toISOString() };
  const res = await fetch(`${base}/gps`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'DeviceId': deviceId }, body: JSON.stringify(body) });
  const j = await res.json();
  return j;
}

(async () => {
  // also ensure health for each device so they appear as live
  for (const b of fleet) {
    await fetch(`${base}/health`, { headers: { 'DeviceId': b.deviceId, 'Username': b.username } });
    console.log(`health ${b.username}`);
  }

  for (const boat of fleet) {
    console.log(`--- ${boat.username} ---`);
    const legs = [
      { from: {lat: start.lat+boat.offsetLat, lon: start.lon+boat.offsetLon}, to: {lat: windward.lat+boat.offsetLat, lon: windward.lon+boat.offsetLon} },
      { from: {lat: windward.lat+boat.offsetLat, lon: windward.lon+boat.offsetLon}, to: {lat: gatePort.lat+boat.offsetLat, lon: gatePort.lon+boat.offsetLon} },
      { from: {lat: gatePort.lat+boat.offsetLat, lon: gatePort.lon+boat.offsetLon}, to: {lat: windward.lat+boat.offsetLat, lon: windward.lon+boat.offsetLon} },
      { from: {lat: windward.lat+boat.offsetLat, lon: windward.lon+boat.offsetLon}, to: {lat: start.lat+boat.offsetLat, lon: start.lon+boat.offsetLon} },
    ];
    for (const leg of legs) {
      for (let i=0;i<6;i++) {
        const t = i/5;
        const lat = lerp(leg.from.lat, leg.to.lat, t);
        const lon = lerp(leg.from.lon, leg.to.lon, t);
        await post(boat.deviceId, boat.username, lat, lon);
        await new Promise(r=>setTimeout(r, 80));
      }
    }
  }
  console.log('fleet done');
  const d = await fetch(`${base}/devices`).then(r=>r.json());
  console.log(`devices ${d.length}:`, d.map(x=>`${x.username} ${x.status}`).join(', '));
})();

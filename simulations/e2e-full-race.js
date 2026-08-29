const fetch = require('node-fetch');
const base = 'https://indietrotutta.onrender.com';

const fleet = [
  { deviceId: '08:D1:F9:C8:4D:24', username: 'Ciccio', offLat: 0, offLon: 0 },
  { deviceId: 'AA:BB:CC:DD:EE:01', username: 'Azzurra', offLat: 0.00012, offLon: 0.00010 },
  { deviceId: 'AA:BB:CC:DD:EE:02', username: 'Moro', offLat: -0.00012, offLon: 0.00008 },
  { deviceId: 'AA:BB:CC:DD:EE:03', username: 'Luna Rossa', offLat: 0.00008, offLon: -0.00012 },
];

const windward = { lat: 39.918590931732766, lon: 9.697194099426271 };
const gatePort = { lat: 39.916780244339165, lon: 9.694404602050783 };
const start = { lat: 39.9155, lon: 9.6955 };

function lerp(a,b,t){ return a + (b-a)*t; }

async function post(deviceId, username, lat, lon, flagged) {
  const body = { lat, lon, speed: 6.2, course: 0, altitude: 5, sats: 9, flagged, username, timestamp: new Date().toISOString() };
  const res = await fetch(`${base}/gps`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'DeviceId': deviceId }, body: JSON.stringify(body) });
  const j = await res.json();
  return j;
}

async function health(deviceId, username) {
  await fetch(`${base}/health`, { headers: { 'DeviceId': deviceId, 'Username': username } });
}

(async () => {
  console.log('--- E2E: all boats on starting line ---');
  for (const b of fleet) {
    await health(b.deviceId, b.username);
    const lat = start.lat + b.offLat;
    const lon = start.lon + b.offLon;
    await post(b.deviceId, b.username, lat, lon, false);
    console.log(`start line ${b.username} ${lat.toFixed(6)},${lon.toFixed(6)}`);
    await new Promise(r=>setTimeout(r,150));
  }
  console.log('All on line. Waiting 10s for start countdown...');
  await new Promise(r=>setTimeout(r, 10000));

  console.log('--- RACING: start → windward → gate → windward → finish ---');
  const legs = [
    { from: start, to: windward, name: 'leg1-start-to-windward' },
    { from: windward, to: gatePort, name: 'leg2-windward-to-gate' },
    { from: gatePort, to: windward, name: 'leg3-gate-to-windward' },
    { from: windward, to: start, name: 'leg4-windward-to-finish' },
  ];

  for (const leg of legs) {
    console.log(`--- ${leg.name} ---`);
    for (let step=0; step<6; step++) {
      const t = step/5;
      for (const b of fleet) {
        // add slight speed variance per boat
        const jitter = (Math.random()-0.5)*0.00005;
        const lat = lerp(leg.from.lat, leg.to.lat, t) + b.offLat*0.3 + jitter;
        const lon = lerp(leg.from.lon, leg.to.lon, t) + b.offLon*0.3 + jitter;
        const flagged = step===5; // flag rounding
        await post(b.deviceId, b.username, lat, lon, flagged);
      }
      await new Promise(r=>setTimeout(r, 600));
    }
  }

  const g = await fetch(`${base}/gps`).then(r=>r.json());
  const d = await fetch(`${base}/devices`).then(r=>r.json());
  console.log(`done: gps ${g.length} flagged ${g.filter(x=>x.flagged).length} devices ${d.length}`);
  console.log(d.map(x=>`${x.username} ${x.status}`).join(', '));
  console.log('Check https://indietrotutta.onrender.com/ and /gps?date='+new Date().toISOString().slice(0,10));
})();

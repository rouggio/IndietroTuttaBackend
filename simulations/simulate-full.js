const fetch = require('node-fetch');
const base = 'http://localhost:3000';
const deviceId = '08:D1:F9:C8:4D:24';
const username = 'Ciccio';

function lerp(a,b,t){ return a + (b-a)*t; }

const windward = { lat: 39.918590931732766, lon: 9.697194099426271 };
const gatePort = { lat: 39.916780244339165, lon: 9.694404602050783 };
const start = { lat: 39.9155, lon: 9.6955 }; // south of gate as start/finish

const legs = [
  { from: start, to: windward, name: 'leg1-start-to-windward' },
  { from: windward, to: gatePort, name: 'leg2-windward-to-gate' },
  { from: gatePort, to: windward, name: 'leg3-gate-to-windward' },
  { from: windward, to: start, name: 'leg4-windward-to-finish' },
];

async function post(lat, lon) {
  const body = { lat, lon, speed: 6.5, course: 0, altitude: 5, sats: 9, username, timestamp: new Date().toISOString() };
  const res = await fetch(`${base}/gps`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'DeviceId': deviceId }, body: JSON.stringify(body) });
  const j = await res.json();
  console.log(`posted ${lat.toFixed(6)},${lon.toFixed(6)} -> ${j.stored}`);
}

(async () => {
  for (const leg of legs) {
    console.log(`--- ${leg.name} ---`);
    const steps = 6;
    for (let i=0;i<steps;i++) {
      const t = i/(steps-1);
      const lat = lerp(leg.from.lat, leg.to.lat, t);
      const lon = lerp(leg.from.lon, leg.to.lon, t);
      await post(lat, lon);
      await new Promise(r=>setTimeout(r, 250));
    }
  }
  console.log('full race done - 24 points');
})();

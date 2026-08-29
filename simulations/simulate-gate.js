const fetch = require('node-fetch');

const base = 'http://localhost:3000';
const deviceId = '08:D1:F9:C8:4D:24';
const username = 'Ciccio';

const points = [
  { lat: 39.918590931732766, lon: 9.697194099426271, desc: 'windward' },
  { lat: 39.9178, lon: 9.6969, desc: 'approach' },
  { lat: 39.9168, lon: 9.6959, desc: 'gate north' },
  { lat: 39.9163374457303, lon: 9.695691562377932, desc: 'gate center - BETWEEN' },
  { lat: 39.9160, lon: 9.6956, desc: 'gate south - passed' },
  { lat: 39.9155, lon: 9.6955, desc: 'leeward' },
];

async function post(p, flagged=false) {
  const body = {
    lat: p.lat,
    lon: p.lon,
    speed: 5.2,
    course: 180,
    altitude: 10,
    sats: 8,
    flagged,
    username,
    timestamp: new Date().toISOString()
  };
  const res = await fetch(`${base}/gps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'DeviceId': deviceId },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  console.log(`posted ${p.desc} ${p.lat.toFixed(6)},${p.lon.toFixed(6)} flagged=${flagged} -> stored ${j.stored}`);
}

(async () => {
  for (let i=0; i<points.length; i++) {
    const p = points[i];
    await post(p, i===3); // flag gate center as example
    await new Promise(r=>setTimeout(r, 400));
  }
  console.log('done - check http://localhost:3000/gps and map');
})();

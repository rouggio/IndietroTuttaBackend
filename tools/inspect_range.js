// READ-ONLY inspection of a gps_points time window. No writes, no deletes.
const { getClient } = require('../store/db.js');

const c = getClient();

function stats(rows) {
  const out = { n: rows.length };
  if (!rows.length) return out;
  const spd = rows.map(r => r.speed).filter(v => typeof v === 'number');
  const lats = rows.map(r => r.lat).filter(v => typeof v === 'number');
  const lons = rows.map(r => r.lon).filter(v => typeof v === 'number');
  const alts = rows.map(r => r.altitude).filter(v => typeof v === 'number');
  const sats = rows.map(r => r.sats).filter(v => typeof v === 'number');
  const mins = f => Math.min(...f), maxs = f => Math.max(...f);
  const avg = f => (f.length ? +(f.reduce((a, b) => a + b, 0) / f.length).toFixed(3) : null);
  out.speed = { min: mins(spd), max: maxs(spd), avg: avg(spd) };
  out.lat = { min: mins(lats), max: maxs(lats) };
  out.lon = { min: mins(lons), max: maxs(lons) };
  out.alt = alts.length ? { min: mins(alts), max: maxs(alts), avg: avg(alts) } : null;
  out.sats = sats.length ? { min: mins(sats), max: maxs(sats), avg: avg(sats) } : null;
  out.simulated = rows.reduce((m, r) => { m[r.simulated] = (m[r.simulated] || 0) + 1; return m; }, {});
  out.devices = [...new Set(rows.map(r => r.deviceId))];
  out.usernames = [...new Set(rows.map(r => r.username).filter(Boolean))];
  // time span between consecutive points
  const t = rows.map(r => new Date(r.timestamp || r.receivedAt).getTime()).sort((a, b) => a - b);
  const gaps = t.slice(1).map((v, i) => (v - t[i]) / 1000);
  out.span_min = ((t[t.length - 1] - t[0]) / 60000).toFixed(1);
  out.gap_s = gaps.length ? { median: +gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)].toFixed(1), max: +Math.max(...gaps).toFixed(1) } : null;
  out.first = rows[0].timestamp || rows[0].receivedAt;
  out.last = rows[rows.length - 1].timestamp || rows[rows.length - 1].receivedAt;
  return out;
}

(async () => {
  // Wide net: 15:00 UTC -> 05:00 UTC next day covers a 17:00->02:38 LOCAL (CEST=UTC+2) reading.
  const res = await c.execute({
    sql: `SELECT id, deviceId, username, lat, lon, speed, course, altitude, sats, simulated, timestamp, receivedAt
          FROM gps_points
          WHERE timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp ASC`,
    args: ['2026-10-10T15:00:00.000Z', '2026-10-11T05:00:00.000Z'],
  });
  const rows = res.rows || [];
  console.log('=== WIDE WINDOW 2026-10-10T15:00Z .. 2026-10-11T05:00Z ===');
  console.log(JSON.stringify(stats(rows), null, 2));

  console.log('\n=== PER-HOUR ===');
  const byHour = {};
  for (const r of rows) {
    const h = (r.timestamp || r.receivedAt || '').slice(0, 13);
    (byHour[h] = byHour[h] || []).push(r);
  }
  for (const h of Object.keys(byHour).sort()) {
    const g = byHour[h];
    console.log(`${h}Z  n=${String(g.length).padStart(4)}  spd ${Math.min(...g.map(x => x.speed ?? 0)).toFixed(1)}..${Math.max(...g.map(x => x.speed ?? 0)).toFixed(1)}  sats ${Math.min(...g.map(x => x.sats ?? -1))}..${Math.max(...g.map(x => x.sats ?? -1))}  sim=${g.filter(x => x.simulated).length}  lat ${Math.min(...g.map(x => x.lat ?? 0)).toFixed(4)}..${Math.max(...g.map(x => x.lat ?? 0)).toFixed(4)}`);
  }

  console.log('\n=== NEIGHBOUR BOUNDARIES (context, ~20 either side) ===');
  const edge = await c.execute({
    sql: `SELECT id, timestamp, lat, lon, speed, sats, simulated FROM gps_points
          WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
    args: ['2026-10-10T16:40:00.000Z', '2026-10-10T17:20:00.000Z'],
  });
  for (const r of edge.rows || []) console.log(`${r.id}\t${r.timestamp}\t${r.lat},${r.lon}\tspd=${r.speed}\tsats=${r.sats}\tsim=${r.simulated}`);

  console.log('\n--- tail edge ---');
  const tail = await c.execute({
    sql: `SELECT id, timestamp, lat, lon, speed, sats, simulated FROM gps_points
          WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
    args: ['2026-10-11T00:20:00.000Z', '2026-10-11T01:00:00.000Z'],
  });
  for (const r of tail.rows || []) console.log(`${r.id}\t${r.timestamp}\t${r.lat},${r.lon}\tspd=${r.speed}\tsats=${r.sats}\tsim=${r.simulated}`);

  console.log('\n=== DAY COUNTS around the window ===');
  const days = await c.execute({
    sql: `SELECT substr(timestamp,1,10) AS day, COUNT(*) AS n, MIN(timestamp) AS first, MAX(timestamp) AS last
          FROM gps_points WHERE timestamp >= '2026-10-08T00:00:00.000Z' AND timestamp < '2026-10-13T00:00:00.000Z'
          GROUP BY day ORDER BY day ASC`,
  });
  for (const r of days.rows || []) console.log(`${r.day}  n=${String(r.n).padStart(5)}  ${r.first} .. ${r.last}`);
})().catch(e => { console.error('ERR', e); process.exit(1); });

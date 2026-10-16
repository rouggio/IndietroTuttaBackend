// READ-ONLY: dump the candidate rows in full for judgement.
const { getClient } = require('../store/db.js');
const c = getClient();

(async () => {
  const res = await c.execute({
    sql: `SELECT id, lat, lon, speed, course, altitude, sats, simulated, timestamp, receivedAt
          FROM gps_points
          WHERE timestamp >= '2026-10-10T15:00:00.000Z' AND timestamp <= '2026-10-11T05:00:00.000Z'
          ORDER BY timestamp ASC`,
  });
  console.log('id\tts_local(CEST)\tspd\tcrs\tsats\tsim\tlat\t\t\tlon\t\t\talt\trecvd-lag_s');
  let prev = null;
  for (const r of res.rows || []) {
    const t = new Date(r.timestamp);
    const loc = new Date(t.getTime() + 2 * 3600e3).toISOString().slice(11, 19);
    const lag = ((new Date(r.receivedAt) - t) / 1000).toFixed(0);
    const d = prev ? ((t - prev) / 1000).toFixed(0) : '-';
    console.log(`${String(r.id).padEnd(4)}\t${t.toISOString().slice(11, 19)}Z ${loc}\t${String(r.speed).padEnd(5)}\t${String(r.course).padEnd(5)}\t${String(r.sats).padEnd(4)}\t${r.simulated}\t${r.lat.toFixed(6)}\t${r.lon.toFixed(6)}\t${String(r.altitude).padEnd(6)}\t${lag}\tgap=${d}s`);
    prev = t;
  }

  console.log('\n=== is there ANY run/session overlapping? ===');
  try {
    const runs = await c.execute({
      sql: `SELECT id, deviceId, sessionId, startedAt, endedAt FROM runs
            WHERE startedAt < '2026-10-11T05:00:00.000Z' AND (endedAt IS NULL OR endedAt > '2026-10-10T15:00:00.000Z')`,
    });
    console.log('runs overlapping:', JSON.stringify(runs.rows || [], null, 2));
  } catch (e) { console.log('runs query failed:', e.message); }

  console.log('\n=== nearby points OUTSIDE the window (immediately before/after) ===');
  const nb = await c.execute({
    sql: `SELECT id, timestamp, lat, lon, speed, sats, simulated FROM gps_points
          WHERE timestamp < '2026-10-10T15:00:00.000Z'
          ORDER BY timestamp DESC LIMIT 5`,
  });
  for (const r of nb.rows || []) console.log('BEFORE', r.id, r.timestamp, r.lat, r.lon, 'spd', r.speed, 'sats', r.sats, 'sim', r.simulated);
  const na = await c.execute({
    sql: `SELECT id, timestamp, lat, lon, speed, sats, simulated FROM gps_points
          WHERE timestamp > '2026-10-11T05:00:00.000Z'
          ORDER BY timestamp ASC LIMIT 5`,
  });
  for (const r of na.rows || []) console.log('AFTER ', r.id, r.timestamp, r.lat, r.lon, 'spd', r.speed, 'sats', r.sats, 'sim', r.simulated);
})().catch(e => { console.error('ERR', e); process.exit(1); });

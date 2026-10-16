// READ-ONLY: what happened to the 2026-10-10 window?
const { getClient } = require('../store/db.js');
const c = getClient();

(async () => {
  const gap = await c.execute({
    sql: `SELECT MIN(id) mn, MAX(id) mx, COUNT(*) n FROM gps_points
          WHERE id BETWEEN 6400 AND 6450`
  });
  console.log('ids 6400..6450 still present:', JSON.stringify(gap.rows[0]));

  const around = await c.execute({
    sql: `SELECT id, timestamp, deviceId, simulated, lat, lon FROM gps_points
          WHERE id BETWEEN 6395 AND 6415 ORDER BY id ASC`
  });
  console.log('\nneighbours of the missing block (id 6406..6436):');
  for (const r of around.rows || []) console.log(' ', r.id, r.timestamp, 'sim=' + r.simulated, r.lat, r.lon);

  const oct10 = await c.execute({
    sql: `SELECT COUNT(*) n FROM gps_points WHERE timestamp LIKE '2026-10-10%'`
  });
  console.log('\nany 2026-10-10 rows left:', oct10.rows[0].n);

  const hi = await c.execute({
    sql: `SELECT id, timestamp, simulated, deviceId FROM gps_points ORDER BY id DESC LIMIT 8`
  });
  console.log('\nnewest rows by id:');
  for (const r of hi.rows || []) console.log(' ', r.id, r.timestamp, 'sim=' + r.simulated, r.deviceId);
})().catch(e => { console.error('ERR', e); process.exit(1); });

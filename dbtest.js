const { Pool } = require('pg');
const p = new Pool({
  connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d',
  keepAlive: true,
  connectionTimeoutMillis: 8000,
});
p.query('SELECT count(*) c FROM genshape3d_jobs')
  .then(r => { console.log('DB OK jobs=', r.rows[0].c); return p.end(); })
  .catch(e => { console.log('FAIL', e.message); process.exit(1); });

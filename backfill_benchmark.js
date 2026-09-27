const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.8:5432/genshape3d',
  ssl: false,
});
pool.query(`UPDATE genshape3d_jobs SET "isBenchmark" = true WHERE name LIKE '[BM]%' AND "isBenchmark" = false`)
  .then(r => { console.log('Updated', r.rowCount, 'benchmark jobs'); pool.end(); })
  .catch(e => { console.error('Error:', e.message); pool.end(); process.exit(1); });

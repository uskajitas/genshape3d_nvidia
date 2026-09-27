const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.8:5432/genshape3d',
  ssl: false,
});
Promise.all([
  pool.query(`SELECT id, name, "isBenchmark", "userEmail" FROM genshape3d_jobs WHERE "isBenchmark" = true LIMIT 5`),
  pool.query(`SELECT id, name, "isBenchmark", "userEmail" FROM genshape3d_jobs WHERE "isBenchmark" = false AND name LIKE '%BM%' LIMIT 10`),
  pool.query(`SELECT id, name, "isBenchmark", "userEmail" FROM genshape3d_jobs ORDER BY "createdAt" DESC LIMIT 10`),
]).then(([marked, unmatched, recent]) => {
  console.log('\n=== isBenchmark=true ===');
  marked.rows.forEach(r => console.log(r.isBenchmark, JSON.stringify(r.name), r.userEmail));
  console.log('\n=== isBenchmark=false but name contains BM ===');
  unmatched.rows.forEach(r => console.log(r.isBenchmark, JSON.stringify(r.name)));
  console.log('\n=== 10 most recent jobs ===');
  recent.rows.forEach(r => console.log(r.isBenchmark, JSON.stringify(r.name)));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });

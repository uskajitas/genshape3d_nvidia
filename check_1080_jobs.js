const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.8:5432/genshape3d', ssl: false });
pool.query(`
  SELECT model, "preferredWorkerId", "assignedWorkerId", status, COUNT(*)::int AS cnt
  FROM genshape3d_jobs
  WHERE "isBenchmark" = true
  GROUP BY model, "preferredWorkerId", "assignedWorkerId", status
  ORDER BY model, status
`).then(r => {
  console.log('model | preferredWorker | assignedWorker | status | count');
  r.rows.forEach(r => console.log(r.model, '|', r.preferredWorkerId, '|', r.assignedWorkerId, '|', r.status, '|', r.cnt));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });

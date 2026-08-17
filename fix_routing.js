const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.8:5432/genshape3d', ssl: false });
// Fix any pending benchmark hunyuan3d jobs that have empty preferredWorkerId - route them to the 1080
pool.query(`
  UPDATE genshape3d_jobs
  SET "preferredWorkerId" = 'i7-1080'
  WHERE "isBenchmark" = true
    AND model = 'hunyuan3d'
    AND "preferredWorkerId" = ''
    AND status = 'pending'
  RETURNING id, name
`).then(r => {
  console.log('Fixed', r.rowCount, 'pending hunyuan3d benchmark jobs → i7-1080');
  r.rows.forEach(j => console.log(' ', j.name));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });

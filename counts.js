const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
p.query(`SELECT status, COUNT(*)::int n FROM genshape3d_jobs WHERE "assignedWorkerId" = 'win-3090' GROUP BY status`)
  .then(r => { console.log(JSON.stringify(r.rows)); return p.end(); })
  .catch(e => { console.log('ERR', e.message); process.exit(1); });

const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
(async () => {
  const r = await p.query(`
    SELECT status, model, "preferredWorkerId", "assignedWorkerId", COUNT(*)::int n
    FROM genshape3d_jobs
    WHERE status IN ('pending','processing')
    GROUP BY status, model, "preferredWorkerId", "assignedWorkerId"
    ORDER BY status, model`);
  console.log(JSON.stringify(r.rows, null, 2));
  await p.end();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

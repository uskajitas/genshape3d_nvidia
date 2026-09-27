const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
(async () => {
  const r = await p.query(`
    SELECT id, name, status, "progressPct", "progressPhase",
           "startedAt", "updatedAt",
           ROUND(EXTRACT(EPOCH FROM (NOW() - "updatedAt"::timestamptz))/60) AS mins_since_update,
           ROUND(EXTRACT(EPOCH FROM (NOW() - "startedAt"::timestamptz))/60) AS mins_running
    FROM genshape3d_jobs
    WHERE status = 'processing' AND "assignedWorkerId" = 'i7-1080'`);
  console.log(JSON.stringify(r.rows, null, 2));
  const q = await p.query(`
    SELECT MIN("createdAt") AS oldest_pending, COUNT(*)::int AS n
    FROM genshape3d_jobs WHERE status='pending' AND "preferredWorkerId"='i7-1080'`);
  console.log('pending for i7:', JSON.stringify(q.rows[0]));
  await p.end();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
(async () => {
  const r = await p.query(`
    SELECT r.id AS run_id, r.name,
           COUNT(i.id)::int AS items,
           COUNT(i."jobId")::int AS with_job,
           COUNT(j.id)::int AS job_found,
           COUNT(*) FILTER (WHERE j.status='done')::int AS done,
           COUNT(*) FILTER (WHERE j.status='failed')::int AS failed,
           COUNT(*) FILTER (WHERE j.status='cancelled')::int AS cancelled,
           COUNT(*) FILTER (WHERE j.id IS NULL)::int AS job_missing,
           COUNT(*) FILTER (WHERE j.deleted = true)::int AS job_deleted
    FROM benchmark_runs r
    LEFT JOIN benchmark_run_items i ON i."runId" = r.id
    LEFT JOIN genshape3d_jobs j ON j.id = i."jobId"
    GROUP BY r.id, r.name ORDER BY MAX(i."createdAt") DESC NULLS LAST LIMIT 5`);
  console.log(JSON.stringify(r.rows, null, 2));
  await p.end();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

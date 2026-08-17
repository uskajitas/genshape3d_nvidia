const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
(async () => {
  // Fail every job this worker has had in 'processing' for over 2 hours —
  // covers the two 12h-stuck ones without touching healthy work.
  const r = await p.query(
    `UPDATE genshape3d_jobs
     SET status='failed', "errorMessage"='killed: hung >2h (VRAM thrash, pre-watchdog)', "completedAt"=NOW(), "updatedAt"=NOW()
     WHERE status='processing' AND "assignedWorkerId"='win-3090'
       AND "startedAt"::timestamptz < NOW() - INTERVAL '2 hours'
     RETURNING id, model, "doTexture", "startedAt"`,
  );
  console.log('failed stuck jobs:', JSON.stringify(r.rows, null, 2));
  await p.end();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

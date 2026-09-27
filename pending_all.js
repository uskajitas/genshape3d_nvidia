const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
(async () => {
  const jobs = await p.query(`
    SELECT status, COUNT(*)::int n FROM genshape3d_jobs GROUP BY status ORDER BY status`);
  console.log('genshape3d_jobs by status:', JSON.stringify(jobs.rows));
  const tex = await p.query(`
    SELECT status, COUNT(*)::int n FROM genshape3d_texture_jobs GROUP BY status ORDER BY status`).catch(e => ({ rows: [['ERR', e.message]] }));
  console.log('texture_jobs by status:', JSON.stringify(tex.rows));
  // Any pending at all, with details
  const pend = await p.query(`
    SELECT id, name, model, "preferredWorkerId", "requestCancel", deleted, "createdAt"
    FROM genshape3d_jobs WHERE status='pending' ORDER BY "createdAt" DESC LIMIT 15`);
  console.log('pending details:', JSON.stringify(pend.rows, null, 2));
  await p.end();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

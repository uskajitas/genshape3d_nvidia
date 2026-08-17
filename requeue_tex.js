const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
(async () => {
  const r = await pool.query(
    `UPDATE genshape3d_texture_jobs
     SET status='pending', "errorMessage"='', "assignedWorkerId"='', "progressPct"=0, "progressPhase"='', "startedAt"=NULL, "completedAt"=NULL, "updatedAt"=NOW()
     WHERE status='failed' AND "errorMessage" LIKE '%functional_tensor%'
     RETURNING id`);
  console.log('requeued:', r.rows.map(x => x.id.slice(0,8)));
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

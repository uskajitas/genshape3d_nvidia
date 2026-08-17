const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
(async () => {
  const r = await pool.query(
    `UPDATE genshape3d_texture_jobs
     SET status='pending', "errorMessage"='', "assignedWorkerId"='', "progressPct"=0, "progressPhase"='', "startedAt"=NULL, "completedAt"=NULL, "updatedAt"=NOW()
     WHERE id='120896d3-7ccf-4562-b60c-532feceffa62' AND status='failed'
     RETURNING id`);
  console.log('requeued:', r.rows.length);
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

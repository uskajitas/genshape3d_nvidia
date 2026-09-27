const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
(async () => {
  const a = await pool.query(`SELECT status, COUNT(*)::int n FROM genshape3d_texture_jobs GROUP BY status`);
  const b = await pool.query(`SELECT id, status, "progressPhase", left("errorMessage",160) err, "createdAt", "assignedWorkerId" FROM genshape3d_texture_jobs ORDER BY "createdAt" DESC LIMIT 5`);
  console.log('by status:', JSON.stringify(a.rows));
  console.log('recent:', JSON.stringify(b.rows, null, 1));
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

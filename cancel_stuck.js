const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
const id = '2fea5b11-2371-4b0f-9973-1e5b078d5ac4';
p.query(`UPDATE genshape3d_jobs SET "requestCancel" = true WHERE id = $1 RETURNING id, status, "requestCancel"`, [id])
  .then(r => { console.log('cancel requested:', JSON.stringify(r.rows[0])); return p.end(); })
  .catch(e => { console.log('ERR', e.message); process.exit(1); });

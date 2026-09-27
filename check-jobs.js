require('dotenv').config();
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
c.connect()
  .then(() => c.query(`SELECT NOW() AS now, (NOW() - INTERVAL '24 hours') AS window_start, COUNT(*) AS used FROM genshape3d_jobs WHERE "userEmail" = 'usquiano@gmail.com' AND "createdAt"::timestamptz > NOW() - INTERVAL '24 hours'`))
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); return c.end(); })
  .catch(e => { console.error('DB ERROR:', e.message); process.exit(1); });

require('dotenv').config();
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
c.connect()
  .then(() => c.query(`SELECT id, model, status, "doTexture", "useMultiView", "preferredWorkerId", "assignedWorkerId", "createdAt", "completedAt", "errorMessage", "imageUrl" FROM genshape3d_jobs WHERE "createdAt"::timestamptz > NOW() - INTERVAL '6 hours' ORDER BY "createdAt" DESC LIMIT 20`))
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); return c.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });

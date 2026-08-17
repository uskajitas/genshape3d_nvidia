require('dotenv').config();
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
c.connect()
  .then(() => c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='genshape3d_texture_jobs' ORDER BY ordinal_position`))
  .then(r => { console.log(r.rows); return c.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });

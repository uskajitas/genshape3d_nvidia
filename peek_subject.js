const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
p.query(`SELECT id, name, "imageUrl", "generationPrompt" FROM benchmark_subjects WHERE "imageUrl" <> '' AND deleted=false ORDER BY "createdAt" DESC LIMIT 5`)
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); return p.end(); })
  .catch(e => { console.log('ERR', e.message); process.exit(1); });

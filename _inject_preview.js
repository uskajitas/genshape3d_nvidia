require('dotenv').config();
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });

const resultUrl = process.argv[2];
const userEmail = process.argv[3] || 'uskajitas@gmail.com';
const imageUrl = process.argv[4] || 'https://edad30fa0fe66f50971087c6b0df0f28.r2.cloudflarestorage.com/genshape3d/uploads/1778827387905-90a13c8c-fa3e-4f17-93fc-719423a00979.png';

c.connect()
  .then(() => c.query(`
    INSERT INTO genshape3d_jobs
      (id, "userEmail", "imageUrl", "resultUrl", model, status,
       "doTexture", "useMultiView", "preferredWorkerId", "assignedWorkerId",
       "inferenceSteps", "octreeResolution", "targetFaceCount", "guidanceScale",
       "createdAt", "completedAt")
    VALUES
      (gen_random_uuid(), $1, $2, $3, 'hunyuan3d-2-1', 'done',
       true, false, 'win-3090', 'win-3090',
       30, 384, 50000, 5.0,
       NOW(), NOW())
    RETURNING id`,
    [userEmail, imageUrl, resultUrl]))
  .then(r => { console.log('injected job', r.rows[0].id); return c.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });

// One-off: fold existing "<name> · refined…" duplicates into their source
// lineage (rootJobId of the matching original, sequential versions, suffix
// moved to versionLabel, name restored to the base). Safe to re-run.
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  // Ensure columns exist even if the server hasn't deployed yet.
  for (const sql of [
    `ALTER TABLE genshape3d_jobs ADD COLUMN IF NOT EXISTS "rootJobId" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE genshape3d_jobs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE genshape3d_jobs ADD COLUMN IF NOT EXISTS "versionLabel" TEXT NOT NULL DEFAULT ''`,
    `UPDATE genshape3d_jobs SET "rootJobId" = id WHERE "rootJobId" = ''`,
  ]) await pool.query(sql);

  const { rows: derivatives } = await pool.query(
    `SELECT id, name, "userEmail", "createdAt" FROM genshape3d_jobs
     WHERE name LIKE '%· refined%' AND deleted = false ORDER BY "createdAt" ASC`,
  );
  let folded = 0;
  for (const d of derivatives) {
    const base = d.name.split('·')[0].trim().replace(/\.\.\.$/, '');
    const label = 'refined' + (d.name.split('· refined')[1] || '').trimEnd();
    const { rows: origs } = await pool.query(
      `SELECT id, "rootJobId" FROM genshape3d_jobs
       WHERE "userEmail" = $1 AND (name = $2 OR name LIKE $3) AND id <> $4 AND name NOT LIKE '%· refined%'
       ORDER BY "createdAt" ASC LIMIT 1`,
      [d.userEmail, base, base.slice(0, 20) + '%', d.id],
    );
    if (!origs.length) { console.log(`no original for "${d.name}" — left as own root`); continue; }
    const root = origs[0].rootJobId || origs[0].id;
    const { rows: ver } = await pool.query(
      `SELECT COALESCE(MAX(version), 1) + 1 AS next FROM genshape3d_jobs WHERE "rootJobId" = $1`,
      [root],
    );
    await pool.query(
      `UPDATE genshape3d_jobs SET "rootJobId" = $1, version = $2, "versionLabel" = $3, name = $4, "updatedAt" = NOW()
       WHERE id = $5`,
      [root, ver[0].next, label.trim(), base, d.id],
    );
    console.log(`folded "${d.name}" -> ${base} v${ver[0].next} (${label.trim()})`);
    folded++;
  }
  console.log(`done: ${folded}/${derivatives.length} folded`);
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

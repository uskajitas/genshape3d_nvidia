const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://genshape3d:genshape3d@192.168.20.16:5432/genshape3d', ssl: false });
(async () => {
  // 1. The hung textured job on the i7 → back to pending, rerouted to 3090.
  const hung = await p.query(`
    UPDATE genshape3d_jobs
    SET status='pending', "assignedWorkerId"='', "preferredWorkerId"='win-3090',
        "progressPct"=0, "progressPhase"='', "startedAt"=NULL, "updatedAt"=NOW()
    WHERE status='processing' AND "assignedWorkerId"='i7-1080' AND "doTexture"=true
    RETURNING id, name`);
  console.log('rescued hung:', JSON.stringify(hung.rows));

  // 2. Any PENDING textured hunyuan jobs still pointed at the i7 → 3090.
  const pend = await p.query(`
    UPDATE genshape3d_jobs
    SET "preferredWorkerId"='win-3090', "updatedAt"=NOW()
    WHERE status='pending' AND "preferredWorkerId"='i7-1080' AND "doTexture"=true
    RETURNING id, name`);
  console.log('rerouted pending:', pend.rows.length, JSON.stringify(pend.rows.map(r => r.name)));

  // 3. What's left for the i7 (should be shape-only now)
  const left = await p.query(`
    SELECT COUNT(*)::int n FROM genshape3d_jobs
    WHERE status='pending' AND "preferredWorkerId"='i7-1080'`);
  console.log('still pending for i7 (shape-only):', left.rows[0].n);
  await p.end();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });

// What the worker window shows, read straight from the database every few seconds.
//
// One list of everything this machine does: 3D models, paints, mesh repairs and parts. Every number in
// the window is counted from these same rows, so a total and the list under it cannot disagree.
const { execFile } = require('child_process');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const FROM_SOURCE = (t, kind, name, model, result, image) => `
  SELECT '${kind}' AS kind, t.id, ${name} AS name, ${model} AS model, t.status, t."errorMessage" AS error,
         t."progressPct" AS pct, t."progressPhase" AS phase,
         t."createdAt"::timestamptz AS created, t."startedAt"::timestamptz AS started,
         COALESCE(t."completedAt"::timestamptz, t."updatedAt"::timestamptz) AS finished,
         COALESCE(t."assignedWorkerId", '') AS worker, '' AS preferred,
         ${image} AS image, ${result} AS result, false AS bench, NULL::int AS peak_mb, t.deleted
    FROM ${t} t LEFT JOIN genshape3d_jobs s ON s.id = t."sourceJobId"`;

const ALL_JOBS = `
  SELECT 'model' AS kind, j.id, j.name, j.model, j.status, j."errorMessage" AS error,
         j."progressPct" AS pct, j."progressPhase" AS phase,
         j."createdAt"::timestamptz AS created, j."startedAt"::timestamptz AS started,
         COALESCE(j."completedAt"::timestamptz, j."updatedAt"::timestamptz) AS finished,
         COALESCE(j."assignedWorkerId", '') AS worker, COALESCE(j."preferredWorkerId", '') AS preferred,
         j."imageUrl" AS image, j."resultUrl" AS result, j."isBenchmark" AS bench, j."gpuMemPeakMB" AS peak_mb, false AS deleted
    FROM genshape3d_jobs j
  UNION ALL ${FROM_SOURCE('genshape3d_texture_jobs', 'paint', `COALESCE(NULLIF(s.name, ''), NULLIF(t.prompt, ''), 'Paint')`, `'hunyuan3d-2-1'`, 't."resultUrl"', `COALESCE(NULLIF(t."sourceImageUrl", ''), s."imageUrl")`)}
  UNION ALL ${FROM_SOURCE('genshape3d_refine_jobs', 'repair', `COALESCE(NULLIF(s.name, ''), 'Mesh repair')`, `'refine'`, 't."resultUrl"', 's."imageUrl"')}
  UNION ALL ${FROM_SOURCE('genshape3d_segment_jobs', 'parts', `COALESCE(NULLIF(s.name, ''), 'Parts')`, `'partfield'`, 't."meshUrl"', 's."imageUrl"')}`;

// Finished on this machine, or cancelled before any machine took it while addressed here.
const FINISHED_HERE = `status IN ('done', 'failed', 'cancelled') AND (worker = $1 OR (worker = '' AND preferred = $1))`;
const LOCAL_DAY = `to_char(finished AT TIME ZONE $2, 'YYYY-MM-DD')`;

const gpu = () => new Promise((resolve) => {
  execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true }, (err, out) => {
    const [used, total] = String(out || '').split(',').map(Number);
    if (err || !Number.isFinite(used) || !Number.isFinite(total)) return resolve(null);
    resolve({ usedGb: used / 1024, totalGb: total / 1024, freeGb: (total - used) / 1024 });
  });
});

/** Why a job is still in the queue. */
function whyWaiting(job, me, models, held, first) {
  if (job.kind === 'model' && !models.includes((job.model || 'hunyuan3d').toLowerCase())) return { blocked: true, why: `This machine has no ${job.model} runner, so nothing will ever start it` };
  if (job.preferred && job.preferred !== me) return { blocked: true, why: `Addressed to ${job.preferred}` };
  if (held.has(job.id)) return { blocked: false, why: held.get(job.id) };
  return { blocked: false, why: first ? 'Next' : 'In line' };
}

/** A job can show "processing" with nothing behind it: say so, and say when it has stopped moving. */
const moved = new Map();
function stillness(job, now) {
  const mark = `${job.pct}|${job.phase}`;
  const last = moved.get(job.id);
  if (!last || last.mark !== mark) { moved.set(job.id, { mark, at: now }); return 0; }
  return now - last.at;
}

async function readReport(pool, { id, models, held, activeCount }) {
  const [live, days, card] = await Promise.all([
    pool.query(`SELECT * FROM (${ALL_JOBS}) a WHERE (status = 'pending' AND NOT deleted) OR (status = 'processing' AND worker = $1) ORDER BY created ASC`, [id]),
    pool.query(`SELECT ${LOCAL_DAY} AS day, status, count(*)::int AS n FROM (${ALL_JOBS}) a WHERE ${FINISHED_HERE} GROUP BY 1, 2`, [id, TZ]),
    gpu(),
  ]);
  const now = Date.now();
  const inProgress = live.rows.filter((j) => j.status === 'processing').map((j) => ({
    ...j, stillMs: stillness(j, now), orphan: activeCount === 0,
  }));
  for (const key of moved.keys()) if (!inProgress.some((j) => j.id === key)) moved.delete(key);
  let first = true;
  const waiting = live.rows.filter((j) => j.status === 'pending').map((j) => {
    const w = whyWaiting(j, id, models, held, first);
    if (!w.blocked) first = false;
    return { ...j, ...w };
  });
  const perDay = {};
  for (const r of days.rows) (perDay[r.day] ||= { day: r.day, done: 0, failed: 0, cancelled: 0 })[r.status] = r.n;
  return { at: now, gpu: card, inProgress, waiting, days: Object.values(perDay).sort((a, b) => b.day.localeCompare(a.day)) };
}

/** Every job finished on this machine between two local days, newest first. */
async function readHistory(pool, id, from, to) {
  const { rows } = await pool.query(
    `SELECT * FROM (${ALL_JOBS}) a WHERE ${FINISHED_HERE} AND ${LOCAL_DAY} BETWEEN $3 AND $4 ORDER BY finished DESC`,
    [id, TZ, from, to],
  );
  return rows;
}

module.exports = { readReport, readHistory, gpu };

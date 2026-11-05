// The 3D worker asks ugpu for the card, like everything else (ugpu/docs/CONTRACT.md). A job that
// wants the card is a job in ugpu; while it runs this tells ugpu how far along it is and how it
// ended. If ugpu is not running the answer is 'down' and the worker does what it did before.
const { spawn } = require('child_process');

const URL_BASE = process.env.UGPU_URL || 'http://127.0.0.1:8460';
const BEAT_MS = 3000;

async function post(path, body) {
  const r = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw Object.assign(new Error(`ugpu ${r.status}`), { refused: true });
  return r.json();
}

const MODELS = {
  trellis2: 'Trellis 2',
  hunyuan3d: 'Hunyuan3D 2',
  'hunyuan3d-2-1': 'Hunyuan3D 2.1',
  hi3dgen: 'Hi3DGen',
  triposr: 'TripoSR',
  sf3d: 'SF3D',
  spar3d: 'SPAR3D',
  partcrafter: 'PartCrafter',
  multiview: 'Multi-view',
};

/** Which app asked, from where the job row says it came. */
function appOf(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('uskiano')) return 'uskiano';
  if (s.includes('ufleet')) return 'ufleet';
  if (s === 'batch') return 'genshape3d';
  if (s) return 'ugen3d';
  return 'genshape3d';
}

const faces = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M faces` : n >= 1000 ? `${Math.round(n / 1000)}k faces` : '');

/** What ugpu shows for a job row of the database: its name, its model and its options in words. */
function describe(kind, job) {
  if (kind === 'paint') {
    return {
      app: 'ugen3d',
      title: `Paint ${job.name || job.prompt || job.id.slice(0, 8)}`.slice(0, 80),
      model: 'Hunyuan3D Paint',
      detail: [job.textureRes && `${job.textureRes} texture`, job.materialPreset, job.keepShape && 'keeps the shape'].filter(Boolean).join(', '),
      imageUrl: job.sourceImageUrl,
    };
  }
  if (kind === 'parts') {
    return { app: 'ugen3d', title: `Parts ${job.id.slice(0, 8)}`, model: 'PartField', detail: job.faceCount ? faces(job.faceCount) : '' };
  }
  const id = (job.model || 'hunyuan3d').toLowerCase();
  const views = Array.isArray(job.recipe?.views) ? job.recipe.views.length + 1 : job.useMultiView ? 4 : 1;
  const detail = [
    views > 1 && `${views} views`,
    job.doTexture ? `${job.textureRes || '1K'} texture` : 'shape only',
    faces(job.targetFaceCount || 0),
  ].filter(Boolean).join(', ');
  return { app: appOf(job.source), title: job.name || job.prompt || job.id.slice(0, 8), model: MODELS[id] || job.model || '', detail, imageUrl: job.imageUrl };
}

/** A small picture of what the job was given, for its row in ugpu. Never holds a job up for long. */
async function thumbOf(url) {
  if (!url) return null;
  try {
    const { nativeImage } = require('electron');
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer()));
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const side = 160 / Math.max(width, height);
    return image.resize({ width: Math.round(width * side), height: Math.round(height * side), quality: 'good' }).toJPEG(80).toString('base64');
  } catch {
    return null; // not in Electron, or the picture is gone: the row shows its icon
  }
}

class UgpuLink {
  /** @param worker the worker: its pool, its cancelJob and its running process */
  constructor(worker) {
    this.worker = worker;
    this.held = new Map();      // worker job id -> { ugpuId, step, total, phase }
    this.thumbs = new Map();    // worker job id -> its small picture to send, null while fetching, false once ugpu has it
    setInterval(() => this.beat(), BEAT_MS).unref();
  }

  /** 'go' when the card is ours, 'wait' to ask again at the next poll, 'down' if ugpu is not there. */
  async ask(id, heavy, info = {}) {
    if (this.held.has(id)) return 'go';
    try {
      const job = await post('/api/jobs', {
        key: `3d|${id}`,
        type: '3d-generation',
        app: info.app || 'genshape3d',
        title: info.title || id.slice(0, 8),
        detail: info.detail || '',
        model: info.model || '',
        memoryGb: heavy ? 16 : 8,
        thumb: this.thumbs.get(id) || undefined,
      });
      // The picture is fetched only once ugpu has answered, and never holds the job up: it follows
      // with the next ask, or with the next report.
      if (job.hasThumb) this.thumbs.set(id, false);
      else if (!this.thumbs.has(id)) {
        this.thumbs.set(id, null);
        thumbOf(info.imageUrl).then((t) => { if (this.thumbs.has(id)) this.thumbs.set(id, t); });
      }
      if (job.status !== 'in_progress') return 'wait';
      this.held.set(id, { ugpuId: job.id, step: 0, total: 0, phase: '' });
      return 'go';
    } catch {
      return 'down';
    }
  }

  /** Jobs waiting behind the one this worker is running: asking again keeps their place. */
  async keep(waiting) {
    for (const [id, heavy, info] of waiting) {
      if ((await this.ask(id, heavy, info)) === 'down') return;
    }
  }

  /** Forgets the pictures of jobs that are no longer waiting or running. */
  forget(waitingIds) {
    const keep = new Set(waitingIds);
    for (const id of this.thumbs.keys()) if (!keep.has(id) && !this.held.has(id)) this.thumbs.delete(id);
  }

  /** What else is on the card, for the worker window. ugpu is the only one who knows. */
  async others() {
    const none = { inProgress: [], waiting: [] };
    const r = await fetch(`${URL_BASE}/api/jobs`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!r?.ok) return none;
    const { jobs } = await r.json();
    const row = (j) => ({ kind: 'picture', id: j.id, name: j.title, model: j.label, started: new Date(j.startedAt || j.createdAt).toISOString(), created: new Date(j.createdAt).toISOString(), stillMs: 0, why: 'In the queue for the RTX 3090' });
    const rest = jobs.filter((j) => j.type !== '3d-generation');
    return { inProgress: rest.filter((j) => j.status === 'in_progress').map(row), waiting: rest.filter((j) => j.status === 'queued').map(row) };
  }

  progress(id, p) {
    const h = this.held.get(id);
    if (!h || !p) return;
    if (p.pct != null) { h.step = Math.round(p.pct); h.total = 100; }
    h.phase = p.detail || p.phase || h.phase;
  }

  async beat() {
    for (const [id, h] of this.held) {
      try {
        const body = { phase: h.phase };
        if (h.total) Object.assign(body, { done: h.step, total: h.total });
        if (this.thumbs.get(id)) { body.thumb = this.thumbs.get(id); this.thumbs.set(id, false); }
        const r = await post(`/api/jobs/${h.ugpuId}/report`, body);
        if (r.stop) this.stop(id);
      } catch (e) {
        if (e.refused) this.held.delete(id); // ugpu ended it: nobody left to tell
      }
    }
  }

  /** Cancel in ugpu means the process tree is dead, not just that a status changed. */
  stop(id) {
    const proc = this.worker.currentProc;
    if (proc?.pid) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    this.worker.cancelJob(id).catch(() => {});
  }

  /** Tells ugpu how the job ended, read from the job's own row. */
  async end(id, table) {
    const h = this.held.get(id);
    this.thumbs.delete(id);
    if (!h) return;
    this.held.delete(id);
    let ok = true;
    let reason;
    try {
      const { rows } = await this.worker.pool.query(`SELECT status, "errorMessage" FROM ${table} WHERE id = $1`, [id]);
      const status = rows[0]?.status;
      if (status === 'failed' || status === 'cancelled') {
        ok = false;
        reason = rows[0].errorMessage || `The job ended as ${status}.`;
      }
    } catch { /* the database is away: the card is free either way */ }
    await post(`/api/jobs/${h.ugpuId}/finish`, { ok, reason }).catch(() => {});
  }
}

module.exports = { UgpuLink, describe };

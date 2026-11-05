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

class UgpuLink {
  /** @param worker the worker: its pool, its cancelJob and its running process */
  constructor(worker) {
    this.worker = worker;
    this.held = new Map();      // worker job id -> { ugpuId, step, total, phase }
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
      });
      if (job.status !== 'in_progress') return 'wait';
      this.held.set(id, { ugpuId: job.id, step: 0, total: 0, phase: '' });
      return 'go';
    } catch {
      return 'down';
    }
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

module.exports = { UgpuLink };

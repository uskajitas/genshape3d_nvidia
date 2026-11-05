// Room on the card before a job starts.
//
// The image editor and the picture generator keep their models on the card between requests, and
// Ollama keeps its own. A 3D model started beside them runs out of memory and the runner dies with
// nothing useful on stderr. So a job first asks them to let go, and if the card is still too full it
// waits in the queue with that reason showing in the worker window. After GIVE_UP_MS it runs anyway,
// which is what happened before this existed.
const { gpu } = require('./report');

const NEED_HEAVY_GB = Number(process.env.GPU_FREE_HEAVY_GB || 16);
const NEED_LIGHT_GB = Number(process.env.GPU_FREE_LIGHT_GB || 8);
const NEIGHBOURS = (process.env.GPU_NEIGHBOURS || 'http://127.0.0.1:8410/unload,http://127.0.0.1:8430/unload').split(',').filter(Boolean);
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const ASK_EVERY_MS = 30_000;
const GIVE_UP_MS = 10 * 60_000;

const post = (url, body, ms) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(ms),
}).then((r) => r.ok, () => false);

async function askToLetGo() {
  const asked = await Promise.all(NEIGHBOURS.map(async (url) => [url, await post(url, null, 15_000)]));
  for (const [url, ok] of asked) console.log(`[GPU] ${url}: ${ok ? 'let go' : 'busy or not running'}`);
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const { models = [] } = await r.json();
    for (const m of models) {
      const ok = await post(`${OLLAMA}/api/generate`, { model: m.model || m.name, keep_alive: 0 }, 30_000);
      console.log(`[GPU] ollama ${m.model || m.name}: ${ok ? 'let go' : 'did not answer'}`);
    }
  } catch { /* Ollama is not running: nothing to ask */ }
  await new Promise((done) => setTimeout(done, 2000));
}

/** A neighbour still loading has not filled the card yet: the free memory read now is not real. */
async function neighbourLoading() {
  const answers = await Promise.all(NEIGHBOURS.map((url) => fetch(url.replace(/\/unload$/, '/health'), { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json()).then((h) => !!h.loading, () => false)));
  return answers.some(Boolean);
}

class GpuRoom {
  constructor(card) {
    this.card = card;
    this.held = new Map();      // job id -> why it is waiting, shown in the window
    this.since = new Map();     // job id -> when it started waiting
    this.askedAt = 0;
  }

  release(id) { this.held.delete(id); this.since.delete(id); }

  /** True when the job may start now. */
  async ready(id, heavy) {
    const need = heavy ? NEED_HEAVY_GB : NEED_LIGHT_GB;
    if (this.card.holder()) {
      this.held.set(id, 'Next: the RTX 3090 is finishing a picture');
      return false;
    }
    const loading = await neighbourLoading();
    let card = await gpu();
    if (!loading && (!card || card.freeGb >= need)) { this.release(id); return true; }
    if (!this.since.has(id)) this.since.set(id, Date.now());
    const gaveUp = Date.now() - this.since.get(id) > GIVE_UP_MS;
    if (loading && !gaveUp) {
      this.held.set(id, 'Waiting: a picture model is loading onto the card');
      return false;
    }
    if (Date.now() - this.askedAt > ASK_EVERY_MS) {
      console.log(`[GPU] ${id.slice(0, 8)} needs ${need} GB, ${card.freeGb.toFixed(1)} GB free: asking the card's other users to let go`);
      this.askedAt = Date.now();
      await askToLetGo();
      card = await gpu();
      if (!card || card.freeGb >= need) { this.release(id); return true; }
    }
    if (gaveUp) {
      console.warn(`[GPU] ${id.slice(0, 8)} waited ${GIVE_UP_MS / 60000} min, starting with ${card ? card.freeGb.toFixed(1) : '?'} GB free`);
      this.release(id);
      return true;
    }
    this.held.set(id, `Waiting for GPU memory: ${card.freeGb.toFixed(1)} GB free, needs ${need} GB`);
    return false;
  }
}

module.exports = { GpuRoom };

// THE POLICY OF THE RTX 3090. One place, one rule set.
//
//   1. One thing on the card at a time. Nothing loads beside anything.
//   2. A running 3D job is never disturbed.
//   3. Nothing is turned away: everything waits its turn. 3D jobs wait in the jobs table, pictures
//      wait here, oldest first. A waiting picture goes when the running job ends, before the next
//      3D job starts, because it takes seconds and a 3D job takes minutes.
//
// A picture waits by asking again: its service answers "busy", the server asks again every 20
// seconds (waitForGpu), and its place here is kept for as long as it keeps asking. Nothing holds a
// connection open for the length of a 3D job.
//
// The worker holds the answer because it knows what is running. If the worker is not running there
// is nothing to protect, so the picture services carry on as they did before (image-edit/card.py).
const http = require('http');

const PORT = Number(process.env.CARD_PORT || 8440);
const LEASE_MS = 15 * 60_000;   // a picture service that dies cannot hold the card for longer than this
const PLACE_MS = 75_000;        // a picture that stops asking has gone away: it loses its place

const BUSY = 'The RTX 3090 is busy: this waits its turn.';

class CardPolicy {
  /** @param {() => boolean} busy3d true while a 3D job runs on this machine */
  constructor(busy3d) {
    this.busy3d = busy3d;
    this.lease = null;
    this.line = [];             // pictures waiting, oldest first: { key, who, what, since, seen }
  }

  /** Who holds the card for a picture right now, if anyone. */
  holder() {
    if (this.lease && Date.now() > this.lease.expires) {
      console.warn(`[Card] ${this.lease.who} never gave the card back: lease expired`);
      this.lease = null;
    }
    return this.lease;
  }

  /** The pictures waiting, oldest first. */
  waiting() {
    const now = Date.now();
    this.line = this.line.filter((p) => now - p.seen < PLACE_MS);
    return this.line;
  }

  /** Null when the card is now theirs, otherwise the words saying to ask again. */
  take(who, what) {
    const text = String(what || who).slice(0, 80);
    const key = `${who}|${text}`;
    const line = this.waiting();
    let place = line.find((p) => p.key === key);
    if (!place) {
      place = { key, who, what: text, since: new Date().toISOString(), seen: 0 };
      line.push(place);
      console.log(`[Card] ${who} joins the line (${line.length} waiting)`);
    }
    place.seen = Date.now();
    if (this.busy3d() || this.holder() || line[0] !== place) return BUSY;
    line.shift();
    this.lease = { who, what: text, since: new Date().toISOString(), expires: Date.now() + LEASE_MS };
    return null;
  }

  give(who) {
    if (this.lease && this.lease.who === who) this.lease = null;
  }

  serve() {
    this.server = http.createServer((req, res) => {
      const answer = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET') return answer(200, { holder: this.holder(), waiting: this.waiting(), busy3d: this.busy3d() });
      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 4096) req.destroy(); });
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(raw || '{}'); } catch { return answer(400, { error: 'not JSON' }); }
        if (!b.who) return answer(400, { error: 'who is required' });
        if (req.url === '/give') { this.give(b.who); return answer(200, { ok: true }); }
        if (req.url !== '/take') return answer(404, { error: 'unknown' });
        const why = this.take(b.who, b.what);
        return why ? answer(409, { error: why }) : answer(200, { ok: true });
      });
    });
    this.server.on('error', (e) => console.error(`[Card] cannot listen on ${PORT}: ${e.message}`));
    this.server.listen(PORT, '127.0.0.1', () => console.log(`[Card] policy listening on 127.0.0.1:${PORT}`));
  }
}

module.exports = { CardPolicy };

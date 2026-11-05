// THE POLICY OF THE RTX 3090. One place, one rule set.
//
//   1. One thing on the card at a time.
//   2. 3D comes first. While a 3D job runs or waits, every picture is refused.
//   3. A picture that arrives while the card is taken is refused at once. It does not queue, and
//      it does not load beside anything.
//
// The worker holds the answer because it knows the 3D queue. The picture services ask it on
// 127.0.0.1 before touching the card. If the worker is not running there is no 3D to protect, so
// they carry on as they did before (image-edit/card.py).
const http = require('http');

const PORT = Number(process.env.CARD_PORT || 8440);
const LEASE_MS = 15 * 60_000;   // a picture service that dies cannot hold the card for longer than this

const BUSY_3D = 'The RTX 3090 is busy making a 3D model. Send this again when it finishes.';
const BUSY_PICTURE = 'The RTX 3090 is busy with another picture. Send this again in a moment.';

class CardPolicy {
  /** @param {() => boolean} busy3d true while a 3D job runs or waits on this machine */
  constructor(busy3d) {
    this.busy3d = busy3d;
    this.lease = null;
    this.refused = 0;
  }

  /** Who holds the card for a picture right now, if anyone. */
  holder() {
    if (this.lease && Date.now() > this.lease.expires) {
      console.warn(`[Card] ${this.lease.who} never gave the card back: lease expired`);
      this.lease = null;
    }
    return this.lease;
  }

  /** Null when the card is now theirs, otherwise the words of the refusal. */
  take(who, what) {
    const why = this.busy3d() ? BUSY_3D : this.holder() ? BUSY_PICTURE : null;
    if (why) {
      this.refused++;
      console.log(`[Card] refused ${who}: ${why}`);
      return why;
    }
    this.lease = { who, what: String(what || '').slice(0, 80), since: new Date().toISOString(), expires: Date.now() + LEASE_MS };
    return null;
  }

  give(who) {
    if (this.lease && this.lease.who === who) this.lease = null;
  }

  serve() {
    this.server = http.createServer((req, res) => {
      const answer = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET') return answer(200, { holder: this.holder(), busy3d: this.busy3d(), refused: this.refused });
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

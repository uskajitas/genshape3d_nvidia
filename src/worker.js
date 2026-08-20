const { EventEmitter } = require('events');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Worker — same code runs on both the 1080 (i7) and the 3090.
// Behaviour is configured per-machine via .env:
//   WORKER_ID:     unique id stamped on jobs this machine claims
//                  ('i7-1080' on the 1080, 'win-3090' on the 3090).
//   WORKER_MODELS: comma-separated models this machine can run; the
//                  pending-jobs query filters by this so a machine
//                  never claims a job it can't actually run.
// Postgres on the i7 is the single source of truth. Each app's UI
// filters by its WORKER_ID so users only see what THIS machine has
// touched.
const WORKER_ID = (process.env.WORKER_ID || 'i7-1080').trim();

class Worker extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.workerId = WORKER_ID;
    // Postgres runs plain TCP on the private LAN (no SSL) — both on the i7
    // itself (127.0.0.1) and for LAN boxes (192.168.20.16). The trust
    // boundary is the LAN, not TLS. Opt back into SSL only if DB_SSL=1.
    const useSsl = process.env.DB_SSL === '1';
    this._makePool = () => {
      const pool = new Pool({
        connectionString: config.databaseUrl,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
        keepAlive: true,
        max: 3,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      pool.on('error', (err) => {
        console.error('[Worker] Pool error (will reconnect):', err.message);
      });
      return pool;
    };
    this.pool = this._makePool();
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: config.r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.r2AccessKey,
        secretAccessKey: config.r2SecretKey,
      },
    });
    this.pollTimer = null;
    this.processing = false;
    this.activeCount = 0;
    this.maxConcurrent = config.maxConcurrent || 1;
    this.currentJob = null;
    this.currentProc = null;
    this.pendingJobs = [];
    this.processingJobs = [];
    this.completedJobs = [];
    this.failedJobs = [];
    this.cancelledJobs = [];
  }

  getState() {
    return {
      currentJob: this.currentJob,
      pendingJobs: this.pendingJobs,
      processingJobs: this.processingJobs,
      completedJobs: this.completedJobs.slice(0, 20),
      failedJobs: this.failedJobs.slice(0, 20),
      cancelledJobs: this.cancelledJobs.slice(0, 20),
      // All-time totals per status (the lists above are recent-only/capped)
      counts: this.counts || null,
      isProcessing: this.processing,
      maxConcurrent: this.maxConcurrent,
      activeCount: this.activeCount,
    };
  }

  async start() {
    console.log('[Worker] Starting poll loop...');
    await this.ensureTable();
    // On startup, mark any "processing" rows still tagged to THIS worker
    // as failed — they're orphans from a previous run that got SIGKILL'd.
    // Otherwise they'd stay marked processing forever and confuse the
    // OOM guard / admin UI.
    try {
      const orphaned = await this.pool.query(
        `UPDATE genshape3d_jobs
            SET status='failed',
                "completedAt"=NOW(),
                "updatedAt"=NOW(),
                "progressPhase"='orphaned-by-worker-restart',
                "errorMessage" = COALESCE(NULLIF("errorMessage", ''), 'worker process was restarted mid-job')
          WHERE status='processing' AND "assignedWorkerId"=$1
          RETURNING id`,
        [this.workerId],
      );
      if (orphaned.rowCount > 0) {
        console.log(`[Worker] Cleared ${orphaned.rowCount} orphan processing row(s) from previous run.`);
      }
    } catch (e) {
      console.warn(`[Worker] Orphan cleanup failed (non-fatal): ${e.message}`);
    }
    // Orphan cleanup for texture jobs
    try {
      const texOrphaned = await this.pool.query(
        `UPDATE genshape3d_texture_jobs
            SET status='failed', "completedAt"=NOW(), "updatedAt"=NOW(),
                "progressPhase"='orphaned-by-worker-restart',
                "errorMessage" = COALESCE(NULLIF("errorMessage", ''), 'worker process was restarted mid-job')
          WHERE status='processing' AND "assignedWorkerId"=$1
          RETURNING id`,
        [this.workerId],
      );
      if (texOrphaned.rowCount > 0) {
        console.log(`[Worker] Cleared ${texOrphaned.rowCount} orphan texture job(s) from previous run.`);
      }
    } catch (e) {
      console.warn(`[Worker] Texture orphan cleanup failed (non-fatal): ${e.message}`);
    }
    // Orphan cleanup for refine jobs
    try {
      const refOrphaned = await this.pool.query(
        `UPDATE genshape3d_refine_jobs
            SET status='failed', "completedAt"=NOW(), "updatedAt"=NOW(),
                "progressPhase"='orphaned-by-worker-restart',
                "errorMessage" = COALESCE(NULLIF("errorMessage", ''), 'worker process was restarted mid-job')
          WHERE status='processing' AND "assignedWorkerId"=$1
          RETURNING id`,
        [this.workerId],
      );
      if (refOrphaned.rowCount > 0) {
        console.log(`[Worker] Cleared ${refOrphaned.rowCount} orphan refine job(s) from previous run.`);
      }
    } catch (e) {
      console.warn(`[Worker] Refine orphan cleanup failed (non-fatal): ${e.message}`);
    }
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.config.pollInterval);

    // Stuck-poll watchdog. After a DB outage, pg-pool can end up with every
    // client stuck: the next pool.query() waits forever for a free client,
    // `_polling` never resets, and every later tick returns instantly — the
    // worker looks alive but silently stops claiming jobs forever (this
    // exact failure ate an afternoon of texture jobs on 2026-08-17). If a
    // single poll has been "in flight" for over 3 minutes, destroy the pool,
    // build a fresh one, and let the loop resume.
    this.pollWatchdogTimer = setInterval(() => {
      if (this._polling && this._pollStartedAt && Date.now() - this._pollStartedAt > 180000) {
        console.error('[Worker] Poll stuck for >3min — resetting DB pool and poll state.');
        this.resetPool();
        this._polling = false;
      }
    }, 60000);
  }

  resetPool() {
    const old = this.pool;
    this.pool = this._makePool();
    if (old) old.end().catch(() => { /* already broken */ });
    console.log('[Worker] DB pool recreated.');
  }

  async ensureTable() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS genshape3d_jobs (
          id                TEXT PRIMARY KEY,
          "userEmail"       TEXT NOT NULL,
          "imageUrl"        TEXT NOT NULL DEFAULT '',
          prompt            TEXT NOT NULL DEFAULT '',
          style             TEXT NOT NULL DEFAULT 'Realistic',
          status            TEXT NOT NULL DEFAULT 'pending',
          "resultUrl"       TEXT NOT NULL DEFAULT '',
          "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "startedAt"       TIMESTAMPTZ,
          "completedAt"     TIMESTAMPTZ,
          "polygonBudget"   TEXT NOT NULL DEFAULT 'Medium (50k-200k)',
          "textureRes"      TEXT NOT NULL DEFAULT '1K',
          "exportFormat"    TEXT NOT NULL DEFAULT 'GLB',
          "detailLevel"     TEXT NOT NULL DEFAULT 'Standard',
          "doTexture"       BOOLEAN NOT NULL DEFAULT false,
          "progressPct"     INTEGER NOT NULL DEFAULT 0,
          "progressPhase"   TEXT NOT NULL DEFAULT '',
          "progressStep"    INTEGER NOT NULL DEFAULT 0,
          "progressTotal"   INTEGER NOT NULL DEFAULT 0,
          "requestCancel"   BOOLEAN NOT NULL DEFAULT false
        );
      `);
      // Add columns if they don't exist (for existing tables)
      const newCols = [
        ['"startedAt"',      'TIMESTAMPTZ'],
        ['"completedAt"',    'TIMESTAMPTZ'],
        ['"polygonBudget"',  "TEXT NOT NULL DEFAULT 'Medium (50k-200k)'"],
        ['"textureRes"',     "TEXT NOT NULL DEFAULT '1K'"],
        ['"exportFormat"',   "TEXT NOT NULL DEFAULT 'GLB'"],
        ['"detailLevel"',    "TEXT NOT NULL DEFAULT 'Standard'"],
        ['"doTexture"',      'BOOLEAN NOT NULL DEFAULT false'],
        ['"useMultiView"',   'BOOLEAN NOT NULL DEFAULT false'],
        ['"gpuMemPeakMB"',   'INTEGER NOT NULL DEFAULT 0'],
        ['"gpuUtilAvg"',     'REAL NOT NULL DEFAULT 0'],
        ['"gpuUtilPeak"',    'REAL NOT NULL DEFAULT 0'],
        ['"gpuSamples"',     'INTEGER NOT NULL DEFAULT 0'],
        ['"progressPct"',    'INTEGER NOT NULL DEFAULT 0'],
        ['"progressPhase"',  "TEXT NOT NULL DEFAULT ''"],
        ['"progressStep"',   'INTEGER NOT NULL DEFAULT 0'],
        ['"progressTotal"',  'INTEGER NOT NULL DEFAULT 0'],
        ['"requestCancel"',  'BOOLEAN NOT NULL DEFAULT false'],
        ['"rootJobId"',      "TEXT NOT NULL DEFAULT ''"],
        ['version',          'INTEGER NOT NULL DEFAULT 1'],
        ['"versionLabel"',   "TEXT NOT NULL DEFAULT ''"],
        ['"errorMessage"',   "TEXT NOT NULL DEFAULT ''"],
        ['"octreeResolution"', 'INTEGER NOT NULL DEFAULT 0'],
        ['"targetFaceCount"',  'INTEGER NOT NULL DEFAULT 0'],
        ['"inferenceSteps"',   'INTEGER NOT NULL DEFAULT 0'],
        ['"guidanceScale"',    'REAL NOT NULL DEFAULT 0'],
        ['"numChunks"',        'INTEGER NOT NULL DEFAULT 0'],
        ['"seed"',             'INTEGER NOT NULL DEFAULT 0'],
      ];
      for (const [col, type] of newCols) {
        try {
          await this.pool.query(`ALTER TABLE genshape3d_jobs ADD COLUMN IF NOT EXISTS ${col} ${type}`);
        } catch { /* column already exists */ }
      }
      console.log('[Worker] Table genshape3d_jobs ready');
    } catch (err) {
      console.error('[Worker] Failed to ensure table:', err.message);
    }
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.currentProc) {
      this.currentProc.kill('SIGTERM');
    }
    this.pool.end().catch(() => {});
  }

  /**
   * Cancel a job by ID.
   * - If it's the currently running job, kill the child process.
   * - For any job in pending/processing, set status to 'cancelled' in DB.
   */
  async cancelJob(jobId) {
    console.log(`[Worker] Cancelling job ${jobId}`);

    if (this.currentJob && this.currentJob.id === jobId && this.currentProc) {
      console.log('[Worker] Killing active Hunyuan3D process...');
      this.currentProc.kill('SIGTERM');
      setTimeout(() => {
        if (this.currentProc) {
          try { this.currentProc.kill('SIGKILL'); } catch {}
        }
      }, 3000);
    }

    try {
      const completedAt = new Date().toISOString();
      await this.pool.query(
        `UPDATE genshape3d_jobs SET status = 'cancelled', "completedAt" = $1, "updatedAt" = NOW(), "requestCancel" = false WHERE id = $2 AND status IN ('pending', 'processing')`,
        [completedAt, jobId]
      );
      console.log(`[Worker] Job ${jobId} cancelled in DB`);
    } catch (err) {
      console.error(`[Worker] Failed to cancel job in DB:`, err.message);
    }

    this.emit('stateChanged');
    return { ok: true };
  }

  async poll() {
    // Re-entrancy guard: setInterval fires on a wall-clock schedule
    // regardless of whether the previous poll() has finished its DB
    // awaits. Without this, two overlapping polls can both see the same
    // pending job, both issue the claim UPDATE, and both waste a DB
    // round-trip. The atomic WHERE status='pending' saves correctness,
    // but the guard keeps things clean and predictable.
    if (this._polling) return;
    this._polling = true;
    this._pollStartedAt = Date.now();

    // Heartbeat so we can confirm the loop is alive even when there's
    // nothing to claim. Logged once every ~30s of polling.
    this._pollCount = (this._pollCount || 0) + 1;
    if (this._pollCount % 15 === 1) {
      console.log(`[Worker] poll #${this._pollCount} (active=${this.activeCount}/${this.maxConcurrent})`);
    }
    try {
      // ── Pending ───────────────────────────────────────────────
      // The SERVER decides which worker runs which job by setting
      // preferredWorkerId at job creation time (see server/jobsRepo.ts
      // -> routeWorker). Each worker ONLY claims jobs preferred for it.
      // No racing, no mixing across machines. Legacy jobs without a
      // preference still respect the model filter for back-compat.
      const models = this.config.models || ['hunyuan3d'];
      const { rows: pending } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs
         WHERE status = 'pending'
           AND (model = ANY($1::text[]) OR (model IS NULL AND 'hunyuan3d' = ANY($1::text[])))
           AND ("preferredWorkerId" = $2 OR "preferredWorkerId" = '' OR "preferredWorkerId" IS NULL)
         ORDER BY "createdAt" ASC`,
        [models, this.workerId]
      );
      this._pendingForClaim = pending;

      // ── Stale-pending takeover ─────────────────────────────────
      // Guarantee: no job sits pending forever just because it was routed to
      // a worker that's offline. If a pending job addressed to ANOTHER worker
      // has waited > TAKEOVER_AFTER_MIN (default 10) and this machine can run
      // its model, we claim it. Env-gated (TAKEOVER_STALE_PENDING=true in the
      // 3090's .env) so the 1080 — which can't run textured/hi3dgen work —
      // never steals jobs it would hang on. Textured jobs are additionally
      // excluded unless this machine lists hunyuan3d-2-1 (a texture-capable
      // stack implies the paint pipeline fits in VRAM).
      if ((process.env.TAKEOVER_STALE_PENDING || '').toLowerCase() === 'true') {
        const afterMin = parseInt(process.env.TAKEOVER_AFTER_MIN || '10', 10);
        const canTexture = models.includes('hunyuan3d-2-1');
        const { rows: stale } = await this.pool.query(
          `SELECT * FROM genshape3d_jobs
           WHERE status = 'pending'
             AND model = ANY($1::text[])
             AND "preferredWorkerId" <> '' AND "preferredWorkerId" IS NOT NULL
             AND "preferredWorkerId" <> $2
             AND "createdAt"::timestamptz < NOW() - ($3 || ' minutes')::interval
             ${canTexture ? '' : 'AND "doTexture" = false'}
           ORDER BY "createdAt" ASC`,
          [models, this.workerId, afterMin]
        );
        if (stale.length > 0) {
          console.log(`[Worker] taking over ${stale.length} stale pending job(s) addressed to an offline worker.`);
          this._pendingForClaim.push(...stale);
        }
      }

      this.pendingJobs = [];

      // ── Processing — only this machine's ──────────────────────
      const { rows: processing } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'processing' AND "assignedWorkerId" = $1 ORDER BY "startedAt" ASC`,
        [this.workerId]
      );
      // Texture jobs live in their own table but must ALSO appear here:
      // the tray UI renders this list (otherwise it says "processing 0"
      // during a paint), and isHeavy() below reads it for GPU exclusivity
      // (otherwise a mesh job could start mid-paint). mapTexJob converts a
      // texture row to the job-card shape shared with regular jobs.
      const mapTexJob = (t) => ({
        id: t.id,
        name: `[TEX] ${t.materialPreset && t.materialPreset !== 'Auto' ? t.materialPreset : (t.prompt || 'texture')}`.slice(0, 60),
        model: 'hunyuan3d-2-1',
        doTexture: true,
        isTexture: true,
        status: t.status,
        progressPct: t.progressPct,
        progressPhase: t.progressPhase,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        createdAt: t.createdAt,
        imageUrl: t.sourceImageUrl || '',
        resultUrl: t.resultUrl || '',
        errorMessage: t.errorMessage || '',
        userEmail: t.userEmail,
      });
      const { rows: texProcessing } = await this.pool.query(
        `SELECT * FROM genshape3d_texture_jobs WHERE status = 'processing' AND "assignedWorkerId" = $1 ORDER BY "startedAt" ASC`,
        [this.workerId]
      );
      this.processingJobs = [...processing, ...texProcessing.map(mapTexJob)];

      // Heartbeat: bump updatedAt on our running jobs every poll. The server's
      // stuck-job sweeper requeues 'processing' rows whose updatedAt is stale
      // >30 min — runners can legitimately go long stretches without PROGRESS
      // lines (paint step), so without this a healthy job could get requeued
      // out from under us. With it, staleness == this worker is actually dead.
      if (processing.length > 0) {
        await this.pool.query(
          `UPDATE genshape3d_jobs SET "updatedAt" = NOW() WHERE status = 'processing' AND "assignedWorkerId" = $1`,
          [this.workerId]
        ).catch(() => { /* non-fatal */ });
      }

      // ── Recent lists — only this machine's, last 24h, capped ──────────────
      // The lists are a "what happened recently" view, NOT full history —
      // keeps the tray UI light no matter how many jobs accumulate. True
      // all-time totals come from the counts query below.
      const RECENT = `AND "completedAt"::timestamptz > NOW() - INTERVAL '24 hours'`;

      const { rows: cancelled } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'cancelled' AND "assignedWorkerId" = $1 ${RECENT} ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      this.cancelledJobs = cancelled;

      // Finished paints join the history lists (they used to vanish once
      // done). mapTexJob is defined next to the processing merge above.
      const byCompletedDesc = (a, b) =>
        new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime();

      const { rows: completed } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'done' AND "assignedWorkerId" = $1 ${RECENT} ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      const { rows: texCompleted } = await this.pool.query(
        `SELECT * FROM genshape3d_texture_jobs WHERE status = 'done' AND "assignedWorkerId" = $1 ${RECENT} ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      this.completedJobs = [...completed, ...texCompleted.map(mapTexJob)]
        .sort(byCompletedDesc).slice(0, 20);

      const { rows: failed } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'failed' AND "assignedWorkerId" = $1 ${RECENT} ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      const { rows: texFailed } = await this.pool.query(
        `SELECT * FROM genshape3d_texture_jobs WHERE status = 'failed' AND "assignedWorkerId" = $1 ${RECENT} ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      this.failedJobs = [...failed, ...texFailed.map(mapTexJob)]
        .sort(byCompletedDesc).slice(0, 20);

      // ── True all-time totals for the stat boxes ────────────────────────────
      const { rows: countRows } = await this.pool.query(
        `SELECT status, COUNT(*)::int AS n FROM genshape3d_jobs WHERE "assignedWorkerId" = $1 GROUP BY status`,
        [this.workerId]
      );
      const counts = { done: 0, failed: 0, cancelled: 0, processing: 0 };
      for (const r of countRows) if (r.status in counts) counts[r.status] = r.n;
      counts.pending = this._pendingForClaim.length; // claimable by this worker
      this.counts = counts;

      // Check for requestCancel from the web frontend
      if (this.currentJob) {
        const { rows } = await this.pool.query(
          `SELECT "requestCancel" FROM genshape3d_jobs WHERE id = $1`,
          [this.currentJob.id]
        );
        if (rows[0]?.requestCancel === true) {
          console.log(`[Worker] Frontend requested cancel for job ${this.currentJob.id}`);
          await this.cancelJob(this.currentJob.id);
          return;
        }
      }

      // Also check requestCancel on pending jobs
      for (const job of pending) {
        if (job.requestCancel === true) {
          console.log(`[Worker] Frontend requested cancel for pending job ${job.id}`);
          await this.cancelJob(job.id);
        }
      }

      this.emit('stateChanged');

      if (this._pendingForClaim.length > 0) {
        console.log(`[Worker] poll: ${this._pendingForClaim.length} claimable; activeCount=${this.activeCount}/${this.maxConcurrent}`);
      }
      if (this.activeCount < this.maxConcurrent && this._pendingForClaim.length > 0) {
        const nextJob = this._pendingForClaim.find(j => !j.requestCancel);
        if (nextJob) {
          // VRAM safety guard — heavy jobs get the GPU EXCLUSIVELY.
          // "Heavy" = textured Hunyuan3D (2.0/2.1 shape+paint pipes) or
          // hi3dgen (trellis pipeline). Any two heavy-ish pipelines sharing
          // the 24 GB card exhaust VRAM; on Windows WDDM then silently spills
          // to system RAM and both jobs crawl for hours at 99% GPU (this
          // exact pairing — hi3dgen + textured-2.1 — cost a 12h hang).
          // Rule: a heavy job can't start while ANYTHING else runs, and
          // nothing can start while a heavy job runs.
          const isHeavy = (j) => {
            const m = (j.model || 'hunyuan3d').toLowerCase();
            return ((m === 'hunyuan3d' || m === 'hunyuan3d-2-1') && j.doTexture) || m === 'hi3dgen' || m === 'trellis2';
          };
          const heavyRunning = this.processingJobs.some(isHeavy);
          const blocked = heavyRunning || (isHeavy(nextJob) && this.processingJobs.length > 0);
          if (blocked) {
            console.log(`[Worker] holding ${nextJob.id.slice(0,8)} — GPU exclusivity (heavy job running or queued job is heavy).`);
          } else {
            this.processJob(nextJob);
          }
        }
      }

      // ── Texture jobs ──────────────────────────────────────────────────────
      // Texture paint is heavy — same GPU-exclusivity rule as above: only
      // pick one up when NOTHING else is running on this worker.
      if (this.activeCount === 0) {
        try {
          const { rows: texPending } = await this.pool.query(
            `SELECT * FROM genshape3d_texture_jobs
             WHERE status = 'pending'
             ORDER BY "createdAt" ASC
             LIMIT 1`,
          );
          if (texPending.length > 0) {
            console.log(`[Worker] Picking up texture job ${texPending[0].id.slice(0, 8)}`);
            this.processTextureJob(texPending[0]);
          }
        } catch (texErr) {
          console.warn(`[Worker] Texture job poll failed (non-fatal): ${texErr.message}`);
        }
      }

      // ── Refine jobs (mesh repair/retopo) ──────────────────────────────────
      // CPU-only and fast (~10 s) but keep the same only-when-idle gate for
      // simplicity — the queue drains quickly anyway.
      if (this.activeCount === 0) {
        try {
          const { rows: refPending } = await this.pool.query(
            `SELECT * FROM genshape3d_refine_jobs
             WHERE status = 'pending' AND deleted = false
             ORDER BY "createdAt" ASC
             LIMIT 1`,
          );
          if (refPending.length > 0) {
            console.log(`[Worker] Picking up refine job ${refPending[0].id.slice(0, 8)}`);
            this.processRefineJob(refPending[0]);
          }
        } catch (refErr) {
          console.warn(`[Worker] Refine job poll failed (non-fatal): ${refErr.message}`);
        }
      }
    } catch (err) {
      console.error('[Worker] Poll error:', err.message);
      console.error(err.stack);
      // Connection-class errors poison the pool's clients — recreate it now
      // instead of letting the next poll hang on a dead client.
      if (/timeout|terminat|ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(err.message || '')) {
        this.resetPool();
      }
    } finally {
      this._polling = false;
    }
  }

  /**
   * Write progress to the database so the web frontend can read it.
   */
  async updateProgress(jobId, progress) {
    try {
      await this.pool.query(
        `UPDATE genshape3d_jobs SET "progressPct" = $1, "progressPhase" = $2, "progressStep" = $3, "progressTotal" = $4, "updatedAt" = NOW() WHERE id = $5`,
        [progress.pct, progress.detail || progress.phase, progress.step, progress.total, jobId]
      );
    } catch (err) {
      console.error('[Worker] Failed to update progress:', err.message);
    }
  }

  async processJob(job) {
    this.processing = true;
    this.activeCount++;
    const startedAt = new Date().toISOString();
    job.startedAt = startedAt;
    this.currentJob = job;
    this.emit('jobReceived', job);

    let tmpDir;
    try {
      // Atomic claim: only succeeds if still 'pending' (defends
      // against the 1080 grabbing it first). The UPDATE also stamps
      // assignedWorkerId so the UI filter sees this job as ours.
      const claim = await this.pool.query(
        `UPDATE genshape3d_jobs SET status = 'processing', "startedAt" = $1, "progressPct" = 0, "progressPhase" = 'Preparing...', "progressStep" = 0, "progressTotal" = 0, "assignedWorkerId" = $2, "updatedAt" = NOW() WHERE id = $3 AND status = 'pending'`,
        [startedAt, this.workerId, job.id]
      );
      if (claim.rowCount === 0) {
        console.log(`[Worker] Job ${job.id} taken by another worker (likely 1080), skipping`);
        this.activeCount--;
        this.processing = false;
        this.currentJob = null;
        return;
      }
      job.status = 'processing';
      this.emit('jobProcessing', job);

      // Create temp directory for this job
      tmpDir = path.join(os.tmpdir(), `genshape3d-${job.id}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      // Download input image(s) from R2. auxImageUrls is a jsonb array of
      // additional view URLs (side/back/three_q) generated by the server's
      // multi-view step. They're treated as hints: the runner uses them
      // when it supports multi-view input, otherwise it ignores them.
      await this.updateProgress(job.id, { pct: 0, phase: 'downloading', step: 0, total: 0, detail: 'Downloading image...' });
      const inputImagePath = await this.downloadFromR2(job.imageUrl, tmpDir, 'input');
      console.log(`[Worker] Downloaded input image to ${inputImagePath}`);

      const auxUrls = Array.isArray(job.auxImageUrls) ? job.auxImageUrls.filter(Boolean) : [];
      const auxImagePaths = [];
      for (let i = 0; i < auxUrls.length; i++) {
        try {
          const p = await this.downloadFromR2(auxUrls[i], tmpDir, `aux${i}`);
          auxImagePaths.push(p);
          console.log(`[Worker] Downloaded aux view ${i + 1}/${auxUrls.length} → ${p}`);
        } catch (err) {
          console.warn(`[Worker] Failed to download aux view ${i + 1} (${auxUrls[i]}): ${err.message}`);
        }
      }
      if (auxImagePaths.length > 0) {
        console.log(`[Worker] Using ${auxImagePaths.length} auxiliary view(s) for multi-view conditioning.`);
      }

      // ── Local multi-view auto-generation ─────────────────────────
      // If no aux views came in with the job, generate them right here
      // on this machine using Zero123++ (no Replicate, no API).
      //
      // Zero123++ assumes the subject's vertical axis is upright in the
      // canvas — works great for figurines, characters, vehicles seen
      // straight, bipeds (kangaroo, person, robot). Drifts badly on
      // horizontally-posed subjects (iguana, dog lying down, car seen
      // from above). We detect the foreground bounding box: if it's
      // taller-than-wide we run auto-mv; if it's wider-than-tall we
      // skip and let mv-on-single-image handle it.
      //
      // ENABLE_AUTO_MULTIVIEW=false in env disables this entirely.
      const jobModelLower = (job.model || 'hunyuan3d').toLowerCase();
      const autoMvOff = (process.env.ENABLE_AUTO_MULTIVIEW || 'true').toLowerCase() === 'false';
      // Per-job behaviour:
      //   useMultiView === true  -> force auto-mv regardless of orientation
      //   anything else          -> let the upright-bbox heuristic decide
      // (False is treated as "default", not "explicit no" — the toggle in
      // the UI is opt-IN to override; opt-OUT happens via env or by the
      // heuristic itself when the subject is horizontal.)
      let shouldAutoMv;
      if (autoMvOff || auxImagePaths.length > 0 || jobModelLower !== 'hunyuan3d') {
        shouldAutoMv = false;
      } else if (job.useMultiView === true) {
        shouldAutoMv = true;
        console.log('[Worker] useMultiView=true on job, running auto-mv regardless of orientation.');
      } else {
        shouldAutoMv = await this.isUprightSubject(inputImagePath);
      }
      if (shouldAutoMv) {
        try {
          const generated = await this.generateLocalMultiView(inputImagePath, tmpDir, job.id);
          if (generated.localPaths && generated.localPaths.length > 0) {
            auxImagePaths.push(...generated.localPaths);
            // Persist the R2 URLs so the admin trail (worker tray + admin
            // page) can show what views fed this 3D job.
            if (generated.r2Urls && generated.r2Urls.length > 0) {
              await this.pool.query(
                `UPDATE genshape3d_jobs SET "auxImageUrls" = $1::jsonb WHERE id = $2`,
                [JSON.stringify(generated.r2Urls), job.id],
              );
              job.auxImageUrls = generated.r2Urls;
              this.emit('stateChanged');
            }
            console.log(`[Worker] Auto-generated ${generated.localPaths.length} local view(s); attached to job.`);
          }
        } catch (err) {
          console.warn(`[Worker] Local multi-view generation failed (continuing single-view): ${err.message}`);
        }
      }

      // Build Hunyuan3D params from job's generation settings
      const genParams = this.buildGenParams(job);
      console.log(`[Worker] Generation params:`, JSON.stringify(genParams));

      // Pick the runner for this job's model (defaults to hunyuan3d).
      const model = (job.model || 'hunyuan3d').toLowerCase();
      await this.updateProgress(job.id, { pct: 5, phase: 'loading', step: 0, total: genParams.steps, detail: `Loading ${model} model...` });

      // Start GPU telemetry. nvidia-smi sampled every 2 s while the
      // runner is alive — we record peak VRAM and avg/peak utilisation
      // onto the job row so admin can correlate quality with GPU load.
      const stopGpu = this.startGpuSampler();

      let glbPath;
      try {
        glbPath = await this.callRunner(model, inputImagePath, tmpDir, genParams, auxImagePaths, job);
      } finally {
        const gpu = await stopGpu();
        try {
          await this.pool.query(
            `UPDATE genshape3d_jobs
                SET "gpuMemPeakMB" = $1,
                    "gpuUtilAvg"   = $2,
                    "gpuUtilPeak"  = $3,
                    "gpuSamples"   = $4
              WHERE id = $5`,
            [gpu.peakMemMB, gpu.avgUtil, gpu.peakUtil, gpu.samples, job.id],
          );
          console.log(`[Worker] GPU stats for ${job.id.slice(0,8)}: peak ${gpu.peakMemMB} MB, util avg ${gpu.avgUtil.toFixed(0)}% / peak ${gpu.peakUtil.toFixed(0)}% (${gpu.samples} samples)`);
        } catch (e) { /* non-fatal */ }
      }
      console.log(`[Worker] ${model} GLB generated at ${glbPath}`);

      // Upload GLB to R2
      await this.updateProgress(job.id, { pct: 95, phase: 'uploading', step: genParams.steps, total: genParams.steps, detail: 'Saving 3D model...' });
      const outputUrl = await this.uploadToR2(glbPath);
      console.log(`[Worker] Uploaded GLB to ${outputUrl}`);

      // Update job as complete
      const completedAt = new Date().toISOString();
      await this.pool.query(
        `UPDATE genshape3d_jobs SET status = 'done', "resultUrl" = $1, "completedAt" = $2, "progressPct" = 100, "progressPhase" = 'Generation complete!', "updatedAt" = NOW() WHERE id = $3`,
        [outputUrl, completedAt, job.id]
      );
      job.status = 'done';
      job.resultUrl = outputUrl;
      job.completedAt = completedAt;
      this.completedJobs.unshift(job);
      this.emit('jobComplete', job);

      // Smart Mesh: generation jobs flagged autoRefine chain straight into
      // the refine pipeline (rebuild + decimate + unwrap + normal/AO bake)
      // so the user gets a game-ready retopologized version automatically.
      if (job.autoRefine) {
        try {
          const target = Math.min(Math.max(parseInt(job.targetFaceCount) || 30000, 2000), 200000);
          await this.pool.query(
            `INSERT INTO genshape3d_refine_jobs
               (id, "userEmail", "sourceJobId", "sourceModelUrl", operations)
             VALUES ($5, $1, $2, $3, $4)`,
            [job.userEmail, job.id, outputUrl, JSON.stringify({
              targetFaces: target, fillHoles: true, smooth: 2, keepFrac: 0.02, rebuild: true,
            }), crypto.randomUUID()]
          );
          console.log(`[Worker] autoRefine: queued Smart Mesh refine for ${job.id.slice(0, 8)} (target ${target})`);
        } catch (e) {
          console.error(`[Worker] autoRefine enqueue failed for ${job.id}:`, e.message);
        }
      }
    } catch (err) {
      console.error(`[Worker] Job ${job.id} failed:`, err && err.stack || err.message);
      const completedAt = new Date().toISOString();
      const errMsg = (err && (err.stack || err.message) || String(err)).slice(0, 4000);
      try {
        const { rows } = await this.pool.query(`SELECT status FROM genshape3d_jobs WHERE id = $1`, [job.id]);
        if (rows[0]?.status === 'cancelled') {
          console.log(`[Worker] Job ${job.id} was cancelled`);
          job.status = 'cancelled';
        } else {
          await this.pool.query(
            `UPDATE genshape3d_jobs SET status = 'failed', "completedAt" = $1, "progressPhase" = 'failed', "errorMessage" = $2, "updatedAt" = NOW() WHERE id = $3`,
            [completedAt, errMsg, job.id]
          );
          job.status = 'failed';
          job.completedAt = completedAt;
          job.error = err.message;
          this.failedJobs.unshift(job);
          this.emit('jobFailed', job, err.message);
        }
      } catch (dbErr) {
        console.error('[Worker] Failed to update job status:', dbErr.message);
      }
    } finally {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      this.activeCount--;
      this.processing = this.activeCount > 0;
      this.currentJob = null;
      this.emit('stateChanged');
    }
  }

  /**
   * Map DB settings to Hunyuan3D parameters.
   *
   * Uses direct numeric columns if set (octreeResolution, targetFaceCount, etc.),
   * otherwise falls back to the label-based columns (polygonBudget, detailLevel).
   */
  buildGenParams(job) {
    // --- Direct numeric overrides (new columns) take priority ---
    let steps, guidance_scale, octree_resolution, target_face_num, num_chunks;

    if (job.octreeResolution > 0) {
      octree_resolution = job.octreeResolution;
    }
    if (job.targetFaceCount > 0) {
      target_face_num = job.targetFaceCount;
    }
    if (job.inferenceSteps > 0) {
      steps = job.inferenceSteps;
    }
    if (job.guidanceScale > 0) {
      guidance_scale = job.guidanceScale;
    }
    if (job.numChunks > 0) {
      num_chunks = job.numChunks;
    }

    // --- Fallback to label-based columns ---
    if (!steps || !guidance_scale) {
      const detailMap = {
        'Standard': { steps: 5,  guidance_scale: 5.0 },
        'Fine':     { steps: 15, guidance_scale: 6.0 },
        'Ultra':    { steps: 30, guidance_scale: 7.5 },
      };
      const detail = detailMap[job.detailLevel] || detailMap['Standard'];
      steps = steps || detail.steps;
      guidance_scale = guidance_scale || detail.guidance_scale;
    }

    if (!octree_resolution || !target_face_num) {
      const polyMap = {
        'Low (10k-50k)':    { octree_resolution: 256,  target_face_num: 30000 },
        'Medium (50k-200k)':{ octree_resolution: 384,  target_face_num: 100000 },
        'High (200k-1M)':   { octree_resolution: 512,  target_face_num: 500000 },
      };
      const poly = polyMap[job.polygonBudget] || polyMap['Low (10k-50k)'];
      octree_resolution = octree_resolution || poly.octree_resolution;
      target_face_num = target_face_num || poly.target_face_num;
    }

    const formatMap = { 'GLB': 'glb', 'OBJ': 'obj', 'FBX': 'glb', 'USDZ': 'glb' };
    const fileType = formatMap[job.exportFormat] || 'glb';
    const doTexture = job.doTexture === true;

    return {
      steps,
      guidance_scale,
      octree_resolution,
      seed: job.seed || 0,
      randomize_seed: true,
      check_box_rembg: true,
      num_chunks: num_chunks || 8000,
      file_type: fileType,
      reduce_face: target_face_num > 0,
      target_face_num,
      export_texture: doTexture,
    };
  }

  /**
   * Start sampling GPU state at 2 s intervals via nvidia-smi. Returns
   * a `stop()` function that resolves with { peakMemMB, avgUtil,
   * peakUtil, samples }. Cheap (~30 ms per call) and runs in the
   * background while the worker is waiting on the python child.
   */
  startGpuSampler() {
    let peakMemMB = 0;
    let utilSum = 0;
    let peakUtil = 0;
    let samples = 0;
    const tick = () => {
      const proc = spawn('nvidia-smi', [
        '--query-gpu=memory.used,utilization.gpu',
        '--format=csv,noheader,nounits',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', () => {
        const line = out.trim().split('\n')[0];
        if (!line) return;
        const [memStr, utilStr] = line.split(',').map(s => s.trim());
        const mem = parseInt(memStr) || 0;
        const util = parseFloat(utilStr) || 0;
        if (mem > peakMemMB) peakMemMB = mem;
        if (util > peakUtil) peakUtil = util;
        utilSum += util;
        samples++;
      });
    };
    const interval = setInterval(tick, 2000);
    tick(); // first sample immediately
    return async () => {
      clearInterval(interval);
      // tiny wait for any in-flight sample to land
      await new Promise(r => setTimeout(r, 100));
      return {
        peakMemMB,
        peakUtil,
        avgUtil: samples > 0 ? utilSum / samples : 0,
        samples,
      };
    };
  }

  async downloadFromR2(imageUrl, tmpDir, baseName = 'input') {
    let key = imageUrl;

    if (imageUrl.startsWith('http')) {
      if (imageUrl.includes(this.config.r2Bucket)) {
        const urlObj = new URL(imageUrl);
        const pathParts = urlObj.pathname.split('/');
        const bucketIdx = pathParts.indexOf(this.config.r2Bucket);
        if (bucketIdx >= 0) {
          key = pathParts.slice(bucketIdx + 1).join('/');
        } else {
          key = pathParts.slice(1).join('/');
        }
      } else {
        const resp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const ext = path.extname(new URL(imageUrl).pathname) || '.png';
        const filePath = path.join(tmpDir, `${baseName}${ext}`);
        fs.writeFileSync(filePath, resp.data);
        return filePath;
      }
    }

    const resp = await this.s3.send(new GetObjectCommand({
      Bucket: this.config.r2Bucket,
      Key: key,
    }));

    const chunks = [];
    for await (const chunk of resp.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const ext = path.extname(key) || '.png';
    const filePath = path.join(tmpDir, `${baseName}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  /**
   * Heuristic: is the subject reasonable for Zero123++ to rotate around?
   * Zero123++ drifts when subjects are EXTREMELY horizontal (sprawled
   * quadrupeds with tail-to-nose stretch >> height). Normal vehicles,
   * ships, characters, kangaroos, figurines all rotate fine — even if
   * slightly wider than tall.
   *
   * We accept anything where height/width >= 0.5 (i.e. only truly
   * sprawled subjects like a lying iguana get filtered out, aspect
   * <0.5). Resolves to true on any error (err toward generating views).
   */
  async isUprightSubject(imagePath) {
    const pythonCmd = process.env.PYTHON_CMD || 'python';
    return new Promise(resolve => {
      const proc = spawn(pythonCmd, ['-c', `
import sys
from PIL import Image
img = Image.open(${JSON.stringify(imagePath)})
if img.mode == 'RGBA':
    bbox = img.split()[3].getbbox()
else:
    bbox = img.convert('L').point(lambda v: 0 if v > 240 else 255).getbbox()
if not bbox:
    print('true|no-bbox')
else:
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    ratio = h / max(w, 1)
    print(('true' if ratio >= 0.5 else 'false') + f'|ratio={ratio:.2f}')
`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', code => {
        const line = out.trim();
        const verdict = line.startsWith('true');
        console.log(`[Worker] upright-subject check: ${verdict ? 'YES' : 'NO'} (${line.split('|')[1] || ''})`);
        resolve(verdict);
      });
      proc.on('error', () => resolve(true));
    });
  }

  /**
   * Spawn the local Zero123++ runner (src/multiview_zero123.py) to
   * generate 3 alt views from the primary image. Uploads each view to
   * R2 so the admin trail (worker tray + webapp) can show them as the
   * thumbnail strip under the input.
   *
   * Returns { localPaths: string[], r2Urls: string[] } — empty arrays
   * on any failure (caller falls back to single-view).
   */
  async generateLocalMultiView(inputImagePath, tmpDir, jobId) {
    const pythonCmd = process.env.PYTHON_CMD || 'python';
    const scriptPath = path.join(__dirname, 'multiview_zero123.py');
    const outDir = path.join(tmpDir, 'mv_views');
    fs.mkdirSync(outDir, { recursive: true });

    await this.updateProgress(jobId, {
      pct: 2, phase: 'multiview', step: 0, total: 0,
      detail: 'Generating alt views (Zero123++)...',
    });

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(pythonCmd, [scriptPath, '--image', inputImagePath, '--output-dir', outDir], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => {
        const text = d.toString();
        stdout += text;
        text.split('\n').filter(Boolean).forEach(line => {
          if (line.startsWith('PROGRESS:')) {
            try {
              const prog = JSON.parse(line.slice(9));
              this.updateProgress(jobId, prog).catch(() => {});
            } catch {}
          } else {
            console.log(`[Zero123++] ${line}`);
          }
        });
      });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code !== 0) return reject(new Error(`Zero123++ exit ${code}: ${stderr.slice(-300)}`));
        const line = stdout.split('\n').find(l => l.startsWith('RESULT:'));
        if (!line) return reject(new Error('Zero123++ produced no RESULT line'));
        try {
          const j = JSON.parse(line.slice(7));
          if (j.status === 'error') return reject(new Error(j.error || 'Zero123++ error'));
          resolve(j.views || {});
        } catch (e) {
          reject(new Error(`Could not parse Zero123++ result: ${e.message}`));
        }
      });
      proc.on('error', err => reject(new Error(`Failed to spawn Zero123++: ${err.message}`)));
    });

    const localPaths = [];
    const r2Urls = [];
    for (const [label, localPath] of Object.entries(result)) {
      if (!localPath || !fs.existsSync(localPath)) continue;
      localPaths.push(localPath);
      try {
        const key = `mv-auto/${jobId}/${label}.png`;
        const buf = fs.readFileSync(localPath);
        await this.s3.send(new PutObjectCommand({
          Bucket: this.config.r2Bucket,
          Key: key,
          Body: buf,
          ContentType: 'image/png',
        }));
        const publicUrl = this.config.r2PublicUrl || `${this.config.r2Endpoint}/${this.config.r2Bucket}`;
        r2Urls.push(`${publicUrl}/${key}`);
      } catch (e) {
        console.warn(`[Worker] Failed to upload generated view ${label}: ${e.message}`);
      }
    }
    return { localPaths, r2Urls };
  }

  /**
   * Pick the python + script + cwd for a given model.
   * Hunyuan3D uses this repo's own generate.py + PYTHON_CMD env var
   * (same as the 1080). Other models use the runner venvs we built
   * under RUNNERS_DIR (defaults to genshape-worker-3090/runners/).
   */
  resolveRunner(model) {
    if (!model || model === 'hunyuan3d') {
      return {
        pythonCmd: process.env.PYTHON_CMD || 'python',
        scriptPath: path.join(__dirname, 'generate.py'),
        cwd: process.env.HUNYUAN3D_DIR || 'F:/ai/hunyuan3d-2',
        env: {
          ...process.env,
          HUNYUAN3D_DIR: process.env.HUNYUAN3D_DIR || 'F:/ai/hunyuan3d-2',
        },
        label: 'Hunyuan3D',
      };
    }
    const runnersDir = process.env.RUNNERS_DIR || 'C:/projects/genshape-worker-3090/runners';
    return {
      pythonCmd: path.join(runnersDir, model, '.venv', 'Scripts', 'python.exe'),
      scriptPath: path.join(runnersDir, model, 'run.py'),
      cwd: path.join(runnersDir, model),
      env: { ...process.env },
      label: model,
    };
  }

  /**
   * Call the appropriate model runner via Python subprocess.
   * Same protocol as generate.py: PROGRESS:{...json...} on each step,
   * RESULT:{status, output_path, ...} at end.
   */
  /**
   * Hang watchdog for runner subprocesses.
   *
   * Why: a VRAM-exhausted CUDA process on Windows doesn't crash — WDDM spills
   * to system RAM and the job "runs" at 99% GPU for hours with zero output
   * (two 12h-stuck jobs cost a full night of generation). Progress lines are
   * sparse during long steps, so liveness = ANY stdout/stderr output.
   *
   * Kills the process tree when EITHER:
   *   - no output at all for STALL_TIMEOUT_MS   (default 15 min), or
   *   - total runtime exceeds JOB_TIMEOUT_MS    (default 60 min).
   * Both env-tunable. Killing makes proc 'close' with a signal → the normal
   * failure path marks the job failed and frees the slot for the next job.
   *
   * Returns { touch, stop, killedWhy } — call touch() on every output chunk,
   * stop() once the process closes; killedWhy() is set if we pulled the plug.
   */
  attachWatchdog(proc, label) {
    const STALL_MS = parseInt(process.env.RUNNER_STALL_TIMEOUT_MS || String(15 * 60 * 1000), 10);
    const HARD_MS  = parseInt(process.env.RUNNER_JOB_TIMEOUT_MS   || String(60 * 60 * 1000), 10);
    const startedAt = Date.now();
    let lastOutputAt = Date.now();
    let killedWhy = null;

    const killTree = (why) => {
      killedWhy = why;
      console.error(`[Watchdog] ${label} ${why} — killing PID ${proc.pid}`);
      try {
        if (process.platform === 'win32') {
          // taskkill /T takes the whole tree (python may have spawned children)
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        console.error(`[Watchdog] kill failed: ${e.message}`);
      }
    };

    const timer = setInterval(() => {
      const now = Date.now();
      if (now - startedAt > HARD_MS) {
        killTree(`exceeded hard timeout (${Math.round(HARD_MS / 60000)} min)`);
        clearInterval(timer);
      } else if (now - lastOutputAt > STALL_MS) {
        killTree(`no output for ${Math.round(STALL_MS / 60000)} min (hung — likely VRAM thrash)`);
        clearInterval(timer);
      }
    }, 30 * 1000);

    return {
      touch: () => { lastOutputAt = Date.now(); },
      stop: () => clearInterval(timer),
      killedWhy: () => killedWhy,
    };
  }

  async callRunner(model, inputImagePath, tmpDir, genParams, auxImagePaths = [], job = null) {
    const ext = genParams.file_type || 'glb';
    const outputPath = path.join(tmpDir, `output.${ext}`);
    const { pythonCmd, scriptPath, cwd, env, label } = this.resolveRunner(model);

    const args = [
      scriptPath,
      '--image', inputImagePath,
      '--output', outputPath,
      '--steps', String(genParams.steps),
      '--guidance-scale', String(genParams.guidance_scale),
      '--octree-resolution', String(genParams.octree_resolution),
      '--seed', String(genParams.seed),
      '--num-chunks', String(genParams.num_chunks),
      '--target-face-count', String(genParams.target_face_num),
      '--export-format', ext,
      '--remove-bg',
    ];

    if (genParams.export_texture) {
      args.push('--do-texture');
    }

    // Pass auxiliary view images. Runners that support multi-view (currently
    // only generate.py for hunyuan3d) consume them; the others ignore the
    // flag because their argparse accepts the spec but uses only the primary.
    if (Array.isArray(auxImagePaths) && auxImagePaths.length > 0) {
      args.push('--aux-images', ...auxImagePaths);
    }

    console.log(`[Worker] Spawning ${label}: ${pythonCmd} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(pythonCmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.currentProc = proc;
      const watchdog = this.attachWatchdog(proc, label);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        watchdog.touch();
        const text = data.toString();
        stdout += text;
        text.split('\n').filter(Boolean).forEach(line => {
          if (line.startsWith('PROGRESS:')) {
            try {
              const progress = JSON.parse(line.slice(9));
              // Attribute progress to THIS runner's job. With MAX_CONCURRENT>1,
              // this.currentJob is whichever job was claimed last — writing to
              // it here would corrupt the other running job's progress.
              const owner = job || this.currentJob;
              if (owner) {
                owner.progress = progress;
                // Write progress to DB for the web frontend
                this.updateProgress(owner.id, progress);
                this.emit('progressUpdate', progress);
                this.emit('stateChanged');
              }
            } catch {}
          } else {
            console.log(`[Hunyuan3D] ${line}`);
          }
        });
      });

      proc.stderr.on('data', (data) => {
        watchdog.touch();
        const text = data.toString();
        stderr += text;
        text.split('\n').filter(Boolean).forEach(line => {
          console.error(`[${label} ERR] ${line}`);
        });
      });

      proc.on('close', (code) => {
        this.currentProc = null;
        watchdog.stop();
        if (watchdog.killedWhy()) {
          return reject(new Error(`${label} killed by watchdog: ${watchdog.killedWhy()}`));
        }
        if (code !== 0) {
          return reject(new Error(`${label} process exited with code ${code}: ${stderr.slice(-500)}`));
        }

        const resultLine = stdout.split('\n').find(l => l.startsWith('RESULT:'));
        if (resultLine) {
          try {
            const result = JSON.parse(resultLine.slice(7));
            if (result.status === 'error') {
              return reject(new Error(`${label} error: ${result.error}`));
            }
            const finalPath = result.output_path || outputPath;
            if (!fs.existsSync(finalPath)) {
              return reject(new Error(`Output file not found: ${finalPath}`));
            }
            console.log(`[Worker] ${label} done: ${result.vertices || '?'} verts, ${result.faces || '?'} faces, ${result.total_time || '?'}s`);
            return resolve(finalPath);
          } catch (e) {
            return reject(new Error(`Failed to parse ${label} result: ${e.message}`));
          }
        }

        if (fs.existsSync(outputPath)) {
          return resolve(outputPath);
        }

        reject(new Error(`${label} produced no output. stdout: ${stdout.slice(-300)}`));
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn ${label} process: ${err.message}`));
      });
    });
  }

  /**
   * Process a texture-only job from genshape3d_texture_jobs.
   * Downloads the source GLB + reference image, runs hunyuan3d-2-1 in
   * --texture-only mode, uploads the result, and marks the job done.
   */
  async processTextureJob(job) {
    this.activeCount++;
    let tmpDir;
    try {
      // Atomic claim — bail if another worker beat us to it
      const claim = await this.pool.query(
        `UPDATE genshape3d_texture_jobs
            SET status='processing', "startedAt"=NOW(), "assignedWorkerId"=$1,
                "updatedAt"=NOW(), "progressPct"=0, "progressPhase"='Preparing...'
          WHERE id=$2 AND status='pending'`,
        [this.workerId, job.id],
      );
      if (claim.rowCount === 0) {
        console.log(`[TextureWorker] Job ${job.id.slice(0, 8)} already claimed, skipping.`);
        this.activeCount--;
        return;
      }

      const updateTexProgress = async (pct, phase) => {
        try {
          await this.pool.query(
            `UPDATE genshape3d_texture_jobs
                SET "progressPct"=$1, "progressPhase"=$2, "updatedAt"=NOW()
              WHERE id=$3`,
            [pct, phase, job.id],
          );
        } catch { /* non-fatal */ }
      };

      tmpDir = path.join(os.tmpdir(), `genshape3d-tex-${job.id}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      // ── Download source mesh ───────────────────────────────────────────
      await updateTexProgress(0, 'Downloading mesh...');
      const meshPath = await this.downloadFromR2(job.sourceModelUrl, tmpDir, 'source_mesh');
      console.log(`[TextureWorker] Downloaded mesh → ${meshPath}`);

      // When texturing a refined derivative, also fetch the lineage's v1
      // original as bake_source.glb — the runner bakes a tangent-space
      // normal map from it so the painted low-poly keeps the original's
      // surface detail. Non-fatal if anything here fails.
      try {
        const { rows: srcJob } = await this.pool.query(
          `SELECT model, "rootJobId" FROM genshape3d_jobs WHERE id=$1`, [job.sourceJobId],
        );
        if (srcJob[0]?.model === 'refine' && srcJob[0].rootJobId) {
          const { rows: orig } = await this.pool.query(
            `SELECT "resultUrl" FROM genshape3d_jobs
             WHERE "rootJobId"=$1 AND version=1 AND "resultUrl" <> '' LIMIT 1`,
            [srcJob[0].rootJobId],
          );
          if (orig[0]?.resultUrl) {
            await this.downloadFromR2(orig[0].resultUrl, tmpDir, 'bake_source');
            console.log(`[TextureWorker] Downloaded lineage v1 as normal-bake source.`);
          }
        }
      } catch (e) {
        console.warn(`[TextureWorker] bake-source fetch skipped: ${e.message}`);
      }

      // ── Download reference image ───────────────────────────────────────
      let imagePath = null;
      if (job.sourceImageUrl) {
        await updateTexProgress(5, 'Downloading reference image...');
        imagePath = await this.downloadFromR2(job.sourceImageUrl, tmpDir, 'ref_image');
        console.log(`[TextureWorker] Downloaded ref image → ${imagePath}`);
      }

      // ── Resolve runner ─────────────────────────────────────────────────
      const runnersDir = process.env.RUNNERS_DIR || 'C:/projects/genshape-worker-3090/runners';
      const model = 'hunyuan3d-2-1';
      const pythonCmd = path.join(runnersDir, model, '.venv', 'Scripts', 'python.exe');
      const scriptPath = path.join(runnersDir, model, 'run.py');
      const cwd = path.join(runnersDir, model);
      const outputPath = path.join(tmpDir, 'textured_output.glb');

      const args = [
        scriptPath,
        '--texture-only',
        '--source-mesh', meshPath,
        '--output', outputPath,
      ];
      if (imagePath) {
        args.push('--image', imagePath);
      }

      await updateTexProgress(10, 'Loading paint pipeline...');
      console.log(`[TextureWorker] Spawning: ${pythonCmd} ${args.slice(1).join(' ')}`);

      // ── Run paint pipeline ─────────────────────────────────────────────
      const stopGpu = this.startGpuSampler();
      let glbPath;
      try {
        glbPath = await new Promise((resolve, reject) => {
          const proc = spawn(pythonCmd, args, {
            cwd,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const watchdog = this.attachWatchdog(proc, 'Hunyuan3DPaint');
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', data => {
            watchdog.touch();
            const text = data.toString();
            stdout += text;
            text.split('\n').filter(Boolean).forEach(line => {
              if (line.startsWith('PROGRESS:')) {
                try {
                  const p = JSON.parse(line.slice(9));
                  updateTexProgress(p.pct || 0, p.detail || p.phase || '').catch(() => {});
                } catch { /* ignore */ }
              } else {
                console.log(`[Hunyuan3DPaint] ${line}`);
              }
            });
          });
          proc.stderr.on('data', data => {
            watchdog.touch();
            stderr += data.toString();
            data.toString().split('\n').filter(Boolean).forEach(l =>
              console.error(`[Hunyuan3DPaint ERR] ${l}`),
            );
          });
          proc.on('close', code => {
            watchdog.stop();
            if (watchdog.killedWhy()) {
              return reject(new Error(`Paint killed by watchdog: ${watchdog.killedWhy()}`));
            }
            if (code !== 0) {
              return reject(new Error(`Paint process exited with code ${code}: ${stderr.slice(-500)}`));
            }
            const resultLine = stdout.split('\n').find(l => l.startsWith('RESULT:'));
            if (resultLine) {
              try {
                const result = JSON.parse(resultLine.slice(7));
                if (result.status === 'error') return reject(new Error(`Paint error: ${result.error}`));
                const finalPath = result.output_path || outputPath;
                if (!fs.existsSync(finalPath)) return reject(new Error(`Output not found: ${finalPath}`));
                console.log(`[TextureWorker] Paint done in ${result.texture_time || result.total_time || '?'}s`);
                return resolve(finalPath);
              } catch (e) {
                return reject(new Error(`Failed to parse paint result: ${e.message}`));
              }
            }
            if (fs.existsSync(outputPath)) return resolve(outputPath);
            reject(new Error(`Paint produced no output. stdout: ${stdout.slice(-300)}`));
          });
          proc.on('error', err => reject(new Error(`Failed to spawn paint process: ${err.message}`)));
        });
      } finally {
        await stopGpu();
      }

      // ── Upload result ──────────────────────────────────────────────────
      await updateTexProgress(95, 'Uploading textured model...');
      const resultUrl = await this.uploadToR2(glbPath);
      console.log(`[TextureWorker] Uploaded → ${resultUrl}`);

      const completedAt = new Date().toISOString();
      await this.pool.query(
        `UPDATE genshape3d_texture_jobs
            SET status='done', "resultUrl"=$1, "completedAt"=$2,
                "progressPct"=100, "progressPhase"='Texturing complete!', "updatedAt"=NOW()
          WHERE id=$3`,
        [resultUrl, completedAt, job.id],
      );
      console.log(`[TextureWorker] Job ${job.id.slice(0, 8)} complete ✓`);

    } catch (err) {
      console.error(`[TextureWorker] Job ${job.id} failed:`, err.stack || err.message);
      try {
        await this.pool.query(
          `UPDATE genshape3d_texture_jobs
              SET status='failed', "completedAt"=NOW(), "progressPhase"='failed',
                  "errorMessage"=$1, "updatedAt"=NOW()
            WHERE id=$2`,
          [(err.message || '').slice(0, 4000), job.id],
        );
      } catch { /* non-fatal */ }
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      this.activeCount--;
      this.processing = this.activeCount > 0;
      this.emit('stateChanged');
    }
  }

  /**
   * Process a mesh refine job from genshape3d_refine_jobs. Downloads the
   * source GLB, runs refine.py (weld / floaters / holes / normals /
   * optional decimate) in the hunyuan3d-2-1 venv, uploads the result, and
   * inserts a NEW genshape3d_jobs row so the clean mesh appears as a
   * normal derivative asset. The source job is never touched.
   */
  async processRefineJob(job) {
    this.activeCount++;
    let tmpDir;
    try {
      const claim = await this.pool.query(
        `UPDATE genshape3d_refine_jobs
            SET status='processing', "startedAt"=NOW(), "assignedWorkerId"=$1,
                "updatedAt"=NOW(), "progressPct"=0, "progressPhase"='Preparing...'
          WHERE id=$2 AND status='pending'`,
        [this.workerId, job.id],
      );
      if (claim.rowCount === 0) {
        console.log(`[RefineWorker] Job ${job.id.slice(0, 8)} already claimed, skipping.`);
        this.activeCount--;
        return;
      }

      const updateProgress = async (pct, phase) => {
        try {
          await this.pool.query(
            `UPDATE genshape3d_refine_jobs
                SET "progressPct"=$1, "progressPhase"=$2, "updatedAt"=NOW() WHERE id=$3`,
            [pct, phase, job.id],
          );
        } catch { /* non-fatal */ }
      };

      tmpDir = path.join(os.tmpdir(), `genshape3d-refine-${job.id}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      await updateProgress(2, 'Downloading mesh...');
      const meshPath = await this.downloadFromR2(job.sourceModelUrl, tmpDir, 'source_mesh');

      const ops = typeof job.operations === 'string' ? JSON.parse(job.operations) : (job.operations || {});
      const runnersDir = process.env.RUNNERS_DIR || 'C:/projects/genshape-worker-3090/runners';
      const runnerDir = path.join(runnersDir, 'hunyuan3d-2-1');
      const pythonCmd = path.join(runnerDir, '.venv', 'Scripts', 'python.exe');
      const outputPath = path.join(tmpDir, 'refined.glb');

      const args = [
        path.join(runnerDir, 'refine.py'),
        '--input', meshPath,
        '--output', outputPath,
        '--target-faces', String(ops.targetFaces || 0),
        '--keep-frac', String(ops.keepFrac || 0.02),
        '--smooth', String(ops.smooth || 0),
      ];
      if (ops.fillHoles === false) args.push('--no-fill-holes');
      if (ops.rebuild === true) args.push('--rebuild');

      console.log(`[RefineWorker] Spawning: ${pythonCmd} ${args.slice(1).join(' ')}`);
      let stats = {};
      await new Promise((resolve, reject) => {
        const proc = spawn(pythonCmd, args, {
          cwd: runnerDir,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const watchdog = this.attachWatchdog(proc, 'Refine');
        let stdout = '', stderr = '';
        proc.stdout.on('data', data => {
          watchdog.touch();
          const text = data.toString();
          stdout += text;
          text.split('\n').filter(Boolean).forEach(line => {
            if (line.startsWith('PROGRESS:')) {
              try {
                const p = JSON.parse(line.slice(9));
                updateProgress(p.pct || 0, p.detail || p.phase || '').catch(() => {});
              } catch { /* ignore */ }
            } else if (!line.startsWith('RESULT:')) {
              console.log(`[Refine] ${line}`);
            }
          });
        });
        proc.stderr.on('data', data => {
          watchdog.touch();
          stderr += data.toString();
        });
        proc.on('close', code => {
          watchdog.stop();
          if (watchdog.killedWhy()) return reject(new Error(`Refine killed by watchdog: ${watchdog.killedWhy()}`));
          if (code !== 0) return reject(new Error(`Refine exited ${code}: ${stderr.slice(-400)}`));
          const resultLine = stdout.split('\n').find(l => l.startsWith('RESULT:'));
          if (resultLine) {
            try { stats = JSON.parse(resultLine.slice(7)); } catch { /* keep {} */ }
          }
          if (!fs.existsSync(outputPath)) return reject(new Error('Refine produced no output file'));
          resolve();
        });
        proc.on('error', err => reject(new Error(`Failed to spawn refine: ${err.message}`)));
      });

      await updateProgress(95, 'Uploading refined mesh...');
      const resultUrl = await this.uploadToR2(outputPath);

      // Insert the derivative as a new VERSION of the source's lineage —
      // same asset identity (rootJobId), same name, incremented version.
      // model 'refine' marks provenance and keeps it out of GPU routing.
      const { rows: srcRows } = await this.pool.query(
        `SELECT name, "imageUrl", "userEmail", "rootJobId" FROM genshape3d_jobs WHERE id=$1`,
        [job.sourceJobId],
      );
      const src = srcRows[0] || {};
      const rootJobId = src.rootJobId || job.sourceJobId;
      const { rows: verRows } = await this.pool.query(
        `SELECT COALESCE(MAX(version), 1) + 1 AS next FROM genshape3d_jobs WHERE "rootJobId" = $1`,
        [rootJobId],
      );
      const nextVersion = verRows[0]?.next || 2;
      const ops2 = typeof job.operations === 'string' ? JSON.parse(job.operations) : (job.operations || {});
      const faceNote = stats.faces_out ? ` ${Math.round(stats.faces_out / 1000)}k` : '';
      const versionLabel = `${ops2.rebuild ? 'rebuilt' : 'refined'}${faceNote}`;
      const newJobId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      await this.pool.query(
        `INSERT INTO genshape3d_jobs
           (id, "userEmail", "imageUrl", name, prompt, style, status, "resultUrl",
            "createdAt", "updatedAt", "startedAt", "completedAt",
            model, "assignedWorkerId", "doTexture", "progressPct", "progressPhase",
            "rootJobId", version, "versionLabel")
         VALUES ($1, $2, $3, $4, $5, 'Realistic', 'done', $6, $7, $7, NOW(), NOW(),
                 'refine', $8, false, 100, 'done', $9, $10, $11)`,
        [
          newJobId,
          job.userEmail,
          src.imageUrl || '',
          (src.name || 'Asset').slice(0, 60),
          `Refined mesh (weld, floaters, holes, normals${(stats.faces_out && stats.faces_in && stats.faces_out < stats.faces_in) ? `, ${stats.faces_in}→${stats.faces_out} faces` : ''})`,
          resultUrl,
          nowIso,
          this.workerId,
          rootJobId,
          nextVersion,
          versionLabel,
        ],
      );

      await this.pool.query(
        `UPDATE genshape3d_refine_jobs
            SET status='done', "resultUrl"=$1, "resultJobId"=$2, stats=$3,
                "progressPct"=100, "progressPhase"='Refine complete!',
                "completedAt"=NOW(), "updatedAt"=NOW()
          WHERE id=$4`,
        [resultUrl, newJobId, JSON.stringify(stats), job.id],
      );
      console.log(`[RefineWorker] Job ${job.id.slice(0, 8)} complete -> asset ${newJobId.slice(0, 8)} (${stats.faces_in}->${stats.faces_out} faces, ${stats.floaters_removed} floaters removed)`);

    } catch (err) {
      console.error(`[RefineWorker] Job ${job.id} failed:`, err.stack || err.message);
      try {
        await this.pool.query(
          `UPDATE genshape3d_refine_jobs
              SET status='failed', "completedAt"=NOW(), "progressPhase"='failed',
                  "errorMessage"=$1, "updatedAt"=NOW()
            WHERE id=$2`,
          [(err.message || '').slice(0, 4000), job.id],
        );
      } catch { /* non-fatal */ }
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      this.activeCount--;
      this.processing = this.activeCount > 0;
      this.emit('stateChanged');
    }
  }

  async uploadToR2(filePath) {
    const buffer = fs.readFileSync(filePath);
    const key = `outputs/${Date.now()}-${crypto.randomUUID()}.glb`;

    await this.s3.send(new PutObjectCommand({
      Bucket: this.config.r2Bucket,
      Key: key,
      Body: buffer,
      ContentType: 'model/gltf-binary',
    }));

    const publicUrl = this.config.r2PublicUrl || `${this.config.r2Endpoint}/${this.config.r2Bucket}`;
    return `${publicUrl}/${key}`;
  }
}

module.exports = { Worker };

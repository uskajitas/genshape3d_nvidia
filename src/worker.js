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
    const isLocal = /@(localhost|127\.0\.0\.1)/.test(config.databaseUrl || '');
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    this.pool.on('error', (err) => {
      console.error('[Worker] Pool error (will reconnect):', err.message);
    });
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
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.config.pollInterval);
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
      this.pendingJobs = [];

      // ── Processing — only this machine's ──────────────────────
      const { rows: processing } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'processing' AND "assignedWorkerId" = $1 ORDER BY "startedAt" ASC`,
        [this.workerId]
      );
      this.processingJobs = processing;

      // ── Cancelled — only this machine's ───────────────────────
      const { rows: cancelled } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'cancelled' AND "assignedWorkerId" = $1 ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      this.cancelledJobs = cancelled;

      // ── Completed (done) — only this machine's ────────────────
      // Sourced from the DB so history survives worker restarts. The
      // in-memory unshift on jobComplete still happens but is now a
      // best-effort cache, not the source of truth.
      const { rows: completed } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'done' AND "assignedWorkerId" = $1 ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      this.completedJobs = completed;

      // ── Failed — only this machine's ──────────────────────────
      const { rows: failed } = await this.pool.query(
        `SELECT * FROM genshape3d_jobs WHERE status = 'failed' AND "assignedWorkerId" = $1 ORDER BY "completedAt" DESC LIMIT 20`,
        [this.workerId]
      );
      this.failedJobs = failed;

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
          // VRAM safety guard: two textured Hunyuan3D jobs together OOM
          // a 24 GB card (each is ~6 GB shape + ~6 GB paint, and 2.1's PBR
          // paint is heavier still). Hold the pending one until the running
          // one finishes.
          const isTexHun = (j) => {
            const m = (j.model || 'hunyuan3d').toLowerCase();
            return (m === 'hunyuan3d' || m === 'hunyuan3d-2-1') && j.doTexture;
          };
          const oomRisk = isTexHun(nextJob) && this.processingJobs.some(isTexHun);
          if (oomRisk) {
            console.log(`[Worker] holding ${nextJob.id.slice(0,8)} — another textured-Hunyuan3D job is already running (would OOM).`);
          } else {
            this.processJob(nextJob);
          }
        }
      }
    } catch (err) {
      console.error('[Worker] Poll error:', err.message);
      console.error(err.stack);
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
        glbPath = await this.callRunner(model, inputImagePath, tmpDir, genParams, auxImagePaths);
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
  async callRunner(model, inputImagePath, tmpDir, genParams, auxImagePaths = []) {
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

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        text.split('\n').filter(Boolean).forEach(line => {
          if (line.startsWith('PROGRESS:')) {
            try {
              const progress = JSON.parse(line.slice(9));
              if (this.currentJob) {
                this.currentJob.progress = progress;
                // Write progress to DB for the web frontend
                this.updateProgress(this.currentJob.id, progress);
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
        const text = data.toString();
        stderr += text;
        text.split('\n').filter(Boolean).forEach(line => {
          console.error(`[${label} ERR] ${line}`);
        });
      });

      proc.on('close', (code) => {
        this.currentProc = null;
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

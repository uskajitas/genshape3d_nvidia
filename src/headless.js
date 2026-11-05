// The 3D worker with no window and no tray: one process that pm2 keeps up as `ugpu-3d` (see
// ugpu/ecosystem.config.cjs). On the 3090 the screen for everything on the card is ugpu's, at
// http://127.0.0.1:8460, so this only does the work: it takes 3D jobs from the database, asks ugpu for
// its turn and runs them.
//   node src/headless.js
const path = require('path');
// .env first: worker.js reads WORKER_ID when it is required.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');

// The same worker.log as before, so nothing that reads it changes. Rotates at 5 MB.
const logPath = path.join(__dirname, '..', 'worker.log');
try {
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, logPath + '.1');
} catch { /* another process holds it: keep writing to the same file */ }
const log = fs.createWriteStream(logPath, { flags: 'a' });
const ts = () => new Date().toISOString();
console.log = (...a) => log.write(`[${ts()}] ${a.join(' ')}\n`);
console.warn = (...a) => log.write(`[${ts()}] WARN ${a.join(' ')}\n`);
console.error = (...a) => log.write(`[${ts()}] ERROR ${a.join(' ')}\n`);
process.on('uncaughtException', (e) => { if (e?.code === 'EPIPE') return; console.error('uncaughtException:', (e && e.stack) || e); });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', (e && e.stack) || e); });

// No window, ever. pm2 starts this process with no console, and Windows gives a console program
// started from such a process a console window of its own: every runner, and the card reading every
// two seconds, would open one on the desktop, and closing it kills the job. So every process the
// worker starts is started hidden. This is set before worker.js takes its copy of spawn.
const childProcess = require('child_process');
for (const name of ['spawn', 'execFile']) {
  const start = childProcess[name];
  childProcess[name] = function (...args) {
    const at = args.findIndex((x, i) => i > 0 && x && typeof x === 'object' && !Array.isArray(x));
    if (at >= 0) args[at] = { windowsHide: true, ...args[at] };
    else {
      const callback = args.findIndex((x) => typeof x === 'function');
      args.splice(callback >= 0 ? callback : args.length, 0, { windowsHide: true });
    }
    return start.apply(this, args);
  };
}

const { Worker } = require('./worker');

const worker = new Worker({
  databaseUrl: process.env.DATABASE_URL,
  r2Endpoint: process.env.R2_ENDPOINT || 'https://edad30fa0fe66f50971087c6b0df0f28.r2.cloudflarestorage.com',
  r2AccessKey: process.env.R2_ACCESS_KEY_ID || '',
  r2SecretKey: process.env.R2_SECRET_ACCESS_KEY || '',
  r2Bucket: process.env.R2_BUCKET || 'genshape3d',
  r2PublicUrl: process.env.R2_PUBLIC_URL || '',
  pollInterval: parseInt(process.env.POLL_INTERVAL || '10000', 10),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '1', 10),
  models: (process.env.WORKER_MODELS || 'hunyuan3d').split(',').map((s) => s.trim()).filter(Boolean),
});

worker.on('jobFailed', (job, error) => console.error(`[headless] ${job?.name || job?.id} failed: ${error?.message || error}`));
console.log(`[headless] 3D worker started with no window, WORKER_ID=${process.env.WORKER_ID}, logging to ${logPath}`);
worker.start();

// pm2 stop or restart: the running job's process is not left behind.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { worker.stop(); } catch { /* already stopping */ }
    setTimeout(() => process.exit(0), 500);
  });
}

#!/usr/bin/env node
// BATCH: many pictures in, one 3D job each, queued for the worker on this machine.
//
//   node batch.js <name> --prompts prompts.txt [--gen flux-schnell|qwen-image] [--size 768] [--variants 1] [--seed 1000]
//   node batch.js <name> --folder C:\pictures
//   node batch.js --status <name>
//
// 3D options (all optional): --model trellis2  --tex 1K  --no-texture
//
// prompts.txt: one picture prompt per line; blank lines and lines starting with # are skipped.
// Pictures made from prompts come from the image generator on this machine (port 8430). Every picture
// is kept in G:\projects_support\batches\<name>\ with a manifest.json that says how it was made
// (prompt, generator, size, seed, time). The worker then takes the jobs one at a time, as it does
// for jobs made in the app; they carry the tag batch:<name>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = (n) => args.includes('--' + n);

const IMAGE_GEN = process.env.IMAGE_GEN_URL || 'http://127.0.0.1:8430';
const PUBLIC = (process.env.R2_ASSETS_URL || 'https://assets.genshape3d.com').replace(/\/$/, '');
const OUT = process.env.BATCH_DIR || 'G:\\projects_support\\batches';
const EMAIL = process.env.BATCH_EMAIL || 'uskajitas@gmail.com';

const db = () => new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });

async function status(name) {
  const c = db();
  await c.connect();
  const r = await c.query(
    `SELECT status, count(*)::int n, round(avg("progressPct"))::int pct FROM genshape3d_jobs WHERE $1 = ANY(tags) GROUP BY 1 ORDER BY 1`,
    ['batch:' + name],
  );
  const total = r.rows.reduce((a, x) => a + x.n, 0);
  const done = r.rows.filter((x) => x.status === 'done').reduce((a, x) => a + x.n, 0);
  console.log(`batch ${name}: ${done} of ${total} done`);
  for (const x of r.rows) console.log(`  ${x.status}: ${x.n}`);
  const names = await c.query(
    `SELECT name, status, "progressPct" p, "resultUrl" FROM genshape3d_jobs WHERE $1 = ANY(tags) ORDER BY name`,
    ['batch:' + name],
  );
  for (const j of names.rows) console.log(`  ${j.name.padEnd(24)} ${j.status.padEnd(11)} ${j.status === 'processing' ? j.p + '%' : ''}`);
  await c.end();
}

async function paint(prompt, gen, size, seed) {
  const r = await fetch(IMAGE_GEN + '/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, model: gen, width: size, height: size, seed }),
    signal: AbortSignal.timeout(20 * 60_000),
  });
  const j = await r.json();
  if (!r.ok || !j.image) throw new Error(`image generator: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return { buf: Buffer.from(j.image.split(',')[1], 'base64'), ms: j.ms, model: j.model };
}

async function main() {
  if (has('status')) return status(flag('status'));
  const name = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
  if (!name || (!has('prompts') && !has('folder'))) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(1);
  }
  const gen = flag('gen', 'flux-schnell');
  const size = Number(flag('size', gen === 'qwen-image' ? 1024 : 768));
  const variants = Math.max(1, Number(flag('variants', 1)));
  const seed0 = Number(flag('seed', Math.floor(Math.random() * 1e6)));
  const model = flag('model', 'trellis2');
  const tex = flag('tex', '1K');
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });

  // 1. the pictures: made from prompts, or taken from a folder
  const items = [];
  if (has('prompts')) {
    const lines = fs.readFileSync(flag('prompts'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    let n = 0;
    for (const prompt of lines)
      for (let v = 0; v < variants; v++) {
        n++;
        const seed = seed0 + n;
        process.stdout.write(`picture ${n}/${lines.length * variants}: ${prompt.slice(0, 60)}… `);
        const p = await paint(prompt, gen, size, seed);
        const file = path.join(dir, String(n).padStart(2, '0') + '.jpg');
        fs.writeFileSync(file, p.buf);
        console.log(`${Math.round(p.ms / 1000)} s`);
        items.push({ file, prompt, how: { generator: gen, generatorName: p.model, size, seed, ms: p.ms, at: new Date().toISOString() } });
      }
  } else {
    const files = fs.readdirSync(flag('folder')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
    for (const f of files) items.push({ file: path.join(flag('folder'), f), prompt: '', how: { generator: 'supplied picture' } });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, model, tex, items: items.map((i) => ({ ...i, file: path.basename(i.file) })) }, null, 2));

  // 2. upload each picture, queue one job each
  const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT || 'https://edad30fa0fe66f50971087c6b0df0f28.r2.cloudflarestorage.com',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  const c = db();
  await c.connect();
  const ids = [];
  for (const [i, it] of items.entries()) {
    const ext = path.extname(it.file).toLowerCase().replace('.jpeg', '.jpg') || '.jpg';
    const key = `uploads/${Date.now()}-${crypto.randomUUID()}${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET || 'genshape3d',
      Key: key,
      Body: fs.readFileSync(it.file),
      ContentType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
    }));
    const url = `${PUBLIC}/${key}`;
    const id = crypto.randomUUID();
    const tags = [`batch:${name}`, `how:${it.how.generator}`, ...(it.how.seed != null ? [`seed:${it.how.seed}`] : [])];
    await c.query(
      `INSERT INTO genshape3d_jobs (id, "userEmail", "imageUrl", prompt, style, status, "polygonBudget", "textureRes", "exportFormat",
         "detailLevel", "doTexture", "octreeResolution", "targetFaceCount", "inferenceSteps", "guidanceScale", name, model,
         "preferredWorkerId", tags, source, "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,'Realistic','pending','Medium (50k-200k)',$5,'GLB','Standard',$6,512,2000000,20,7,$7,$8,'win-3090',$9,'batch',NOW(),NOW())`,
      [id, EMAIL, url, it.prompt, tex, !has('no-texture'), `${name}_${String(i + 1).padStart(2, '0')}`, model, tags],
    );
    ids.push(id);
    console.log(`queued ${name}_${String(i + 1).padStart(2, '0')}  ${url.split('/').pop()}`);
  }
  await c.end();
  console.log(`\n${ids.length} jobs queued. The worker takes them one at a time.\nProgress: node batch.js --status ${name}\nPictures and how each was made: ${dir}`);
}

main().catch((e) => { console.error('FAULT', e.message); process.exit(1); });

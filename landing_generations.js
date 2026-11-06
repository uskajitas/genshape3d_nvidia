#!/usr/bin/env node
// Landing page generations: one picture from each prompt (Qwen-Image on this machine), then one 3D job
// each in the workspace "landingpage", the same settings as the ones already there (Trellis 2, 2K
// texture, 200,000 faces). ugpu queues everything; the worker takes the 3D jobs one at a time.
//   node landing_generations.js            queues every subject below that is not in the workspace yet
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const IMAGE_GEN = process.env.IMAGE_GEN_URL || 'http://127.0.0.1:8430';
const PUBLIC = (process.env.R2_ASSETS_URL || 'https://assets.genshape3d.com').replace(/\/$/, '');
const EMAIL = 'usquiano@gmail.com';
const SOURCE = 'ws-landingpage';
const FRAME = 'one single isolated object, whole object in frame, centered, three quarter view, plain light grey background, soft studio lighting, 3d render';

const SUBJECTS = [
  ['Hot air balloon', 'a chunky toy hot air balloon with red and yellow stripes, a thick wicker basket and four thick ropes, resting on a small round base'],
  ['Arcade cabinet', 'a retro arcade cabinet in deep blue with a glowing screen, a red joystick, two big round buttons and yellow side stripes'],
  ['Robot dog', 'a friendly chunky robot dog in white and orange with round blue eyes, a short antenna tail and thick legs, standing'],
  ['Vintage scooter', 'a chunky vintage scooter in mint green with a cream seat, a round headlight and thick white wall tires'],
  ['Treehouse', 'a cozy wooden treehouse on a short thick tree trunk with a round leafy top, a small ladder, a red roof and a round window'],
  ['Gumball machine', 'a classic red gumball machine with a round glass globe full of colorful gumballs, a chrome coin slot and a sturdy red base'],
  ['Tiki totem', 'a carved wooden tiki totem with three stacked faces painted in turquoise, orange and yellow, on a round stone base'],
  ['Snow globe cabin', 'a snow globe with a tiny log cabin and two pine trees inside, on a thick dark wooden base with a brass plate'],
  ['Pirate parrot', 'a cute chubby parrot with red, blue and yellow feathers wearing a tiny black pirate hat and an eye patch, standing on a small barrel'],
  ['Dragon egg nest', 'a large teal dragon egg with golden scales resting in a thick nest of dark twigs with two small glowing crystals'],
  ['Planet set', 'a desk model of three stylized planets on one round dark base: a big orange ringed gas giant with a thick solid ring, a blue and green earth-like planet and a small grey cratered moon, each on a short thick stand'],
  ['Space cruiser', 'a chunky sci-fi space cruiser with a white and orange hull, a glass cockpit dome, two big round engines glowing blue and short thick wings'],
  ['City block', 'a small city block diorama on a square base with five colorful stylized buildings of different heights, a glass skyscraper, an apartment tower with balconies, a corner shop with an awning and a small park with two round trees'],
  ['Car engine', 'a detailed V8 car engine block with chrome valve covers, a red intake manifold, a black belt with pulleys and thick exhaust headers, on a small stand'],
  ['Bullet train', 'a sleek white high speed bullet train locomotive with a long rounded nose, a blue stripe along the side and dark windows, on a short piece of track'],
  ['Analog synthesizer', 'a compact analog synthesizer keyboard with wooden side panels, a black top panel full of colorful knobs and sliders, small patch cables and two octaves of keys'],
  ['Microchip', 'a large square computer microchip processor with a brushed metal lid, a dark green base, rows of thick golden pins on four sides and a small glowing blue core'],
  ['Motherboard', 'a computer motherboard with a dark green circuit board, a silver processor socket, four colorful memory sticks, black heat sinks with fins, golden capacitors and a chunky graphics card slot'],
  ['Fighter cockpit', 'a cutaway jet fighter cockpit section with a pilot seat, a control stick, glowing green instrument screens, rows of switches and an open glass canopy'],
  ['Studio headphones', 'a pair of chunky over-ear studio headphones in matte black with thick soft ear cushions, brushed copper ear cups and a padded headband, resting on a small stand'],
  ['Smartphone', 'a modern smartphone standing upright on a small stand, with a titanium frame, a glossy black glass back, three round camera lenses and a colorful home screen with app icons'],
  ['Cappuccino', 'a cappuccino in a wide white ceramic cup on a saucer, with thick milk foam, a heart pattern of latte art, a small spoon and two coffee beans beside it'],
  ['Colombia Australia flags', 'a desk flag stand with two small waving flags on short thick poles on one round wooden base, the flag of Colombia with yellow, blue and red horizontal stripes and the flag of Australia in dark blue with the union jack and white stars'],
  ['Sydney Opera House', 'a scale model of the Sydney Opera House in Australia, with its white sail shaped shells on a wide sandstone platform with steps, on a blue water base'],
  ['Botero sculpture', 'a voluminous rounded bronze sculpture of a very fat cat in the style of the Botero sculptures of Plaza Botero in Medellin, smooth dark bronze, standing on a low stone plinth'],
  ['Edificio Coltejer', 'a scale model replica of the Edificio Coltejer tower in Medellin, Colombia: a tall slim concrete skyscraper with rows of narrow vertical windows and a pointed top shaped like a weaving needle, rising from a wide low base building'],
  ['Taj Mahal', 'a scale model of the Taj Mahal in India, white marble with a large central onion dome, four smaller domes, four slim minarets at the corners and a square platform'],
  ['Flying car', 'a sleek futuristic two seat flying car with a low smooth silver body, a glass bubble canopy, four enclosed round rotor fans at the corners and red tail lights, hovering on a small clear stand'],
];

const sleep = (ms) => new Promise((go) => setTimeout(go, ms));

/** The card is queued by ugpu: "busy" means this picture waits its turn. Asking again keeps the place. */
async function picture(prompt) {
  for (;;) {
    const r = await fetch(IMAGE_GEN + '/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: `${prompt}, ${FRAME}`, model: 'qwen-image', width: 1024, height: 1024, app: 'ugen3d' }),
      signal: AbortSignal.timeout(30 * 60_000),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r && r.ok && j.image) return Buffer.from(j.image.split(',')[1], 'base64');
    if (r && r.status !== 503) throw new Error(`picture generator: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    await sleep(3000);
  }
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  await db.connect();
  const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  const have = new Set((await db.query(`SELECT name FROM genshape3d_jobs WHERE source = $1 AND deleted = false`, [SOURCE])).rows.map((r) => r.name));
  // Every picture first, then every 3D job. Taking turns would make the card swap the picture model
  // and the 3D model in and out for each subject, and each swap loads tens of GB: the machine freezes.
  const drawn = [];
  for (const [name, prompt] of SUBJECTS) {
    if (have.has(name)) { console.log(`skip ${name}: already in the workspace`); continue; }
    drawn.push([name, prompt, await picture(prompt)]);
    console.log(`picture ${name}`);
  }
  let queued = 0;
  for (const [name, prompt, png] of drawn) {
    const isJpeg = png[0] === 0xff && png[1] === 0xd8;
    const key = `uploads/${Date.now()}-${crypto.randomUUID()}.${isJpeg ? 'jpg' : 'png'}`;
    await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET || 'genshape3d', Key: key, Body: png, ContentType: isJpeg ? 'image/jpeg' : 'image/png' }));
    await db.query(
      `INSERT INTO genshape3d_jobs (id, "userEmail", "imageUrl", prompt, style, status, "polygonBudget", "textureRes", "exportFormat",
         "detailLevel", "doTexture", "octreeResolution", "targetFaceCount", "inferenceSteps", "guidanceScale", name, model,
         "preferredWorkerId", tags, source, "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,'Realistic','pending','Medium (50k-200k)','2K','GLB','Standard',true,512,200000,20,7,$5,'trellis2','win-3090','{}',$6,$7,NOW())`,
      [crypto.randomUUID(), EMAIL, `${PUBLIC}/${key}`, prompt, name, SOURCE, new Date().toISOString()],
    );
    queued++;
    console.log(`queued ${name}`);
  }
  await db.end();
  console.log(`${queued} landing page generations queued.`);
}

main().catch((e) => { console.error('FAULT', e.message); process.exit(1); });

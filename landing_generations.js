#!/usr/bin/env node
// Landing page generations: one picture from each prompt (Qwen-Image on this machine), then one 3D job
// each in the workspace "landingpage", the same settings as the ones already there (Trellis 2, 2K
// texture, 200,000 faces). ugpu queues everything; the worker takes the 3D jobs one at a time.
//   node landing_generations.js            queues every subject below that is not in the workspace yet
//   node landing_generations.js --pictures gives the workspace a picture row for every job of this script that lacks one
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const IMAGE_GEN = process.env.IMAGE_GEN_URL || 'http://127.0.0.1:8430';
const PUBLIC = (process.env.R2_ASSETS_URL || 'https://assets.genshape3d.com').replace(/\/$/, '');
const EMAIL = 'usquiano@gmail.com';
const SOURCE = 'ws-landingpage';
// The same wording the app puts after a prompt, so the pictures match the ones made there.
const FRAME = 'one single isolated object, whole object visible with space around it, centered, three quarter front view, plain solid black background, soft studio lighting, highly detailed stylized 3D game asset, rich saturated colors, clean silhouette';

/** The workspace shows a picture only if it has a row of its own: a 3D job alone does not appear there. */
const ASSET = `INSERT INTO genshape3d_text2image_assets (id, user_email, name, prompt, final_prompt, params, provider, image_key, "viewLabel", "readyFor3D", tags, source, created_at)
  VALUES ($1, $2, $3, $4, $4, '{"h":1024,"w":1024,"refCount":0}', 'local-qwen-image', $5, 'front', true, '{landing}', $6, $7)`;

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
  ['Vintage typewriter', 'a chunky vintage typewriter in glossy dark green with round metal keys, a silver carriage and a sheet of cream paper'],
  ['Espresso machine', 'a retro espresso machine in polished chrome and red with two thick handles, a round pressure gauge and a small white cup'],
  ['Electric guitar', 'a chunky electric guitar in sunburst orange with a white pickguard, chrome pickups and six tuning pegs, standing on a small stand'],
  ['Drum kit', 'a compact toy-like drum kit in glossy blue with a big bass drum, two toms, a snare and two golden cymbals'],
  ['Grand piano', 'a small stylized black grand piano with its lid open, white and black keys, golden strings inside and a round stool'],
  ['Vinyl turntable', 'a retro vinyl turntable in walnut wood with a black record, a silver tone arm and two round knobs'],
  ['Gaming console', 'a chunky retro gaming console in grey and purple with a cartridge inserted and a thick wired controller beside it'],
  ['Mechanical keyboard', 'a compact mechanical keyboard with chunky colorful keycaps in orange, cream and teal on a brushed aluminum case'],
  ['Satellite', 'a chunky space satellite with a gold foil body, two wide blue solar panels and a white round dish antenna, on a small stand'],
  ['Mars rover', 'a detailed six wheeled mars rover in white and copper with a camera mast, a small dish and thick wheels, on a patch of red rocky ground'],
  ['Lunar lander', 'a chunky lunar lander with a gold foil body, four thick landing legs, a small round hatch and a ladder, on a grey moon surface base'],
  ['Space station', 'a compact sci-fi space station module with a white ring, a central cylinder and four solar panels, on a small stand'],
  ['Fire truck', 'a chunky red fire truck with a silver ladder on top, round headlights, thick black tires and a golden stripe'],
  ['London bus', 'a chunky red double decker bus with rows of windows, round headlights and thick black tires'],
  ['Classic muscle car', 'a classic american muscle car in deep blue with two white racing stripes, chrome bumpers and wide tires'],
  ['Formula race car', 'a sleek open wheel formula race car in red and white with a wide front wing, a tall rear wing and thick slick tires'],
  ['Yellow taxi', 'a chunky stylized yellow taxi cab with a checker stripe, a small roof sign, round headlights and thick tires'],
  ['Helicopter', 'a chunky rescue helicopter in orange and white with a big glass nose, a thick main rotor, a tail rotor and two landing skids'],
  ['Biplane', 'a vintage red biplane with two stacked wings, a wooden propeller, a round engine and two thick wheels'],
  ['Sailing boat', 'a stylized wooden sailing boat with one tall mast, thick cream sails, a blue hull and a small cabin, on a small water base'],
  ['Tractor', 'a chunky green farm tractor with huge black rear wheels, small front wheels, a yellow seat and a short exhaust pipe'],
  ['Excavator', 'a chunky yellow excavator with a thick jointed arm, a steel bucket, a glass cab and black tracks'],
  ['Eiffel Tower', 'a scale model of the Eiffel Tower in Paris in dark bronze iron lattice with its arched base and thick legs, on a square stone platform'],
  ['Colosseum', 'a scale model of the Colosseum in Rome in warm stone with rows of arches and its broken outer wall, on a round base'],
  ['Great Pyramid', 'a scale model of the great pyramid of Giza with the Sphinx in front of it, sandstone blocks, on a square desert sand base'],
  ['Statue of Liberty', 'a scale model of the Statue of Liberty in green copper, holding a golden torch and a tablet, on a tall stone pedestal'],
  ['Machu Picchu', 'a scale model of Machu Picchu in Peru with stone terraces, small stone buildings and one tall green mountain peak, on a round base'],
  ['Big Ben', 'a scale model of the Big Ben clock tower in London in golden stone with a white clock face and a dark pointed roof, on a square base'],
  ['Corgi', 'a cute chubby corgi dog in orange and white with big ears and a happy face, sitting on a small round cushion'],
  ['Red fox', 'a stylized sitting red fox with a thick bushy tail, a white chest and black paws, on a mossy rock'],
  ['Owl', 'a chubby stylized snowy owl with big round golden eyes and thick feathers, perched on a short tree stump'],
  ['Elephant', 'a chunky stylized baby elephant in soft grey with big round ears, a short trunk and a colorful patterned blanket on its back'],
  ['Sea turtle', 'a stylized green sea turtle with a thick patterned shell and four wide flippers, on a small coral reef base'],
  ['Toucan', 'a chubby stylized toucan with a huge orange and yellow beak, black feathers and a white chest, perched on a thick branch'],
  ['Ice cream sundae', 'a tall ice cream sundae in a clear glass with three colorful scoops, whipped cream, chocolate sauce and a red cherry on top'],
  ['Pizza', 'a whole round pepperoni pizza on a wooden board with thick crust, melted cheese and basil leaves, one slice slightly pulled out'],
  ['Arepa breakfast', 'a colombian breakfast on a round clay plate with two thick golden arepas, fried egg, white cheese and a small cup of hot chocolate'],
  ['Fantasy sword', 'a large fantasy sword with a glowing blue blade, a golden crossguard and a leather grip, standing upright in a rock'],
  ['Crystal cluster', 'a large cluster of glowing purple and teal crystals growing from a dark rock base'],
  ['Wooden galleon', 'a chunky wooden pirate galleon with three masts, cream sails, a carved stern and rows of small cannons, on a small water base'],
];

const sleep = (ms) => new Promise((go) => setTimeout(go, ms));

// Each picture is kept on disk as soon as it is drawn, so a run that dies starts again where it stopped.
const DRAWN = 'G:/projects_support/landing_pictures';
const drawnFile = (name) => path.join(DRAWN, name.replace(/[^\w-]+/g, '_') + '.png');
const RETRIES = 2;

/** Stays until every job of this script is done, and gives a failed one another turn. */
async function watch(db) {
  const names = SUBJECTS.map(([n]) => n);
  const tries = new Map();
  const until = Date.now() + 7 * 3600_000;
  while (Date.now() < until) {
    const { rows } = await db.query(`SELECT id, name, status FROM genshape3d_jobs WHERE source = $1 AND deleted = false AND name = ANY($2)`, [SOURCE, names]);
    let open = rows.filter((j) => j.status === 'pending' || j.status === 'processing').length;
    for (const j of rows.filter((x) => x.status === 'failed')) {
      const n = tries.get(j.id) || 0;
      if (n >= RETRIES) continue;
      tries.set(j.id, n + 1);
      open++;
      console.log(`again ${j.name}`);
      await db.query(`UPDATE genshape3d_jobs SET status = 'pending', "errorMessage" = '', "progressPct" = 0, "progressPhase" = '', "completedAt" = NULL, "updatedAt" = NOW() WHERE id = $1`, [j.id]);
    }
    if (!open) return console.log(`finished: ${rows.filter((j) => j.status === 'done').length} done, ${rows.filter((j) => j.status === 'failed').length} failed`);
    await sleep(60_000);
  }
  console.log('stopped watching after 7 hours');
}

/** The card is queued by ugpu: "busy" means this picture waits its turn. Asking again keeps the place. */
async function picture(prompt) {
  let faults = 0;
  for (;;) {
    // Never ask for a model load on a machine that is short of memory.
    while (os.freemem() < 4 * 2 ** 30) await sleep(20_000);
    const r = await fetch(IMAGE_GEN + '/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: `${prompt}, ${FRAME}`, model: 'qwen-image', width: 1024, height: 1024, app: 'ugen3d' }),
      signal: AbortSignal.timeout(30 * 60_000),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r && r.ok && j.image) return Buffer.from(j.image.split(',')[1], 'base64');
    if (r && r.status !== 503) {
      if (++faults > 5) throw new Error(`picture generator: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      await sleep(30_000);
    }
    await sleep(3000);
  }
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  await db.connect();
  if (process.argv.includes('--pictures')) {
    const names = SUBJECTS.map(([n]) => n);
    const { rows } = await db.query(
      `SELECT j.name, j.prompt, j."imageUrl", j."createdAt" FROM genshape3d_jobs j
       WHERE j.source = $1 AND j.deleted = false AND j.name = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM genshape3d_text2image_assets a WHERE a.image_key = replace(j."imageUrl", $3, ''))`,
      [SOURCE, names, PUBLIC + '/'],
    );
    for (const j of rows) await db.query(ASSET, [crypto.randomUUID(), EMAIL, j.name, j.prompt, j.imageUrl.replace(PUBLIC + '/', ''), SOURCE, new Date(j.createdAt)]);
    console.log(`${rows.length} pictures added to the workspace.`);
    await db.end();
    return;
  }
  const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  const have = new Set((await db.query(`SELECT name FROM genshape3d_jobs WHERE source = $1 AND deleted = false`, [SOURCE])).rows.map((r) => r.name));
  // Every picture first, then every 3D job. Taking turns would make the card swap the picture model
  // and the 3D model in and out for each subject, and each swap loads tens of GB: the machine freezes.
  fs.mkdirSync(DRAWN, { recursive: true });
  const drawn = [];
  for (const [name, prompt] of SUBJECTS) {
    if (have.has(name)) { console.log(`skip ${name}: already in the workspace`); continue; }
    const file = drawnFile(name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, await picture(prompt));
    drawn.push([name, prompt, fs.readFileSync(file)]);
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
    await db.query(ASSET, [crypto.randomUUID(), EMAIL, name, `${prompt}, ${FRAME}`, key, SOURCE, new Date()]);
    queued++;
    console.log(`queued ${name}`);
  }
  console.log(`${queued} landing page generations queued.`);
  await watch(db);
  await db.end();
}

main().catch((e) => { console.error('FAULT', e.message); process.exit(1); });

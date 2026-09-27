// Flip a user between admin and free for testing both rate-limit scenarios.
// Usage:
//   node role.js                        # show current role + 24h usage
//   node role.js admin                  # promote to admin (no limit)
//   node role.js free                   # demote to free (3 jobs / 24h)
//   node role.js <email> admin|free     # target a different email
require('dotenv').config();
const { Client } = require('pg');

const defaultEmail = 'usquiano@gmail.com';
const args = process.argv.slice(2);
let email = defaultEmail;
let role = null;
if (args.length === 1) {
  if (['admin', 'free', 'pro', 'guest'].includes(args[0])) role = args[0];
  else email = args[0];
} else if (args.length >= 2) {
  email = args[0]; role = args[1];
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await c.connect();
  if (role) {
    const credits = { guest: 0, free: 10, pro: 200, admin: 9999 }[role];
    const r = await c.query(
      `UPDATE genshape3d_users SET role = $1, credits = $2 WHERE email = $3 RETURNING email, role, credits`,
      [role, credits, email],
    );
    if (r.rowCount === 0) console.error(`No user row for ${email} — log in once on the site first.`);
    else console.log('UPDATED:', r.rows[0]);
  }
  const cur = await c.query(`SELECT email, role, credits FROM genshape3d_users WHERE email = $1`, [email]);
  const used = await c.query(
    `SELECT COUNT(*)::int AS n FROM genshape3d_jobs
     WHERE "userEmail" = $1 AND "createdAt"::timestamptz > NOW() - INTERVAL '24 hours'`,
    [email],
  );
  console.log('USER:', cur.rows[0] || '(no row)');
  console.log('JOBS IN LAST 24h:', used.rows[0].n);
  await c.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

const https = require('https');
const email = process.argv[2] || 'uskajitas@gmail.com';
https.get(`https://api.genshape3d.com/api/jobs?email=${encodeURIComponent(email)}`, r => {
  let s = '';
  r.on('data', d => s += d);
  r.on('end', () => {
    let d; try { d = JSON.parse(s); } catch { console.log('non-JSON:', s.slice(0, 200)); return; }
    const j = d.jobs || d;
    if (!Array.isArray(j)) { console.log('shape:', JSON.stringify(d).slice(0, 300)); return; }
    const by = {}, bench = {}, models = {};
    for (const x of j) {
      by[x.status] = (by[x.status] || 0) + 1;
      bench[String(x.isBenchmark)] = (bench[String(x.isBenchmark)] || 0) + 1;
      models[x.model] = (models[x.model] || 0) + 1;
    }
    console.log('email:', email);
    console.log('total jobs:', j.length);
    console.log('by status:', by);
    console.log('isBenchmark:', bench);
    console.log('by model:', models);
    if (j[0]) console.log('sample keys:', Object.keys(j[0]).join(', '));
    if (j[0]) console.log('sample:', JSON.stringify({ id: j[0].id, status: j[0].status, isBenchmark: j[0].isBenchmark, resultUrl: (j[0].resultUrl || '').slice(0, 50), groupId: j[0].groupId, archived: j[0].archived }));
  });
}).on('error', e => console.log('ERR', e.message));

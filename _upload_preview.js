require('dotenv').config();
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const file = process.argv[2] || 'C:/tmp/h21test/output.glb';
const key = `outputs/preview-${Date.now()}-h21-spaceship.glb`;
const buf = fs.readFileSync(file);

s3.send(new PutObjectCommand({
  Bucket: process.env.R2_BUCKET,
  Key: key,
  Body: buf,
  ContentType: 'model/gltf-binary',
})).then(() => {
  console.log(`uploaded ${key} (${(buf.length/1024).toFixed(1)} KB)`);
  console.log(`view: https://api.genshape3d.com/api/image?key=${encodeURIComponent(key)}`);
}).catch(e => { console.error(e.message); process.exit(1); });

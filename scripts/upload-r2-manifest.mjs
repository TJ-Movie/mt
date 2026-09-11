import { readFile } from 'node:fs/promises';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME || 'flixlyra-media';
if (!accountId || !accessKeyId || !secretAccessKey) throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
const client = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
const manifest = JSON.parse(await readFile('tmp/tmdb-r2-uploads.json', 'utf8'));
const concurrency = 10;
for (let i = 0; i < manifest.length; i += concurrency) {
  const batch = manifest.slice(i, i + concurrency);
  await Promise.all(batch.map(async ({ key, file }) => {
    const body = await readFile(file);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }));
  }));
  console.log(`uploaded ${Math.min(i + concurrency, manifest.length)}/${manifest.length}`);
}
let verified = 0;
for (let i = 0; i < manifest.length; i += concurrency) {
  await Promise.all(manifest.slice(i, i + concurrency).map(async ({ key }) => { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); verified++; }));
}
console.log(JSON.stringify({ uploaded: manifest.length, verified }));

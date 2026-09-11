import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const exec = promisify(execFile);
const endpoint = 'https://movies-api.accel.li/api/v2/movie_details.json';
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;

async function sql(command) {
  const { stdout } = await exec(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flixlyra-db', '--remote', '--config', 'wrangler.json', '--json', '--command', command], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout).flatMap((item) => item.results || []);
}

function torrents(movie) {
  const all = Array.isArray(movie?.torrents) ? movie.torrents : [];
  return ['1080p', '720p'].map((quality) => all.find((item) => item?.quality?.toLowerCase() === quality && /^https:\/\//.test(item.url))).filter(Boolean);
}

async function main() {
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  const account = process.env.R2_ACCOUNT_ID || config.account_id;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) throw new Error('R2 credentials and R2_BUCKET_NAME are required');
  const s3 = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  const rows = await sql("SELECT id, imdb_id, download_sources_json FROM movies WHERE publication_status='draft' AND imdb_id IS NOT NULL ORDER BY id LIMIT 20");
  for (const row of rows) {
    const response = await fetch(`${endpoint}?imdb_id=${encodeURIComponent(row.imdb_id)}`);
    if (!response.ok) throw new Error(`${row.imdb_id}: YTS ${response.status}`);
    const payload = await response.json();
    const found = torrents(payload?.data?.movie);
    if (found.length !== 2) throw new Error(`${row.imdb_id}: both 720p and 1080p torrents are required`);
    const existing = JSON.parse(row.download_sources_json || '{}');
    const previous = Array.isArray(existing) ? existing : (Array.isArray(existing.sources) ? existing.sources : []);
    const sources = [];
    for (const torrent of found) {
      const quality = torrent.quality.toLowerCase();
      const prior = previous.find((item) => item.quality?.toLowerCase() === quality) || {};
      const descriptorKey = prior.descriptorKey || `descriptors/${row.imdb_id}-${quality}.torrent`;
      if (!prior.descriptorKey) {
        const descriptor = await fetch(torrent.url, { signal: AbortSignal.timeout(30000) });
        if (!descriptor.ok) throw new Error(`${row.imdb_id}: descriptor ${descriptor.status}`);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: descriptorKey, Body: new Uint8Array(await descriptor.arrayBuffer()), ContentType: 'application/x-bittorrent', CacheControl: 'private, no-store' }));
      }
      sources.push({ label: `YTS ${quality}`, quality, resolution: quality, size: String(torrent.size || prior.size || 'Unknown'), url: torrent.url, descriptorKey, ...(prior.r2StorageKey ? { r2StorageKey: prior.r2StorageKey, r2Bytes: prior.r2Bytes } : {}) });
    }
    const ready = sources.every((item) => typeof item.r2StorageKey === 'string');
    await sql(`UPDATE movies SET download_sources_json=${quote(JSON.stringify({ status: ready ? 'available' : 'pending', sources }))}, storage_key=${quote(sources[0].descriptorKey)}, ingest_status=${ready ? "'ready'" : "'queued'"}, updated_at=${quote(new Date().toISOString())}, revision=revision+1 WHERE id=${Number(row.id)} AND publication_status='draft'`);
    console.log(`${row.imdb_id}: queued ${sources.map((item) => item.quality).join('+')}`);
  }
  s3.destroy();
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const exec = promisify(execFile);
const MAX_DELETE_BATCH = 1_000;
const MANAGED_R2_KEY = /^(?:artworks\/\d+\/(?:poster|backdrop)\.jpg|assets\/[a-f0-9-]{36}\/(?:data\.bin|720p\.mp4|1080p\.mp4)|movie-art\/[a-f0-9-]{36}\.(?:jpg|png)|(?:posters|backdrops)\/tt\d{7,10}\.(?:jpg|png)|cast\/tt\d{7,10}-[1-6]\.(?:jpg|png)|subtitles\/[a-f0-9-]{36}\.(?:srt|vtt|zip|7z)|descriptors\/tt\d{7,10}-(?:720p|1080p)\.torrent|movies\/\d+(?:\/|-).+|media\/\d+-(?:720p|1080p)\.mp4)$/;
const PREFIXED_MOVIE_KEY = /^(?:movies|media)\/(\d+)(?:\/|-)/;

function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function loadLocalEnv() {
  try {
    const values = parseEnvFile(await readFile(resolve(process.cwd(), '.env.r2-upload.local'), 'utf8'));
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) {
      if (!process.env[name] && values[name]) process.env[name] = values[name];
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[env] Could not read local R2 env file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function movieIdFromKey(key) {
  const match = key.match(PREFIXED_MOVIE_KEY);
  return match ? Number(match[1]) : null;
}

function addReferencedKey(keys, value) {
  if (typeof value !== 'string') return;
  const candidate = value.startsWith('/media/') ? value.slice('/media/'.length) : value.startsWith('https://flixlyra.com/media/') ? value.slice('https://flixlyra.com/media/'.length) : value;
  if (MANAGED_R2_KEY.test(candidate)) keys.add(candidate);
}

function collectNestedKeys(keys, value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    addReferencedKey(keys, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectNestedKeys(keys, item, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value).slice(0, 100)) collectNestedKeys(keys, item, depth + 1);
  }
}

function collectMovieKeys(row) {
  const keys = new Set();
  for (const value of [row.poster, row.backdrop, row.subtitle_url, row.storage_key, row.r2_storage_key]) addReferencedKey(keys, value);
  for (const json of [row.cast_json, row.episodes_json, row.download_sources_json, row.streaming_sources_json]) {
    try { collectNestedKeys(keys, JSON.parse(json || 'null')); } catch { /* Ignore malformed legacy JSON. */ }
  }
  return keys;
}

async function queryMovies() {
  const { stdout } = await exec(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'flixlyra-db', '--remote',
    '--config', 'wrangler.json', '--json', '--command',
    'SELECT id,publication_status,poster,backdrop,subtitle_url,cast_json,episodes_json,download_sources_json,streaming_sources_json,storage_key,r2_storage_key FROM movies',
  ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout).flatMap((entry) => entry.results || []);
}

async function listObjects(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    objects.push(...(page.Contents || []).map((object) => ({ key: object.Key, bytes: Number(object.Size || 0) })));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${bytes} B`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

await loadLocalEnv();
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
const account = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET_NAME;
if (!account || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !bucket) throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME are required');
if (account !== config.account_id || bucket !== config.r2_buckets?.find((item) => item.binding === 'MEDIA')?.bucket_name) throw new Error('R2 account/bucket secrets do not match wrangler.json');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${account}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
try {
  const rows = await queryMovies();
  const existingMovieIds = new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isSafeInteger(id) && id > 0));
  const referencedKeys = new Set();
  for (const row of rows) for (const key of collectMovieKeys(row)) referencedKeys.add(key);
  const objects = await listObjects(client, bucket);
  const orphaned = objects.filter((object) => {
    if (!object.key || !MANAGED_R2_KEY.test(object.key)) return false;
    if (referencedKeys.has(object.key)) return false;
    const movieId = movieIdFromKey(object.key);
    return movieId === null || !existingMovieIds.has(movieId);
  });
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', d1Movies: rows.length, r2Objects: objects.length, orphaned: orphaned.length, estimatedBytes: orphaned.reduce((total, object) => total + object.bytes, 0) }, null, 2));
  } else {
    let purged = 0;
    let reclaimedBytes = 0;
    for (let offset = 0; offset < orphaned.length; offset += MAX_DELETE_BATCH) {
      const batch = orphaned.slice(offset, offset + MAX_DELETE_BATCH);
      try {
        const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((object) => ({ Key: object.key })), Quiet: false } }));
        for (const error of result.Errors || []) console.warn(JSON.stringify({ event: 'r2_orphan_delete_failed', key: error.Key, code: error.Code, message: error.Message }));
        const failed = new Set((result.Errors || []).map((error) => error.Key));
        purged += batch.filter((object) => !failed.has(object.key)).length;
        reclaimedBytes += batch.filter((object) => !failed.has(object.key)).reduce((total, object) => total + object.bytes, 0);
      } catch (error) {
        console.warn(JSON.stringify({ event: 'r2_orphan_delete_batch_failed', count: batch.length, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    console.log(`🧹 Purged ${purged} orphaned files from R2 storage. Reclaimed estimated storage: ${formatBytes(reclaimedBytes)}.`);
  }
} finally {
  client.destroy();
}

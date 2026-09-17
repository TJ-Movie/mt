#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { readFile, writeFile } from 'node:fs/promises';

const MAX_ATTEMPTS = 4; // initial attempt + 3 retries
const MAX_RETRIES = 5; // consecutive remaining-batch retries
const RETRY_BASE_MS = 5_000;
if (process.argv.includes('--force-commit')) throw new Error('FORCE_COMMIT_DISABLED_USE_LEASED_CANONICAL_TRANSFER');
const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.bin': 'application/octet-stream' };

// Make CI output visible as soon as each line is emitted.
process.stdout._handle?.setBlocking?.(true);
process.stderr._handle?.setBlocking?.(true);

const SECRET_ENV_NAMES = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_API_TOKEN'];
function safeLogError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]');
}

function option(name, fallback) {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : value;
}
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
    if (error?.code !== 'ENOENT') console.warn('[env] Could not read .env.r2-upload.local; using process environment.');
  }
}
function fail(message) { throw new Error(message); }
function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.startsWith('/') && !key.includes('\\') && !key.split('/').includes('..');
}
function contentType(file) { return CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream'; }
function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

async function loadManifest(manifestPath, mediaDirectory) {
  const entries = new Map();
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed?.files;
    if (!Array.isArray(list)) fail(`Manifest must be an array or contain a files array: ${manifestPath}`);
    for (const item of list) {
      const key = item?.key;
      const file = item?.file;
      if (!validKey(key) || typeof file !== 'string') fail(`Invalid manifest entry in ${manifestPath}`);
      const local = resolve(file);
      if (!local.startsWith(resolve(process.cwd()) + sep) && !local.startsWith(resolve(mediaDirectory) + sep)) fail(`Manifest file escapes workspace: ${file}`);
      entries.set(key, local);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    for (const file of await walk(mediaDirectory)) {
      const key = relative(resolve(mediaDirectory), file).split(sep).join('/');
      if (validKey(key) && !entries.has(key)) entries.set(key, file);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return [...entries].map(([key, file]) => ({ key, file }));
}

async function head(client, bucket, key) {
  try { return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); }
  catch (error) { if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return null; throw error; }
}

async function syncOne(client, bucket, item, dryRun, deadlineAt) {
  const ensureDeadline = () => {
    if (Number.isSafeInteger(deadlineAt) && Date.now() >= deadlineAt) {
      const error = new Error('Movie processing budget exceeded');
      error.code = 'MOVIE_TIME_BUDGET_EXCEEDED';
      throw error;
    }
  };
  ensureDeadline();
  const local = await stat(item.file);
  if (!local.isFile() || local.size <= 0) throw new Error('local file is missing or empty');
  const existing = await head(client, bucket, item.key);
  if (existing && Number(existing.ContentLength) === local.size) return { state: 'skipped', bytes: local.size };
  if (dryRun) return { state: 'planned', bytes: local.size };
  console.log(`☁️ [Movie ID: ${item.id ?? 'unknown'}] Uploading ${item.quality || 'media'} to R2...`);
  const body = createReadStream(item.file);
  const upload = new Upload({ client, queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false,
    params: { Bucket: bucket, Key: item.key, Body: body, ContentLength: local.size, ContentType: contentType(item.file), CacheControl: item.key.endsWith('.mp4') ? 'private, max-age=0' : 'public, max-age=31536000, immutable' } });
  const uploadBudgetMs = Number.isSafeInteger(deadlineAt) ? Math.min(30 * 60000, Math.max(1, deadlineAt - Date.now())) : 30 * 60000;
  let budgetError = null;
  const timer = setTimeout(() => {
    budgetError = new Error('Movie processing budget exceeded');
    budgetError.code = 'MOVIE_TIME_BUDGET_EXCEEDED';
    void upload.abort();
    body.destroy(budgetError);
  }, uploadBudgetMs);
  try {
    await upload.done();
    ensureDeadline();
  } catch (error) {
    if (budgetError) throw budgetError;
    throw error;
  } finally { clearTimeout(timer); body.destroy(); }
  ensureDeadline();
  const verified = await head(client, bucket, item.key);
  if (!verified || Number(verified.ContentLength) !== local.size) {
    const error = new Error(`post-upload HEAD size mismatch (local ${local.size}, R2 ${verified?.ContentLength ?? 'missing'})`);
    error.code = 'R2_VERIFY_FAILED';
    throw error;
  }
  console.log(`✅ [Movie ID: ${item.id ?? 'unknown'}] R2 Upload complete & verified.`);
  return { state: 'uploaded', bytes: local.size };
}

await loadLocalEnv();
const account = option('r2-account-id', process.env.R2_ACCOUNT_ID);
const accessKeyId = option('r2-access-key-id', process.env.R2_ACCESS_KEY_ID);
const secretAccessKey = option('r2-secret-access-key', process.env.R2_SECRET_ACCESS_KEY);
const bucket = option('r2-bucket-name', process.env.R2_BUCKET_NAME || 'flixlyra-media');
if (!account || !accessKeyId || !secretAccessKey) fail('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9-]+$/.test(bucket)) fail('Invalid R2 account or bucket name');

const manifestPath = option('manifest', 'tmp/tmdb-r2-uploads.json');
const mediaDirectory = option('media-dir', 'tmp/r2-assets');
const concurrency = Math.min(10, Math.max(1, Number(option('concurrency', '2'))));
if (!Number.isSafeInteger(concurrency)) fail('Invalid --concurrency');
const qualityFilter = option('quality', '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
if (qualityFilter.some((value) => !/^(720p|1080p)$/.test(value))) fail('--quality only accepts 720p and/or 1080p');
const dryRun = process.argv.includes('--dry-run');
const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
function selectedItems(allItems) {
  return qualityFilter.length ? allItems.filter(({ key }) => qualityFilter.some((quality) => new RegExp(`(?:^|[-_/])${quality}(?:[._/-]|$)`, 'i').test(key))) : allItems;
}
async function findPending(items, failedKeys = new Set()) {
  const pending = [];
  let cursor = 0;
  async function scanner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (failedKeys.has(item.key)) continue;
      const local = await stat(item.file);
      if (!local.isFile() || local.size <= 0) { pending.push(item); continue; }
      const existing = await head(client, bucket, item.key);
      if (!existing || Number(existing.ContentLength) !== local.size) pending.push(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, scanner));
  return pending;
}
async function uploadBatch(items, deadlineAt) {
  const counts = { planned: 0, uploaded: 0, skipped: 0, failed: 0 };
  const failedItems = [];
  let cursor = 0;
  async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= items.length) return;
    const item = items[index];
    let result;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try { result = await syncOne(client, bucket, item, dryRun, deadlineAt); break; }
      catch (error) {
        if (error?.code === 'MOVIE_TIME_BUDGET_EXCEEDED') { result = { state: 'failed', error: safeLogError(error) }; break; }
        if (attempt === MAX_ATTEMPTS) { result = { state: 'failed', error: safeLogError(error) }; break; }
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        console.log(`[retry] ${index + 1}/${items.length} ${item.key} attempt ${attempt}/${MAX_ATTEMPTS}; waiting ${delay / 1000}s`);
        await sleep(delay);
      }
    }
    counts[result.state] += 1;
    if (result.state === 'failed') {
      failedItems.push({ id: item.id ?? item.movieId ?? item.key, key: item.key, error: result.error });
      console.error(`[FAIL] ${index + 1}/${items.length} ${item.key}: ${result.error}`);
    }
    else console.log(`[${result.state.toUpperCase()}] ${index + 1}/${items.length} ${item.key} (${result.bytes} bytes)`);
  }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { ...counts, failedItems };
}

async function markBatchFailed(manifestFile, items, failures, cause) {
  const records = failures.length ? failures : items.map((item) => ({
    id: item.id ?? item.movieId ?? item.key,
    key: item.key,
    error: cause,
  }));
  const unique = [...new Map(records.map((record) => [record.key, record])).values()];
  for (const item of items) {
    if (unique.some((record) => record.key === item.key)) item.failed = true;
  }
  console.error(`[retry-loop] MAX_RETRIES=${MAX_RETRIES} reached. Marking ${unique.length} object(s) failed; no further automatic retries.`);
  console.error(JSON.stringify({ event: 'r2-sync-batch-failed', failedObjects: unique }, null, 2));
  try {
    await writeFile(`${manifestFile}.failures.json`, JSON.stringify({
      status: 'failed',
      maxRetries: MAX_RETRIES,
      generatedAt: new Date().toISOString(),
      failedObjects: unique,
    }, null, 2));
  } catch (error) {
    console.error(`[retry-loop] Could not write failure manifest: ${safeLogError(error)}`);
  }
}

let cloudPlan;
try { cloudPlan = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (cloudPlan?.schema === 'flixlyra-cloud-v1') {
  if (dryRun) { console.log(JSON.stringify({ status: 'dry-run', remaining: cloudPlan.files.filter(f => !f.verified).length })); process.exitCode = 2; }
  else {
    const { drainCloudPlan, syncAllArtwork, MediaInfrastructureError } = await import('./prepare-cloud-media.mjs');
    await drainCloudPlan(cloudPlan, async (item, { deadlineAt } = {}) => {
      const counts = await uploadBatch([item], deadlineAt);
      if (counts.failed) {
        if (Number.isSafeInteger(deadlineAt) && Date.now() >= deadlineAt) {
          const error = new Error('Movie processing budget exceeded');
          error.code = 'MOVIE_TIME_BUDGET_EXCEEDED';
          throw error;
        }
        throw new MediaInfrastructureError('R2_UPLOAD_FAILED', 'One or more staged media uploads failed');
      }
    }, { enrich: async (ctx, id) => { await syncAllArtwork(ctx, [id]); } });
  }
} else {
let iteration = 0;
let consecutiveRetries = 0;
let failedKeys = new Set();
let lastPending = [];
while (true) {
  iteration += 1;
  try {
    const allItems = selectedItems(await loadManifest(manifestPath, mediaDirectory));
    if (!allItems.length) fail('No local media files found. Check --manifest or --media-dir.');
    const pending = await findPending(allItems, failedKeys);
    lastPending = pending;
    console.log(`[scan] iteration ${iteration}: ${pending.length}/${allItems.length} files require upload`);
    if (!pending.length) {
      console.log(JSON.stringify({ bucket, manifest: manifestPath, mediaDirectory, qualityFilter: qualityFilter.length ? qualityFilter : 'all', total: allItems.length, remaining: 0, status: 'complete' }, null, 2));
      break;
    }
    if (dryRun) {
      console.log(JSON.stringify({ bucket, total: allItems.length, remaining: pending.length, status: 'dry-run' }, null, 2));
      process.exitCode = 2;
      break;
    }
    const batch = await uploadBatch(pending);
    const { failedItems, ...counts } = batch;
    console.log(JSON.stringify({ iteration, attempted: pending.length, ...counts }, null, 2));
    const remaining = await findPending(allItems, failedKeys);
    if (!remaining.length) {
      console.log(`[complete] all ${allItems.length} files are verified in R2`);
      break;
    }
    if (failedItems.length || remaining.length >= pending.length) consecutiveRetries += 1;
    else consecutiveRetries = 0;
    if (consecutiveRetries >= MAX_RETRIES) {
      await markBatchFailed(manifestPath, remaining, failedItems, 'remaining batch did not make progress');
      failedKeys = new Set(remaining.map((item) => item.key));
      process.exitCode = 1;
      break;
    }
    console.log(`[retry-loop] Auto-re-attempting remaining batch... ${remaining.length} files still pending`);
    console.log(`[retry-loop] Consecutive batch retry ${consecutiveRetries}/${MAX_RETRIES}`);
    await sleep(10_000);
  } catch (error) {
    console.error(`[retry-loop] ${safeLogError(error)}`);
    if (dryRun) { process.exitCode = 2; break; }
    consecutiveRetries += 1;
    if (consecutiveRetries >= MAX_RETRIES) {
      await markBatchFailed(manifestPath, lastPending, [], safeLogError(error));
      process.exitCode = 1;
      break;
    }
    console.log(`🔁 Retrying remaining batch (Attempt ${consecutiveRetries + 1}/${MAX_RETRIES})...`);
    await sleep(10_000);
  }
}
}
client.destroy();

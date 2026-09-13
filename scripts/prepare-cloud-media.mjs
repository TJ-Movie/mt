import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, statfs, stat, open } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { loadGuardedWebTorrent } from './webtorrent-guard.mjs';
import { primaryMp4, uploadStream, sourceMagnet, remoteDescriptor, alternativeDescriptor } from './magnet-to-r2.mjs';

export const manifestPath = 'tmp/r2-video-manifest.json';
const mediaRoot = resolve('tmp/media');
const MAX_RETRIES = 5;
const DEFAULT_MAX_MOVIES = 2;
const pause = ms => new Promise(done => setTimeout(done, ms));

// Keep GitHub Actions output flowing line-by-line while media is acquired.
process.stdout._handle?.setBlocking?.(true);
process.stderr._handle?.setBlocking?.(true);

const SECRET_ENV_NAMES = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_D1_TOKEN'];
function safeLogError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]');
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function maxMoviesFromArgs(argv = process.argv) {
  const raw = argv.find(value => value.startsWith('--max-movies='))?.slice('--max-movies='.length);
  if (raw === undefined || raw === '') return DEFAULT_MAX_MOVIES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new Error('--max-movies must be an integer from 1 to 20');
  return value;
}

export function isNonRetryableValidationError(error) {
  return /(?:MP4 validation failed|No safe playable MP4 in source)/i.test(safeLogError(error));
}

function progressStream(stream, item, totalBytes) {
  let downloaded = 0;
  let nextPercent = 10;
  let lastLoggedAt = 0;
  const startedAt = Date.now();
  const report = (force = false) => {
    const now = Date.now();
    const percent = totalBytes > 0 ? Math.min(100, Math.floor(downloaded / totalBytes * 100)) : 0;
    if (!force && percent < nextPercent && now - lastLoggedAt < 10_000) return;
    const seconds = Math.max((now - startedAt) / 1000, 0.001);
    const speed = downloaded / seconds / 1_000_000;
    console.log(`⬇️ [Movie ID: ${item.id}] Downloading ${item.quality}: ${percent}% (${formatBytes(downloaded)} / ${formatBytes(totalBytes)}) - Speed: ${speed.toFixed(1)} MB/s`);
    lastLoggedAt = now;
    while (nextPercent <= percent) nextPercent += 10;
  };
  report(true);
  stream.on('data', chunk => {
    downloaded += chunk.byteLength ?? chunk.length ?? 0;
    report();
  });
  stream.on('end', () => report(true));
  return stream;
}
export function sourcesOf(value) {
  const parsed = JSON.parse(value || '{}');
  return Array.isArray(parsed) ? parsed : (parsed.sources || []);
}
export function stableKey(id, quality) {
  if (!Number.isSafeInteger(id) || id <= 0 || !['720p', '1080p'].includes(quality)) throw new Error('Invalid media identity');
  const h = createHash('sha256').update(`flixlyra:${id}:${quality}`).digest('hex');
  return `assets/${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}/${quality}.mp4`;
}
export async function context() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
  const d1Token = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  for (const [name, value] of [['CLOUDFLARE_ACCOUNT_ID', account], ['R2_ACCESS_KEY_ID', process.env.R2_ACCESS_KEY_ID], ['R2_SECRET_ACCESS_KEY', process.env.R2_SECRET_ACCESS_KEY], ['R2_BUCKET_NAME', process.env.R2_BUCKET_NAME], ['CLOUDFLARE_D1_TOKEN', d1Token]]) {
    if (!value?.trim()) throw new Error(`Missing repository secret: ${name}`);
  }
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  const bucket = process.env.R2_BUCKET_NAME;
  if (account !== config.account_id || !config.r2_buckets.some(b => b.bucket_name === bucket)) throw new Error('Cloud account/bucket does not match deployment');
  const configuredDatabaseId = config.d1_databases.find(d => d.binding === 'DB').database_id;
  const db = process.env.CLOUDFLARE_DATABASE_ID || configuredDatabaseId;
  if (db !== configuredDatabaseId) throw new Error('Cloud database does not match deployment');
  const s3 = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, maxAttempts: 3,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  async function query(sql, params = []) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${d1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok || !data.success || data.result?.some(r => r.success === false)) throw new Error(`D1 query rejected (${response.status})`);
    return data.result.flatMap(r => r.results || []);
  }
  async function head(key) {
    if (!/^assets\/[a-f0-9-]{36}\/(?:data\.bin|720p\.mp4|1080p\.mp4)$/.test(key || '')) return null;
    try { return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(30000) }); }
    catch (e) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  return { s3, bucket, query, head };
}
const validVideo = object => object?.ContentLength > 0 && ['video/mp4', 'application/octet-stream'].includes(object.ContentType);
export async function saveManifest(plan) {
  await mkdir('tmp', { recursive: true });
  await writeFile(`${manifestPath}.next`, JSON.stringify(plan, null, 2));
  await rename(`${manifestPath}.next`, manifestPath);
}
async function markMovieRetryPending(ctx, id, error) {
  const message = safeLogError(error).slice(0, 1000);
  try {
    await ctx.query("UPDATE movies SET ingest_status = ?, transfer_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND publication_status IN ('draft','published')", ['retry_pending', message, id]);
    return true;
  } catch (updateError) {
    console.error(JSON.stringify({ event: 'movie-status-update-failed', id, status: 'retry_pending', error: safeLogError(updateError) }));
    return false;
  }
}
export async function makePlan(ctx, options = {}) {
  const maxMovies = options.maxMovies ?? DEFAULT_MAX_MOVIES;
  if (!Number.isSafeInteger(maxMovies) || maxMovies < 1 || maxMovies > 20) throw new Error('Invalid maxMovies');
  const rows = await ctx.query("SELECT id,imdb_id,download_sources_json,r2_storage_key,r2_video_bytes FROM movies WHERE publication_status IN ('draft','published') ORDER BY CASE WHEN ingest_status IN ('queued','processing','retry_pending','half','transferring') THEN 0 WHEN ingest_status = 'ready' THEN 2 ELSE 1 END, id LIMIT ?", [maxMovies]);
  const plan = { schema: 'flixlyra-cloud-v1', files: [], failures: [], createdAt: new Date().toISOString() };
  for (const row of rows) {
    const movieItems = [];
    try {
      for (const quality of ['720p','1080p']) {
        const source = sourcesOf(row.download_sources_json).find(s => (s.quality || s.resolution)?.toLowerCase() === quality);
        const mapped = source?.r2StorageKey || source?.r2_storage_key;
        // A legacy primary is not assigned a quality by guesswork.
        const key = mapped || stableKey(row.id, quality);
        const object = await ctx.head(key);
        const verified = validVideo(object) && (!source?.r2Bytes || Number(source.r2Bytes) === object.ContentLength);
        movieItems.push({ id: row.id, imdbId: row.imdb_id, quality, key, bytes: verified ? object.ContentLength : null,
          file: null, verified });
      }
      plan.files.push(...movieItems);
    } catch (error) {
      const message = safeLogError(error);
      plan.failures.push({ id: row.id, imdbId: row.imdb_id, status: 'retry_pending', error: message });
      console.error(JSON.stringify({ event: 'movie-plan-failed', id: row.id, imdbId: row.imdb_id, status: 'retry_pending', error: message }));
      await markMovieRetryPending(ctx, row.id, error);
    }
  }
  return plan;
}
async function acquire(ctx, item, attempt) {
  const [row] = await ctx.query('SELECT download_sources_json FROM movies WHERE id = ?', [item.id]);
  if (!row) throw new Error('Movie no longer exists');
  const source = sourcesOf(row.download_sources_json).find(s => (s.quality || s.resolution)?.toLowerCase() === item.quality);
  let descriptor;
  if (attempt > 1 || !source) descriptor = await alternativeDescriptor(item.imdbId, item.quality, source?.url);
  if (!descriptor) descriptor = sourceMagnet(row.download_sources_json, item.quality);
  if (!descriptor && /^(?:assets|descriptors)\/[\w.-]+\.(?:torrent|bin)$/.test(source?.descriptorKey || '')) {
    const object = await ctx.s3.send(new GetObjectCommand({ Bucket: ctx.bucket, Key: source.descriptorKey }), { abortSignal: AbortSignal.timeout(30000) });
    if (!object.ContentLength || object.ContentLength > 2097152) { object.Body?.destroy(); throw new Error('Invalid descriptor size'); }
    descriptor = Buffer.from(await object.Body.transformToByteArray());
  }
  if (!descriptor) descriptor = await remoteDescriptor(row.download_sources_json, item.quality);
  const work = resolve(mediaRoot, `${item.id}-${item.quality}`);
  await mkdir(work, { recursive: true });
  const filePath = resolve(work, `${item.quality}.mp4`);
  const WebTorrent = await loadGuardedWebTorrent();
  const client = new WebTorrent({ webSeeds: false, maxConns: 30, uploadLimit: 131072 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Acquisition timed out')), 20 * 60000);
  try {
    const torrent = await new Promise((done, reject) => {
      const onError = e => { controller.abort(e); reject(e); };
      client.on('error', onError);
      const pending = client.add(descriptor, { path: resolve(work, 'pieces'), deselect: true, strategy: 'sequential', storeCacheSlots: 2 }, done);
      pending.on('error', onError);
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const file = primaryMp4(torrent.files);
    if (!file || torrent.pieceLength > 16 * 1024 * 1024) throw new Error('No safe playable MP4 in source');
    const disk = await statfs(work);
    if (torrent.length + file.length + 2 * 1024 ** 3 > disk.bavail * disk.bsize) throw new Error('Insufficient runner disk for this video');
    torrent.deselect(0, torrent.pieces.length - 1, false);
    file.select();
    await pipeline(uploadStream(progressStream(file.createReadStream(), item, file.length)), createWriteStream(filePath), { signal: controller.signal });
    const info = await stat(filePath);
    const probe = Buffer.alloc(Math.min(64 * 1024, info.size));
    const probeHandle = await open(filePath, 'r');
    let bytesRead = 0;
    try { ({ bytesRead } = await probeHandle.read(probe, 0, probe.length, 0)); } finally { await probeHandle.close(); }
    const ftypOffset = probe.subarray(0, bytesRead).indexOf(Buffer.from('ftyp'));
    if (info.size !== file.length || ftypOffset < 4) throw new Error('MP4 validation failed');
    item.file = filePath; item.bytes = file.length;
  } finally {
    clearTimeout(timer);
    await new Promise(done => client.destroy(done));
    await rm(resolve(work, 'pieces'), { recursive: true, force: true });
    if (!item.file) await rm(work, { recursive: true, force: true });
  }
}
async function markSkipped(plan, item, persist, reason = 'download-failure') {
  item.file = null;
  item.bytes = null;
  item.skipped = true;
  item.skipReason = reason;
  await persist(plan);
}
function failureState(plan, id) {
  const present = new Set((plan?.files || [])
    .filter(item => item.id === id && (item.verified || item.file))
    .map(item => item.quality));
  const missing = ['720p', '1080p'].filter(quality => !present.has(quality));
  if (present.size === 1 && missing.length === 1) {
    return {
      status: 'HALF',
      ingestStatus: 'half',
      error: `Missing ${missing[0]}: Dead stream / 404`,
    };
  }
  return { status: 'FAILED', ingestStatus: 'failed', error: 'Dead stream / 404' };
}
export async function markPermanentlyFailed(ctx, ids, plan) {
  let marked = 0;
  let half = 0;
  const isTransient = (error) => /fetch failed|network|timeout|timed out|ECONN|ETIMEDOUT|429|5\d\d/i.test(String(error?.message || error));
  const queryWithRetry = async (sql, params) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ctx.query(sql, params);
        return true;
      } catch (error) {
        lastError = error;
        if (!isTransient(error) || attempt === 3) break;
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
    throw lastError;
  };
  for (const id of new Set(ids)) {
    const state = failureState(plan, id);
    const primarySql = `UPDATE movies SET status = '${state.status}', sync_error = ?, ingest_status = '${state.ingestStatus}', transfer_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
    const compatibilitySql = state.status === 'FAILED'
      ? "UPDATE movies SET ingest_status = 'failed', transfer_error = 'Dead stream / 404', updated_at = ? WHERE id = ?"
      : "UPDATE movies SET ingest_status = ?, transfer_error = ?, updated_at = ? WHERE id = ?";
    try {
      await queryWithRetry(primarySql, [state.error, state.error, id]);
      marked += 1;
      if (state.status === 'HALF') half += 1;
    } catch {
      try {
        const compatibilityParams = state.status === 'FAILED'
          ? [new Date().toISOString(), id]
          : [state.ingestStatus, state.error, new Date().toISOString(), id];
        await queryWithRetry(compatibilitySql, compatibilityParams);
        marked += 1;
        if (state.status === 'HALF') half += 1;
      } catch (error) {
        console.error(`⚠️ Could not mark Movie ${id} as FAILED in D1: ${safeLogError(error)}`);
      }
    }
  }
  console.log(`❌ Marked ${marked} movies as FAILED in D1 Database.`);
  if (half) console.log(`⚠️ Marked ${half} movies as HALF (one quality missing) in D1 Database.`);
  return marked;
}
async function acquireWithRetries(ctx, plan, item, maxAttempts, options) {
  const acquireItem = options.acquire || acquire;
  const persist = options.saveManifest || saveManifest;
  const wait = options.pause || pause;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await acquireItem(ctx, item, attempt);
      await persist(plan);
      return true;
    } catch (error) {
      const message = safeLogError(error);
      if (isNonRetryableValidationError(error)) {
        item.nonRetryableFailure = true;
        item.failureReason = message;
        console.warn(JSON.stringify({ event: 'acquisition-validation-failure', id: item.id, quality: item.quality, attempt, retryable: false, error: message }));
        return false;
      }
      console.warn(JSON.stringify({ event: 'acquisition-retry', id: item.id, quality: item.quality, attempt, error: message }));
      if (attempt < maxAttempts) {
        console.warn(`🔁 [Movie ID: ${item.id}] Retrying acquisition (Attempt ${attempt + 1}/${maxAttempts})...`);
        await wait(5000 * 2 ** (attempt - 1));
      }
    }
  }
  return false;
}
export async function prepareOne(ctx, plan, options = {}) {
  const persist = options.saveManifest || saveManifest;
  for (const item of plan.files.filter(f => !f.verified && !f.skipped && !f.file)) {
    try {
      if (await acquireWithRetries(ctx, plan, item, 3, options)) return item;
      if (!item.nonRetryableFailure) console.warn(`⚠️ Pass 1 failed for Movie ${item.id}. Queuing for final retry pass.`);
      if (item.nonRetryableFailure) await markMovieRetryPending(ctx, item.id, item.failureReason);
      await markSkipped(plan, item, persist, item.nonRetryableFailure ? 'validation-failure' : 'download-failure');
    } catch (error) {
      console.error(JSON.stringify({ event: 'movie-preparation-failed', id: item.id, quality: item.quality, error: safeLogError(error) }));
      await markSkipped(plan, item, persist, 'download-failure');
    }
  }
  return null;
}
export async function prepareAll(ctx, plan, options = {}) {
  const persist = options.saveManifest || saveManifest;
  const failedQueue = [];
  const permanentlyFailedIds = [];
  let prepared = 0;
  const pending = plan.files.filter(f => !f.verified && !f.skipped && !f.file);
  for (const item of pending) {
    try {
      if (await acquireWithRetries(ctx, plan, item, 3, options)) prepared += 1;
      else if (item.nonRetryableFailure) {
        console.warn(`⚠️ Skipping Movie ${item.id} ${item.quality} after non-retryable MP4 validation failure.`);
        await markMovieRetryPending(ctx, item.id, item.failureReason);
        await markSkipped(plan, item, persist, 'validation-failure');
        if (!permanentlyFailedIds.includes(item.id)) permanentlyFailedIds.push(item.id);
      } else {
        console.warn(`⚠️ Pass 1 failed for Movie ${item.id}. Queuing for final retry pass.`);
        failedQueue.push(item);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'movie-preparation-failed', id: item.id, quality: item.quality, error: safeLogError(error) }));
      console.warn(`⚠️ Pass 1 failed for Movie ${item.id}. Queuing for final retry pass.`);
      failedQueue.push(item);
    }
  }
  if (failedQueue.length) {
    console.log(`Starting Second-Chance Retry Pass for ${failedQueue.length} skipped movies...`);
    for (const item of failedQueue) {
      try {
        delete item.skipped;
        delete item.skipReason;
        const acquireItem = options.acquire || acquire;
        await acquireItem(ctx, item, 4);
        await persist(plan);
        prepared += 1;
      } catch (error) {
        console.error(JSON.stringify({ event: 'movie-preparation-permanently-skipped', id: item.id, quality: item.quality, error: safeLogError(error) }));
        console.error(`❌ Permanently skipping Movie ${item.id} (Unresolvable dead stream).`);
        if (!permanentlyFailedIds.includes(item.id)) permanentlyFailedIds.push(item.id);
        await markSkipped(plan, item, persist);
      }
    }
  }
  const markedFailed = await markPermanentlyFailed(ctx, permanentlyFailedIds, plan);
  await persist(plan);
  return { prepared, skipped: plan.files.filter(f => f.skipped).length, permanentlyFailedIds, markedFailed };
}
export async function commitItem(ctx, item) {
  const object = await ctx.head(item.key);
  if (!validVideo(object) || object.ContentLength !== item.bytes) throw new Error('R2 verification failed before D1 commit');
  const [row] = await ctx.query('SELECT download_sources_json, revision FROM movies WHERE id = ?', [item.id]);
  const sources = sourcesOf(row.download_sources_json);
  const existing = sources.find(s => (s.quality || s.resolution)?.toLowerCase() === item.quality);
  const updated = { ...existing, quality: item.quality, resolution: item.quality, r2StorageKey: item.key, r2Bytes: item.bytes, size: `${(item.bytes / 1024 ** 3).toFixed(2)} GB` };
  const next = [...sources.filter(s => (s.quality || s.resolution)?.toLowerCase() !== item.quality), updated];
  let ready = true;
  for (const q of ['720p','1080p']) {
    const s = next.find(s => (s.quality || s.resolution)?.toLowerCase() === q);
    const h = await ctx.head(s?.r2StorageKey);
    if (!validVideo(h) || h.ContentLength !== s?.r2Bytes) ready = false;
  }
  const primary = next.find(s => s.quality === '1080p' && s.r2StorageKey) || updated;
  const result = await ctx.query("UPDATE movies SET download_sources_json=?,r2_storage_key=?,r2_video_bytes=?,ingest_status=?,transfer_error=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND publication_status IN ('draft','published') AND (transfer_token IS NULL OR transfer_lease_until < unixepoch()) RETURNING id", [JSON.stringify({ status: ready ? 'available' : 'pending', sources: next }), primary.r2StorageKey, primary.r2Bytes, ready ? 'ready' : 'processing', new Date().toISOString(), item.id, row.revision]);
  if (!result.length) throw new Error('D1 changed or another transfer owns the record; retry required');
}
export async function drainCloudPlan(plan, sync) {
  const ctx = await context();
  try {
    const reconciled = new Set();
    let consecutiveFailures = 0;
    while (true) {
      try {
        for (const item of plan.files) {
          if (item.verified && !reconciled.has(item.key)) { await commitItem(ctx, item); reconciled.add(item.key); }
        }
        const pending = plan.files.filter(f => !f.verified && !f.skipped);
        if (!pending.length) {
          const skippedIds = [...new Set(plan.files.filter(f => f.skipped).map(f => f.id))];
          if (skippedIds.length) {
            const marked = await markPermanentlyFailed(ctx, skippedIds, plan);
            if (marked !== skippedIds.length) throw new Error('Could not persist all permanent media failure states');
          }
          console.log('[complete] cloud snapshot verified in R2 and D1');
          return;
        }
        const item = pending.find(f => f.file) || await prepareOne(ctx, plan);
        if (!item) continue;
        await sync(item);
        await commitItem(ctx, item);
        item.verified = true;
        reconciled.add(item.key);
        if (item.file && resolve(item.file).startsWith(mediaRoot + sep)) await rm(dirname(item.file), { recursive: true, force: true });
        item.file = null;
        await saveManifest(plan);
        console.log(JSON.stringify({ event: 'verified', id: item.id, quality: item.quality, remaining: plan.files.filter(f => !f.verified).length }));
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const pending = plan.files.filter(f => !f.verified && !f.skipped);
        const pendingIds = [...new Set(pending.map(f => f.id))];
        console.warn(`⚠️ Remaining batch failed (${consecutiveFailures}/${MAX_RETRIES}): ${safeLogError(error)}`);
        if (consecutiveFailures >= MAX_RETRIES) {
          for (const item of pending) await markSkipped(plan, item, saveManifest);
          const marked = await markPermanentlyFailed(ctx, pendingIds, plan);
          await saveManifest(plan);
          console.error(`❌ MAX_RETRIES=${MAX_RETRIES} reached. Marked Movie IDs as failed: ${pendingIds.join(', ') || 'none'} (D1 marked: ${marked}).`);
          process.exitCode = 1;
          return;
        }
        console.log(`🔁 Retrying remaining batch (Attempt ${consecutiveFailures + 1}/${MAX_RETRIES})...`);
        await pause(10_000);
      }
    }
  } finally { ctx.s3.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ctx = await context();
  try {
    await mkdir(mediaRoot, { recursive: true });
    const maxMovies = maxMoviesFromArgs();
    const plan = await makePlan(ctx, { maxMovies });
    await saveManifest(plan);
    const result = await prepareAll(ctx, plan);
    console.log(JSON.stringify({ event: 'prepared', maxMovies, failedMovies: plan.failures.length, total: plan.files.length, verified: plan.files.filter(f => f.verified).length, ...result }));
  } finally { ctx.s3.destroy(); }
}

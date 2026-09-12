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
const pause = ms => new Promise(done => setTimeout(done, ms));
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
  for (const name of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME','CLOUDFLARE_API_TOKEN']) {
    if (!process.env[name]?.trim()) throw new Error(`Missing repository secret: ${name}`);
  }
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  if (account !== config.account_id || !config.r2_buckets.some(b => b.bucket_name === bucket)) throw new Error('Cloud account/bucket does not match deployment');
  const db = config.d1_databases.find(d => d.binding === 'DB').database_id;
  const s3 = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, maxAttempts: 3,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  async function query(sql, params = []) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
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
export async function makePlan(ctx) {
  const rows = await ctx.query("SELECT id,imdb_id,download_sources_json,r2_storage_key,r2_video_bytes FROM movies WHERE publication_status IN ('draft','published') ORDER BY id");
  const plan = { schema: 'flixlyra-cloud-v1', files: [], createdAt: new Date().toISOString() };
  for (const row of rows) for (const quality of ['720p','1080p']) {
    const source = sourcesOf(row.download_sources_json).find(s => (s.quality || s.resolution)?.toLowerCase() === quality);
    const mapped = source?.r2StorageKey || source?.r2_storage_key;
    // A legacy primary is not assigned a quality by guesswork.
    const key = mapped || stableKey(row.id, quality);
    const object = await ctx.head(key);
    const verified = validVideo(object) && (!source?.r2Bytes || Number(source.r2Bytes) === object.ContentLength);
    plan.files.push({ id: row.id, imdbId: row.imdb_id, quality, key, bytes: verified ? object.ContentLength : null,
      file: null, verified });
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
    await pipeline(uploadStream(file.createReadStream()), createWriteStream(filePath), { signal: controller.signal });
    const handle = await open(filePath, 'r');
    const header = Buffer.alloc(12);
    try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
    if (header.subarray(4, 8).toString() !== 'ftyp' || (await stat(filePath)).size !== file.length) throw new Error('MP4 validation failed');
    item.file = filePath; item.bytes = file.length;
  } finally {
    clearTimeout(timer);
    await new Promise(done => client.destroy(done));
    await rm(resolve(work, 'pieces'), { recursive: true, force: true });
    if (!item.file) await rm(work, { recursive: true, force: true });
  }
}
async function markSkipped(plan, item, persist) {
  item.file = null;
  item.bytes = null;
  item.skipped = true;
  item.skipReason = 'download-failure';
  await persist(plan);
}
export async function markPermanentlyFailed(ctx, ids) {
  let marked = 0;
  for (const id of [...new Set(ids)]) {
    try {
      await ctx.query("UPDATE movies SET status = 'FAILED', sync_error = 'Dead stream / 404', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
      marked += 1;
    } catch {
      try {
        await ctx.query("UPDATE movies SET ingest_status = 'failed', transfer_error = 'Dead stream / 404', updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
        marked += 1;
      } catch (error) {
        console.error(`⚠️ Could not mark Movie ${id} as FAILED in D1: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  console.log(`❌ Marked ${marked} movies as FAILED in D1 Database.`);
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
    } catch {
      console.warn(JSON.stringify({ event: 'acquisition-retry', id: item.id, quality: item.quality, attempt }));
      if (attempt < maxAttempts) await wait(5000 * 2 ** (attempt - 1));
    }
  }
  return false;
}
export async function prepareOne(ctx, plan, options = {}) {
  const persist = options.saveManifest || saveManifest;
  for (const item of plan.files.filter(f => !f.verified && !f.skipped && !f.file)) {
    try {
      if (await acquireWithRetries(ctx, plan, item, 3, options)) return item;
      console.warn(`⚠️ Pass 1 failed for Movie ${item.id}. Queuing for final retry pass.`);
      await markSkipped(plan, item, persist);
    } catch {
      await markSkipped(plan, item, persist);
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
      else {
        console.warn(`⚠️ Pass 1 failed for Movie ${item.id}. Queuing for final retry pass.`);
        failedQueue.push(item);
      }
    } catch {
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
      } catch {
        console.error(`❌ Permanently skipping Movie ${item.id} (Unresolvable dead stream).`);
        if (!permanentlyFailedIds.includes(item.id)) permanentlyFailedIds.push(item.id);
        await markSkipped(plan, item, persist);
      }
    }
  }
  const markedFailed = await markPermanentlyFailed(ctx, permanentlyFailedIds);
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
    while (true) {
      try {
      for (const item of plan.files) {
        if (item.verified && !reconciled.has(item.key)) { await commitItem(ctx, item); reconciled.add(item.key); }
      }
      let pending = plan.files.filter(f => !f.verified && !f.skipped);
      if (!pending.length) { console.log('[complete] cloud snapshot verified in R2 and D1'); return; }
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
      } catch { console.warn('Auto-re-attempting remaining batch...'); await pause(10000); }
    }
  } finally { ctx.s3.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const ctx = await context();
  try {
    await mkdir(mediaRoot, { recursive: true });
    const plan = await makePlan(ctx);
    await saveManifest(plan);
    const result = await prepareAll(ctx, plan);
    console.log(JSON.stringify({ event: 'prepared', total: plan.files.length, verified: plan.files.filter(f => f.verified).length, ...result }));
  } finally { ctx.s3.destroy(); }
}

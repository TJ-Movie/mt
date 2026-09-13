import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs, { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, statfs, stat, open } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { loadGuardedWebTorrent } from './webtorrent-guard.mjs';
import { primaryMp4, sourceMagnet, remoteDescriptor, alternativeDescriptor } from './magnet-to-r2.mjs';

export const manifestPath = 'tmp/r2-video-manifest.json';
const mediaRoot = resolve('tmp/media');
const MAX_RETRIES = 5;
const DEFAULT_MAX_MOVIES = 2;
const YTS_ENDPOINT = 'https://movies-api.accel.li/api/v2/movie_details.json';
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;
const ARTWORK_CONCURRENCY = 4;
const execFileAsync = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
const activeTimers = new Set();
const activeTorrentClients = new Set();

async function destroyTorrentClient(client) {
  if (!activeTorrentClients.delete(client)) return;
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 5000);
    timeout.unref?.();
    try {
      client.destroy(finish);
    } catch {
      finish();
    }
  });
}

async function cleanupRuntime() {
  for (const timer of activeTimers) clearTimeout(timer);
  activeTimers.clear();
  await Promise.all([...activeTorrentClients].map(client => destroyTorrentClient(client)));
}

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

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function artworkUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const allowedHost = hostname === 'image.tmdb.org' || hostname === 'yts.mx' || hostname.endsWith('.yts.mx') ||
      hostname === 'yts.lt' || hostname.endsWith('.yts.lt') || hostname === 'yts.am' || hostname.endsWith('.yts.am') ||
      hostname === 'yts.rs' || hostname.endsWith('.yts.rs') || hostname === 'yts.pm' || hostname.endsWith('.yts.pm');
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowedHost ? url.toString() : null;
  } catch { return null; }
}

function publicArtworkUrl(key) {
  const base = (process.env.R2_PUBLIC_BASE_URL || 'https://flixlyra.com/media').replace(/\/+$/, '');
  return `${base}/${key}`;
}

function artworkKey(movieId, kind) {
  if (!Number.isSafeInteger(Number(movieId)) || Number(movieId) < 1 || !['poster', 'backdrop'].includes(kind)) return null;
  return `artworks/${Number(movieId)}/${kind}.jpg`;
}

function isManagedArtworkUrl(value, movieId, kind) {
  const key = artworkKey(movieId, kind);
  if (!key || typeof value !== 'string') return false;
  const expected = publicArtworkUrl(key);
  if (value === expected || value === `/media/${key}`) return true;
  try {
    const current = new URL(value);
    const target = new URL(expected);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch { return false; }
}

async function downloadArtwork(url) {
  const source = artworkUrl(url);
  if (!source) return null;
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`ARTWORK_${response.status}`);
  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)) throw new Error('ARTWORK_UNSUPPORTED_CONTENT_TYPE');
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_ARTWORK_BYTES) throw new Error('ARTWORK_TOO_LARGE');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > MAX_ARTWORK_BYTES) throw new Error('ARTWORK_EMPTY_OR_TOO_LARGE');
  return { bytes, contentType };
}

async function fetchArtworkMetadata(imdbId) {
  if (!/^tt\d{7,10}$/.test(String(imdbId || ''))) return null;
  try {
    const response = await fetch(`${YTS_ENDPOINT}?imdb_id=${encodeURIComponent(imdbId)}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`YTS_ARTWORK_${response.status}`);
    const payload = await response.json();
    return isRecord(payload?.data?.movie) ? payload.data.movie : null;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'artwork-metadata-warning', imdbId, error: safeLogError(error) }));
    return null;
  }
}

async function syncArtworkForMovie(ctx, row) {
  const updates = {};
  let metadata;
  let metadataLoaded = false;
  const getMetadata = async () => {
    if (!metadataLoaded) {
      metadataLoaded = true;
      metadata = await fetchArtworkMetadata(row.imdb_id);
    }
    return metadata;
  };

  for (const kind of ['poster', 'backdrop']) {
    const key = artworkKey(row.id, kind);
    if (!key) continue;
    try {
      const existing = await ctx.headArtwork(key);
      if (existing && Number(existing.ContentLength) > 0 && String(existing.ContentType || '').startsWith('image/')) {
        if (!isManagedArtworkUrl(row[kind], row.id, kind)) updates[kind] = publicArtworkUrl(key);
        continue;
      }

      const current = artworkUrl(row[kind]);
      const fields = kind === 'poster'
        ? ['large_cover_image', 'medium_cover_image']
        : ['background_image_original', 'background_image'];
      const sources = [];
      if (current) sources.push(current);
      const yts = current ? null : await getMetadata();
      for (const field of fields) {
        const source = artworkUrl(yts?.[field]);
        if (source && !sources.includes(source)) sources.push(source);
      }
      if (!sources.length) {
        console.warn(JSON.stringify({ event: 'artwork-source-missing', id: row.id, imdbId: row.imdb_id, kind }));
        continue;
      }

      let uploaded = false;
      for (const source of sources) {
        try {
          const downloaded = await downloadArtwork(source);
          if (!downloaded) continue;
          await ctx.s3.send(new PutObjectCommand({
            Bucket: ctx.bucket,
            Key: key,
            Body: downloaded.bytes,
            ContentType: downloaded.contentType,
            CacheControl: 'public, max-age=31536000, immutable',
            Metadata: { source: 'yts-artwork', movieId: String(row.id), kind },
          }));
          const verified = await ctx.headArtwork(key);
          if (!verified || Number(verified.ContentLength) !== downloaded.bytes.byteLength) throw new Error('ARTWORK_R2_VERIFY_FAILED');
          updates[kind] = publicArtworkUrl(key);
          uploaded = true;
          break;
        } catch (error) {
          console.warn(JSON.stringify({ event: 'artwork-upload-warning', id: row.id, imdbId: row.imdb_id, kind, error: safeLogError(error) }));
        }
      }
      if (!uploaded) console.warn(JSON.stringify({ event: 'artwork-unavailable', id: row.id, imdbId: row.imdb_id, kind }));
    } catch (error) {
      console.warn(JSON.stringify({ event: 'artwork-sync-warning', id: row.id, imdbId: row.imdb_id, kind, error: safeLogError(error) }));
    }
  }

  const fields = Object.keys(updates);
  if (fields.length) {
    const assignments = fields.map((field) => `${field} = ?`);
    await ctx.query(`UPDATE movies SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...fields.map((field) => updates[field]), row.id]);
  }
  return { id: row.id, synced: fields };
}

async function syncAllArtwork(ctx) {
  const rows = await ctx.query("SELECT id, imdb_id, poster, backdrop FROM movies WHERE publication_status <> 'archived' ORDER BY id");
  let cursor = 0;
  const results = [];
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      try { results.push(await syncArtworkForMovie(ctx, row)); }
      catch (error) { console.warn(JSON.stringify({ event: 'artwork-movie-warning', id: row.id, error: safeLogError(error) })); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ARTWORK_CONCURRENCY, rows.length) }, worker));
  const synced = results.filter((result) => result.synced.length > 0).length;
  console.log(JSON.stringify({ event: 'artwork-sync-complete', scanned: rows.length, updated: synced, fields: results.reduce((total, result) => total + result.synced.length, 0) }));
  return { scanned: rows.length, updated: synced };
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

async function readProbeWindow(filePath, position, length) {
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, 'r');
  try {
    const result = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export async function validateMp4(filePath, expectedBytes) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error('MP4 validation failed: empty file');

  // YTS files may place moov at EOF. Inspect both ends and do not require an
  // exact byte count because a completed WebTorrent stream can expose a
  // slightly different filesystem size while still being a valid container.
  const windowSize = Math.min(1024 * 1024, info.size);
  const head = await readProbeWindow(filePath, 0, windowSize);
  const tail = info.size > windowSize ? await readProbeWindow(filePath, info.size - windowSize, windowSize) : head;
  const hasContainerAtom = [head, tail].some(window =>
    ['ftyp', 'moov', 'moof'].some(atom => window.includes(Buffer.from(atom)))
  );
  if (!hasContainerAtom) throw new Error('MP4 validation failed: container is unparseable');

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', filePath,
    ], { timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true });
    const streams = JSON.parse(stdout).streams || [];
    const zeroDuration = streams
      .filter(stream => stream.codec_type === 'video' || stream.codec_type === 'audio')
      .some(stream => Number.isFinite(Number(stream.duration)) && Number(stream.duration) <= 0);
    if (zeroDuration) throw new Error('MP4 validation failed: zero-duration video/audio stream');
  } catch (error) {
    if (error?.message?.includes('zero-duration video/audio stream')) throw error;
    if (error?.code !== 'ENOENT') {
      console.warn(JSON.stringify({ event: 'mp4-probe-warning', file: filePath, error: safeLogError(error) }));
    }
  }

  return { bytes: info.size, expectedBytes };
}

function progressStream(item, totalBytes) {
  let downloaded = 0;
  let nextPercent = 10;
  let lastLoggedAt = 0;
  const startedAt = Date.now();
  const progressPassThrough = new PassThrough();
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
  // Observe the intermediate PassThrough only. Attaching a data listener to
  // WebTorrent's raw stream can put it into flowing mode before pipeline()
  // attaches its destination, which may drain chunks before they reach disk.
  progressPassThrough.on('data', chunk => {
    downloaded += chunk.byteLength ?? chunk.length ?? 0;
    report();
  });
  progressPassThrough.on('end', () => report(true));
  return progressPassThrough;
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
  async function headArtwork(key) {
    if (!/^artworks\/\d+\/(?:poster|backdrop)\.jpg$/.test(key || '')) return null;
    try { return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(30000) }); }
    catch (e) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  return { s3, bucket, query, head, headArtwork };
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
  activeTorrentClients.add(client);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Acquisition timed out')), 20 * 60000);
  activeTimers.add(timer);
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
    const readStream = file.createReadStream();
    const progressPassThrough = progressStream(item, file.length);
    await pipeline(readStream, progressPassThrough, createWriteStream(filePath), { signal: controller.signal });
    const written = fs.statSync(filePath);
    if (!written.isFile() || written.size <= 10 * 1024 * 1024) {
      throw new Error('NEW_FILE_ZERO_BYTES_OR_CORRUPT');
    }
    const validated = await validateMp4(filePath, file.length);
    item.file = filePath; item.bytes = validated.bytes;
  } finally {
    clearTimeout(timer);
    activeTimers.delete(timer);
    await destroyTorrentClient(client);
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
  let ctx;
  let summary;
  let fatalError;
  try {
    ctx = await context();
    await mkdir(mediaRoot, { recursive: true });
    let artwork = { scanned: 0, updated: 0 };
    try { artwork = await syncAllArtwork(ctx); }
    catch (error) { console.warn(JSON.stringify({ event: 'artwork-backfill-warning', error: safeLogError(error) })); }
    const maxMovies = maxMoviesFromArgs();
    const plan = await makePlan(ctx, { maxMovies });
    await saveManifest(plan);
    const result = await prepareAll(ctx, plan);
    summary = { event: 'prepared', maxMovies, artwork, failedMovies: plan.failures.length, total: plan.files.length, verified: plan.files.filter(f => f.verified).length, ...result };
  } catch (error) {
    fatalError = error;
  } finally {
    await cleanupRuntime();
    ctx?.s3.destroy();
  }
  if (fatalError) {
    console.error(JSON.stringify({ event: 'prepare-fatal-error', error: safeLogError(fatalError) }));
    process.exit(1);
  }
  console.log(JSON.stringify(summary));
  process.exit(0);
}

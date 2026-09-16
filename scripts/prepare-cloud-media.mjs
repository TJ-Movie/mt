import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs, { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, statfs, stat, open } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { loadGuardedWebTorrent } from './webtorrent-guard.mjs';
import { primaryMp4, sourceMagnet, remoteDescriptor, alternativeDescriptor } from './magnet-to-r2.mjs';
import { claimTransfer, diagnoseStaleTransfers, releaseTransfer, assertLegalTransition } from './ingest-state.mjs';

export const manifestPath = 'tmp/r2-video-manifest.json';
const mediaRoot = resolve('tmp/media');
const MAX_RETRIES = 5;
const DEFAULT_MAX_MOVIES = 30;
const DEFAULT_METADATA_TIMEOUT_MS = 90_000;
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 120_000;
const FILTER_MOVIE_IDS = new Set((process.env.TRANSFER_MOVIE_IDS || '').split(',').map(value => Number(value.trim())).filter(value => Number.isSafeInteger(value) && value > 0));
const FILTER_QUALITY = /^(720p|1080p)$/.test(process.env.TRANSFER_QUALITY || '') ? process.env.TRANSFER_QUALITY : null;
const YTS_ENDPOINT = 'https://movies-api.accel.li/api/v2/movie_details.json';
const YTS_FALLBACK_ENDPOINT = 'https://yts.mx/api/v2/movie_details.json';
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;
const ARTWORK_CONCURRENCY = 4;
// Two active movie jobs keeps two torrent piece stores and writers bounded on the GitHub runner.
export const MEDIA_CONCURRENCY = 2;
const execFileAsync = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
const siteOrigin = (process.env.PUBLIC_SITE_ORIGIN || 'https://flixlyra.com').replace(/\/+$/, '');
let nextRequestAt = 0;
async function throttleRequests() { const slot = Math.max(Date.now(), nextRequestAt); nextRequestAt = slot + 300; const delay = slot - Date.now(); if (delay > 0) await pause(delay); }
const requestTimeoutMs = 10000;
const maxRequestAttempts = 3;
async function fetchWithRetry(url, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRequestAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), requestTimeoutMs);
    try {
      await throttleRequests();
      const response = await fetch(url, { ...init, signal: controller.signal });
      if ((response.status !== 429 && response.status < 500) || attempt === maxRequestAttempts) return response;
      await response.body?.cancel().catch(() => {});
      await pause(response.status === 429 ? 2000 : 500 * 2 ** (attempt - 1));
    } catch (error) {
      lastError = error;
      if (attempt === maxRequestAttempts) throw error;
      await pause(500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('request failed');
}
async function sendWithRetry(client, command, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRequestAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('R2 request timeout')), requestTimeoutMs);
    try {
      return await client.send(command, { ...options, abortSignal: controller.signal });
    } catch (error) {
      lastError = error;
      const status = error?.$metadata?.httpStatusCode;
      if (attempt === maxRequestAttempts || (status && status < 500 && status !== 429)) throw error;
      await pause(status === 429 ? 2000 : 500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('R2 request failed');
}
const activeTimers = new Set();
const activeTorrentClients = new Set();
function handleAsyncTorrentFailure(reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(JSON.stringify({ event: 'uncaught-media-error', error: safeLogError(error) }));
  process.exitCode = 1;
}
process.on('uncaughtException', handleAsyncTorrentFailure);
process.on('unhandledRejection', handleAsyncTorrentFailure);

function destroyClientResource(client) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 5000);
    timeout.unref?.();
    if (!client?.destroy) {
      finish();
      return;
    }
    try {
      client.destroy(finish);
    } catch {
      finish();
    }
  });
}
async function destroyTorrentClient(client) {
  if (!activeTorrentClients.delete(client)) return;
  await destroyClientResource(client);
}

function awaitWithAbort(operation, signal, onLateValue) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const operationPromise = Promise.resolve().then(operation);
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      operationPromise.then(value => Promise.resolve(onLateValue?.(value)).catch(() => {}), () => {});
      reject(signal.reason || new Error('Operation aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    operationPromise.then(value => {
      if (settled) {
        Promise.resolve(onLateValue?.(value)).catch(() => {});
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}async function cleanupRuntime() {
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


export class MediaAcquisitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MediaAcquisitionError';
    this.code = code;
    Object.assign(this, details);
  }
}

function mediaFailureCode(error) {
  if (error?.code && /^(METADATA_TIMEOUT|NO_PEERS|ZERO_BYTE_STALL|DOWNLOAD_STALLED|SOURCE_INVALID)$/.test(error.code)) return error.code;
  const message = safeLogError(error);
  if (/metadata.*timeout|torrent.*metadata/i.test(message)) return 'METADATA_TIMEOUT';
  if (/no peers|no seed/i.test(message)) return 'NO_PEERS';
  if (/download.*timeout|timed out|ETIMEDOUT/i.test(message)) return 'DOWNLOAD_STALLED';
  if (/No safe playable MP4|MP4 validation|container|descriptor|unsupported|source|404|unavailable/i.test(message)) return 'SOURCE_INVALID';
  return null;
}

function acquisitionEvent(item, state, event, extra = {}) {
  console.log(JSON.stringify({
    event, movie_id: Number(item.id), quality: item.quality, info_hash: state.infoHash,
    expected_bytes: state.expectedBytes, metadata_received: state.metadataReceived,
    tracker_event: state.trackerEvent, peer_count: state.peerCount, payload_bytes: state.payloadBytes,
    last_progress_at: state.lastProgressAt, failure_code: state.failureCode,
    elapsed_ms: Date.now() - state.startedAt, ...extra,
  }));
}

function qualityWorkflowEvent(item, event, extra = {}) {
  const state = item.mediaDiagnostics || {};
  console.log(JSON.stringify({
    event, movie_id: Number(item.id), quality: item.quality, info_hash: state.infoHash || null,
    expected_bytes: state.expectedBytes ?? item.bytes ?? null, metadata_received: state.metadataReceived ?? null,
    tracker_event: state.trackerEvent || null, peer_count: state.peerCount ?? null,
    payload_bytes: state.payloadBytes ?? null, last_progress_at: state.lastProgressAt || null,
    failure_code: state.failureCode || null, elapsed_ms: state.startedAt ? Date.now() - state.startedAt : null, ...extra,
  }));
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
  const response = await fetchWithRetry(source, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
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
  const query = new URLSearchParams({ imdb_id: String(imdbId), with_images: 'true', with_cast: 'true' });
  let lastError;
  for (const endpoint of [YTS_ENDPOINT, YTS_FALLBACK_ENDPOINT]) {
    try {
      const response = await fetchWithRetry(`${endpoint}?${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`YTS_ARTWORK_${response.status}`);
      const payload = await response.json();
      const movie = isRecord(payload?.data?.movie) ? payload.data.movie : null;
      if (movie) return movie;
      throw new Error('YTS_ARTWORK_INVALID_RESPONSE');
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(JSON.stringify({ event: 'artwork-metadata-warning', imdbId, error: safeLogError(lastError || new Error('YTS_ARTWORK_UNAVAILABLE')) }));
  return null;
}

function metadataText(value, maximum) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, maximum) : '';
}

function metadataRuntime(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const wholeMinutes = Math.floor(minutes);
  return `${Math.floor(wholeMinutes / 60)}h ${wholeMinutes % 60}m`;
}

function metadataTrailer(value) {
  const code = metadataText(value, 64);
  return /^[A-Za-z0-9_-]{11}$/.test(code) ? `https://www.youtube.com/watch?v=${code}` : '';
}

function metadataDirector(value) {
  if (typeof value === 'string') return metadataText(value, 160);
  if (!Array.isArray(value)) return '';
  return value.map((entry) => isRecord(entry) ? entry.name || entry.director : entry)
    .map((entry) => metadataText(entry, 160)).filter(Boolean).slice(0, 3).join(', ');
}

function metadataGenres(value) {
  if (!Array.isArray(value)) return '';
  const aliases = { 'science fiction': 'Sci-Fi', 'sci-fi': 'Sci-Fi' };
  return [...new Set(value.map((entry) => metadataText(entry, 40))
    .filter(Boolean)
    .map((entry) => aliases[entry.toLowerCase()] || entry))].slice(0, 8).join(', ').slice(0, 200);
}

function metadataCast(value) {
  if (!Array.isArray(value)) return [];
  const cast = [];
  for (const entry of value.slice(0, 6)) {
    if (typeof entry === 'string') {
      const actor = metadataText(entry, 120);
      if (actor) cast.push(actor);
      continue;
    }
    if (!isRecord(entry)) continue;
    const actor = metadataText(entry.name || entry.actor, 120);
    if (!actor) continue;
    const character = metadataText(entry.character_name || entry.character, 120);
    const image = artworkUrl(entry.url_small_image || entry.image);
    cast.push({ actor, ...(character ? { character } : {}), ...(image ? { image } : {}) });
  }
  return cast;
}

function parsedArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function isBlankOrPending(value) {
  return !metadataText(value, 500) || /pending editorial review/i.test(String(value));
}

function metadataUpdatesForMovie(row, metadata) {
  if (!metadata) return {};
  const updates = {};
  const title = metadataText(metadata.title, 200);
  const description = metadataText(metadata.description_full || metadata.description_intro, 5000);
  const year = Number(metadata.year);
  const runtime = metadataRuntime(metadata.runtime);
  const rating = Number(metadata.rating);
  const genre = metadataGenres(metadata.genres);
  const director = metadataDirector(metadata.director);
  const cast = metadataCast(metadata.cast);
  const language = metadataText(metadata.language, 40);
  const trailer = metadataTrailer(metadata.yt_trailer_code);

  if (isBlankOrPending(row.title) && title) updates.title = title;
  if (isBlankOrPending(row.description) && description) updates.description = description;
  if ((!Number.isInteger(Number(row.release_year)) || Number(row.release_year) <= 0) && Number.isInteger(year) && year > 0) updates.release_year = year;
  if (isBlankOrPending(row.runtime) && runtime) updates.runtime = runtime;
  if ((!Number.isFinite(Number(row.rating)) || Number(row.rating) <= 0) && Number.isFinite(rating) && rating > 0) updates.rating = Math.max(0, Math.min(10, rating));
  if (isBlankOrPending(row.genre) && genre) updates.genre = genre;
  if (isBlankOrPending(row.director) && director) updates.director = director;
  if ((parsedArray(row.cast_json).length === 0 || isBlankOrPending(row.cast_json)) && cast.length) updates.cast_json = JSON.stringify(cast);
  if (parsedArray(row.languages_json).length === 0 && language) updates.languages_json = JSON.stringify([language]);
  if (!metadataText(row.official_watch_url, 1000) && trailer) updates.official_watch_url = trailer;
  return updates;
}

function needsMovieMetadata(row) {
  return isBlankOrPending(row.title) || isBlankOrPending(row.description) || Number(row.release_year) <= 0 ||
    isBlankOrPending(row.runtime) || Number(row.rating) <= 0 || isBlankOrPending(row.genre) ||
    isBlankOrPending(row.director) || parsedArray(row.cast_json).length === 0 || isBlankOrPending(row.cast_json) ||
    parsedArray(row.languages_json).length === 0 || !metadataText(row.official_watch_url, 1000);
}

const METADATA_COLUMNS = [
  'title', 'description', 'release_year', 'runtime', 'rating', 'genre', 'director',
  'cast_json', 'languages_json', 'official_watch_url', 'poster', 'backdrop',
];

async function syncArtworkForMovie(ctx, row) {
  const updates = {};
  let metadata;
  let metadataLoaded = false;
  const errors = [];
  const getMetadata = async () => {
    if (!metadataLoaded) {
      metadataLoaded = true;
      metadata = await fetchArtworkMetadata(row.imdb_id);
    }
    return metadata;
  };
  try { Object.assign(updates, metadataUpdatesForMovie(row, needsMovieMetadata(row) ? await getMetadata() : null)); }
  catch (error) { errors.push('METADATA_UNAVAILABLE'); }

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
      const fields = kind === 'poster' ? ['large_cover_image', 'medium_cover_image'] : ['background_image_original', 'background_image'];
      const sources = [];
      if (current) sources.push(current);
      const yts = current ? null : await getMetadata();
      for (const field of fields) {
        const source = artworkUrl(yts?.[field]);
        if (source && !sources.includes(source)) sources.push(source);
      }
      let uploaded = false;
      for (const source of sources) {
        try {
          const downloaded = await downloadArtwork(source);
          if (!downloaded) continue;
          await sendWithRetry(ctx.s3, new PutObjectCommand({ Bucket: ctx.bucket, Key: key, Body: downloaded.bytes, ContentType: downloaded.contentType, CacheControl: 'public, max-age=31536000, immutable', Metadata: { source: 'yts-artwork', movieId: String(row.id), kind } }));
          const verified = await ctx.headArtwork(key);
          if (!verified || Number(verified.ContentLength) !== downloaded.bytes.byteLength) throw new Error('ARTWORK_R2_VERIFY_FAILED');
          updates[kind] = publicArtworkUrl(key);
          uploaded = true;
          break;
        } catch (error) { console.warn(JSON.stringify({ event: 'artwork-upload-warning', id: row.id, imdbId: row.imdb_id, kind, error: safeLogError(error) })); }
      }
      if (!uploaded && !isManagedArtworkUrl(row[kind], row.id, kind)) errors.push(kind.toUpperCase() + '_UNAVAILABLE');
    } catch (error) {
      errors.push(kind.toUpperCase() + '_SYNC_FAILED');
      console.warn(JSON.stringify({ event: 'artwork-sync-warning', id: row.id, imdbId: row.imdb_id, kind, error: safeLogError(error), non_blocking: true }));
    }
  }

  const cast = updates.cast_json ? parsedArray(updates.cast_json) : parsedArray(row.cast_json);
  const storedCast = [];
  for (let index = 0; index < cast.length; index += 1) {
    const member = cast[index];
    if (typeof member === 'string') { storedCast.push(member); continue; }
    if (!isRecord(member)) continue;
    const next = { ...member };
    const key = /^tt\d{7,10}$/.test(String(row.imdb_id || '')) && index < 6 ? 'cast/' + row.imdb_id + '-' + (index + 1) + '.jpg' : null;
    try {
      if (key) {
        const existing = await ctx.headArtwork(key);
        if (existing && Number(existing.ContentLength) > 0 && String(existing.ContentType || '').startsWith('image/')) {
          next.profileR2Key = key;
        } else {
          const source = artworkUrl(next.image || next.profileUrl);
          if (source) {
            const downloaded = await downloadArtwork(source);
            if (downloaded) {
              await sendWithRetry(ctx.s3, new PutObjectCommand({ Bucket: ctx.bucket, Key: key, Body: downloaded.bytes, ContentType: downloaded.contentType, CacheControl: 'public, max-age=31536000, immutable', Metadata: { source: 'yts-cast', movieId: String(row.id), castIndex: String(index + 1) } }));
              const verified = await ctx.headArtwork(key);
              if (!verified || Number(verified.ContentLength) !== downloaded.bytes.byteLength) throw new Error('CAST_R2_VERIFY_FAILED');
              next.profileR2Key = key;
            }
          }
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'cast-image-warning', id: row.id, imdbId: row.imdb_id, index: index + 1, error: safeLogError(error) }));
    }
    if (!next.profileR2Key && !next.image && !next.profileUrl) errors.push('CAST_IMAGE_MISSING');
    storedCast.push(next);
  }
  if (storedCast.length && JSON.stringify(storedCast) !== JSON.stringify(parsedArray(row.cast_json))) updates.cast_json = JSON.stringify(storedCast);

  const finalPoster = updates.poster || row.poster;
  const finalBackdrop = updates.backdrop || row.backdrop;
  const finalDirector = updates.director || row.director;
  const finalCast = updates.cast_json ? parsedArray(updates.cast_json) : parsedArray(row.cast_json);
  const enrichmentReady = isManagedArtworkUrl(finalPoster, row.id, 'poster') &&
    isManagedArtworkUrl(finalBackdrop, row.id, 'backdrop') &&
    !isBlankOrPending(finalDirector) && finalCast.length > 0 &&
    finalCast.every((member) => typeof member === 'string' || (isRecord(member) && Boolean(member.profileR2Key || member.image || member.profileUrl)));
  if (!enrichmentReady && !errors.length) errors.push('ENRICHMENT_INCOMPLETE');
  return { id: row.id, revision: row.revision, synced: METADATA_COLUMNS.filter((field) => Object.prototype.hasOwnProperty.call(updates, field)), updates, enrichmentStatus: enrichmentReady ? 'ready' : 'failed', enrichmentError: errors.length ? errors.join(',') : null };
}

export async function syncAllArtwork(ctx, eligibleIds = []) {
  const ids = [...new Set(eligibleIds.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) {
    console.log(JSON.stringify({ event: 'enrichment-complete', scanned: 0, updated: 0, fields: 0 }));
    return { scanned: 0, updated: 0, updatesByMovie: {} };
  }
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await ctx.query("SELECT id, revision, imdb_id, title, description, release_year, runtime, rating, genre, director, cast_json, languages_json, official_watch_url, poster, backdrop FROM movies WHERE publication_status <> 'archived' AND id IN (" + placeholders + ") ORDER BY id", ids);
  let cursor = 0;
  const results = [];
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      try { results.push(await syncArtworkForMovie(ctx, row)); }
      catch (error) { results.push({ id: row.id, revision: row.revision, synced: [], updates: {}, enrichmentStatus: 'failed', enrichmentError: 'ENRICHMENT_FAILED' }); console.warn(JSON.stringify({ event: 'enrichment-failed', movie_id: row.id, failure_code: 'ENRICHMENT_FAILED', error: safeLogError(error) })); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ARTWORK_CONCURRENCY, rows.length) }, worker));
  const updatesByMovie = {};
  let updated = 0;
  for (const result of results) {
    const assignments = result.synced.map((field) => field + '=?');
    const values = result.synced.map((field) => result.updates[field]);
    const sql = "UPDATE movies SET " + (assignments.length ? assignments.join(',') + ',' : '') + " enrichment_status=?, enrichment_error=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND publication_status <> 'archived' RETURNING id";
    const committed = await ctx.query(sql, [...values, result.enrichmentStatus, result.enrichmentError, new Date().toISOString(), result.id, result.revision]);
    if (committed.length) { updated += 1; updatesByMovie[String(result.id)] = result.updates; }
    console.log(JSON.stringify({ event: 'enrichment-result', movie_id: result.id, enrichment_status: result.enrichmentStatus, enrichment_error: result.enrichmentError, fields: result.synced }));
  }
  console.log(JSON.stringify({ event: 'enrichment-complete', scanned: rows.length, updated, fields: Object.values(updatesByMovie).reduce((total, updates) => total + Object.keys(updates).length, 0) }));
  return { scanned: rows.length, updated, updatesByMovie };
}
export function maxMoviesFromArgs(argv = process.argv) {
  const raw = argv.find(value => value.startsWith('--max-movies='))?.slice('--max-movies='.length);
  if (raw === undefined || raw === '') return DEFAULT_MAX_MOVIES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 30) throw new Error('--max-movies must be an integer from 1 to 30');
  return value;
}

export function isNonRetryableValidationError(error) {
  return /(?:MP4 validation failed|No safe playable MP4 in source)/i.test(safeLogError(error));
}

export function isNonRetryableAcquisitionError(error) {
  return Boolean(error?.code && /^(NO_PEERS|ZERO_BYTE_STALL|DOWNLOAD_STALLED|SOURCE_INVALID|METADATA_TIMEOUT)$/.test(error.code));
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

function createByteProgressTransform(item, totalBytes, state, onPayloadProgress) {
  let nextPercent = 10;
  let lastLoggedAt = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = chunk?.byteLength ?? chunk?.length ?? 0;
      if (bytes > 0) {
        state.payloadBytes += bytes;
        state.lastProgressAt = new Date().toISOString();
        onPayloadProgress();
        const now = Date.now();
        const percent = totalBytes > 0 ? Math.min(100, Math.floor(state.payloadBytes / totalBytes * 100)) : 0;
        if (percent >= nextPercent || now - lastLoggedAt >= 10_000) {
          acquisitionEvent(item, state, 'payload-progress', { percent });
          lastLoggedAt = now;
          while (nextPercent <= percent) nextPercent += 10;
        }
      }
      callback(null, chunk);
    },
  });
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
    const response = await fetchWithRetry(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${d1Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok || !data.success || data.result?.some(r => r.success === false)) throw new Error(`D1 query rejected (${response.status})`);
    return data.result.flatMap(r => r.results || []);
  }
  async function head(key) {
    if (!/^assets\/[a-f0-9-]{36}\/(?:data\.bin|720p\.mp4|1080p\.mp4)$/.test(key || '')) return null;
    try { return await sendWithRetry(s3, new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(requestTimeoutMs) }); }
    catch (e) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  async function headArtwork(key) {
    if (!/^(?:artworks\/\d+\/(?:poster|backdrop)\.jpg|cast\/tt\d{7,10}-[1-6]\.jpg)$/.test(key || '')) return null;
    try { return await sendWithRetry(s3, new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(requestTimeoutMs) }); }
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
async function markMovieFlagged(ctx, id, error) {
  const message = safeLogError(error).slice(0, 1000) || 'media item requires manual review';
  try {
    await ctx.query("UPDATE movies SET ingest_status = 'flagged_for_review', transfer_error = ?, transfer_token = NULL, transfer_lease_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (ingest_status IS NOT 'flagged_for_review' OR transfer_error IS NOT ?)", [message, id, message]);
  } catch (updateError) {
    console.error(JSON.stringify({ event: 'movie-review-flag-failed', id, error: safeLogError(updateError) }));
  }
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
let activeContext = null;
let shutdownStarted = false;
async function handleShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.warn(JSON.stringify({ event: 'shutdown-requested', signal }));
  if (activeContext) {
    try { await diagnoseTransferLocks(activeContext); }
    catch (error) { console.error(JSON.stringify({ event: 'transfer-lock-release-failed', error: safeLogError(error) })); }
  }

  process.exit();
}
process.once('SIGINT', () => { void handleShutdown('SIGINT'); });
process.once('SIGTERM', () => { void handleShutdown('SIGTERM'); });
export async function diagnoseTransferLocks(ctx) {
  const records = await diagnoseStaleTransfers(ctx);
  console.log(JSON.stringify({ event: 'transfer-lease-diagnostic', dry_run: true, count: records.length, records }));
  return records;
}
export async function makePlan(ctx, options = {}) {
  const maxMovies = options.maxMovies ?? DEFAULT_MAX_MOVIES;
  if (!Number.isSafeInteger(maxMovies) || maxMovies < 1 || maxMovies > 30) throw new Error('Invalid maxMovies');
  const queryLimit = FILTER_MOVIE_IDS.size ? 30 : maxMovies;
  const rows = await ctx.query("SELECT id,slug,imdb_id,download_sources_json,r2_storage_key,r2_video_bytes FROM movies WHERE publication_status IN ('draft','published') ORDER BY CASE WHEN ingest_status IN ('queued','processing','retry_pending','half','transferring') THEN 0 WHEN ingest_status = 'ready' THEN 2 ELSE 1 END, id LIMIT ?", [queryLimit]);
  const plan = { schema: 'flixlyra-cloud-v1', files: [], failures: [], createdAt: new Date().toISOString() };
  const selectedRows = FILTER_MOVIE_IDS.size ? rows.filter(row => FILTER_MOVIE_IDS.has(Number(row.id))) : rows;
  for (const row of selectedRows) {
    const movieItems = [];
    try {
      for (const quality of (FILTER_QUALITY ? [FILTER_QUALITY] : ['720p','1080p'])) {
        const source = sourcesOf(row.download_sources_json).find(s => (s.quality || s.resolution)?.toLowerCase() === quality);
        const mapped = source?.r2StorageKey || source?.r2_storage_key;
        if (!source && !(quality === '1080p' && row.r2_storage_key)) continue;
        // A legacy primary is not assigned a quality by guesswork.
        const key = mapped || stableKey(row.id, quality);
        const object = await ctx.head(key);
        const verified = validVideo(object) && (!source?.r2Bytes || Number(source.r2Bytes) === object.ContentLength);
        movieItems.push({ id: row.id, slug: row.slug, imdbId: row.imdb_id, quality, key, bytes: verified ? object.ContentLength : null,
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
export async function acquire(ctx, item, attempt = 1, runtime = {}) {
  const [row] = await ctx.query('SELECT download_sources_json FROM movies WHERE id = ?', [item.id]);
  if (!row) throw new MediaAcquisitionError('SOURCE_INVALID', 'Movie no longer exists');
  const source = sourcesOf(row.download_sources_json).find(s => (s.quality || s.resolution)?.toLowerCase() === item.quality);
  let descriptor;
  if (attempt > 1 || !source) descriptor = await alternativeDescriptor(item.imdbId, item.quality, source?.url);
  if (!descriptor) descriptor = sourceMagnet(row.download_sources_json, item.quality);
  if (!descriptor && /^(?:assets|descriptors)\/[\w.-]+\.(?:torrent|bin)$/.test(source?.descriptorKey || '')) {
    const object = await sendWithRetry(ctx.s3, new GetObjectCommand({ Bucket: ctx.bucket, Key: source.descriptorKey }), { abortSignal: AbortSignal.timeout(requestTimeoutMs) });
    if (!object.ContentLength || object.ContentLength > 2097152) { object.Body?.destroy(); throw new MediaAcquisitionError('SOURCE_INVALID', 'Invalid descriptor size'); }
    descriptor = Buffer.from(await object.Body.transformToByteArray());
  }
  if (!descriptor) descriptor = await remoteDescriptor(row.download_sources_json, item.quality);
  if (!descriptor) throw new MediaAcquisitionError('SOURCE_INVALID', 'No usable torrent source');

  const work = resolve(mediaRoot, `${item.id}-${item.quality}`);
  await mkdir(work, { recursive: true });
  const filePath = resolve(work, `${item.quality}.mp4`);
  const metadataTimeoutMs = runtime.metadataTimeoutMs ?? Number(process.env.TRANSFER_METADATA_TIMEOUT_SECONDS ?? DEFAULT_METADATA_TIMEOUT_MS / 1000) * 1000;
  const noProgressTimeoutMs = runtime.noProgressTimeoutMs ?? Number(process.env.TRANSFER_NO_PROGRESS_TIMEOUT_SECONDS ?? DEFAULT_NO_PROGRESS_TIMEOUT_MS / 1000) * 1000;
  if (![metadataTimeoutMs, noProgressTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 900_000)) throw new Error('Invalid media watchdog timeout');
  const state = {
    startedAt: Date.now(), infoHash: null, expectedBytes: null, metadataReceived: false,
    trackerEvent: null, peerCount: 0, payloadBytes: 0, lastProgressAt: null, failureCode: null,
  };
  item.mediaDiagnostics = state;
  let client;
  let torrent;
  let readStream;
  let progressStream;
  let writer;
  let metadataTimer;
  let progressTimer;
  let cleanupPromise;
  let rejectMetadata;
  let abortHandled = false;
  let acquisitionPhase = 'source';
  const controller = new AbortController();
  const timers = [];
  const trackTimer = timer => { timers.push(timer); activeTimers.add(timer); return timer; };
  const clearTrackedTimer = timer => { if (timer) { clearTimeout(timer); activeTimers.delete(timer); } };
  const safeDestroy = stream => { try { stream?.destroy?.(); } catch { /* cleanup is best effort */ } };
  const abort = error => {
    if (abortHandled) return;
    abortHandled = true;
    const failure = error instanceof MediaAcquisitionError ? error : new MediaAcquisitionError('SOURCE_INVALID', safeLogError(error));
    state.failureCode = failure.code;
    state.failureMessage = failure.message;
    acquisitionEvent(item, state, 'acquisition-abort', { stage: acquisitionPhase });
    controller.abort(failure);
  };
  const onAbort = () => {
    const reason = controller.signal.reason;
    safeDestroy(readStream);
    safeDestroy(progressStream);
    safeDestroy(writer);
    // The client owns torrent teardown. Calling torrent.destroy() first makes
    // WebTorrent skip the client's destroy callback for an already-destroyed torrent.
    cleanupPromise ||= destroyTorrentClient(client);
    rejectMetadata?.(reason);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    acquisitionEvent(item, state, 'acquisition-start');
    acquisitionPhase = 'metadata';
    metadataTimer = trackTimer(setTimeout(() => abort(new MediaAcquisitionError('METADATA_TIMEOUT', 'Torrent metadata was not received within the metadata watchdog')), metadataTimeoutMs));
    const clientOptions = { webSeeds: false, maxConns: 30, uploadLimit: 131072 };
    client = await awaitWithAbort(
      () => runtime.createClient
        ? runtime.createClient(clientOptions)
        : loadGuardedWebTorrent().then(WebTorrent => new WebTorrent(clientOptions)),
      controller.signal,
      lateClient => destroyClientResource(lateClient),
    );
    activeTorrentClients.add(client);
    controller.signal.throwIfAborted();
    torrent = await new Promise((resolveTorrent, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        client.removeListener('error', onError);
        client.removeListener('warning', onWarning);
        pending?.removeListener?.('error', onError);
        rejectMetadata = null;
        if (error) reject(error); else resolveTorrent(value);
      };
      const onError = error => { abort(error); finish(error); };
      const onWarning = warning => {
        state.trackerEvent = 'warning';
        acquisitionEvent(item, state, 'tracker-warning', { warning: safeLogError(warning) });
      };
      let pending;
      rejectMetadata = finish;
      client.on('error', onError);
      client.on('warning', onWarning);
      try {
        pending = client.add(descriptor, { path: resolve(work, 'pieces'), deselect: true, strategy: 'sequential', storeCacheSlots: 2 }, ready => finish(null, ready));
        pending.on('error', onError);
      } catch (error) { onError(error); }
    });
    clearTrackedTimer(metadataTimer);
    metadataTimer = null;
    state.metadataReceived = true;
    state.infoHash = torrent.infoHash || null;
    state.expectedBytes = Number(torrent.length) || null;
    state.peerCount = Array.isArray(torrent.wires) ? torrent.wires.length : Number(torrent.wires?.length || 0);
    acquisitionEvent(item, state, 'torrent-metadata');
    acquisitionPhase = 'peer_discovery';
    const onWire = () => {
      state.peerCount = Array.isArray(torrent.wires) ? torrent.wires.length : Number(torrent.wires?.length || 0);
      state.trackerEvent = 'wire';
      acquisitionEvent(item, state, 'peer-discovered');
    };
    const onTracker = event => {
      state.trackerEvent = event;
      state.peerCount = Array.isArray(torrent.wires) ? torrent.wires.length : Number(torrent.wires?.length || 0);
      acquisitionEvent(item, state, 'tracker-event');
    };
    torrent.on?.('wire', onWire);
    torrent.on?.('trackerAnnounce', () => onTracker('trackerAnnounce'));
    torrent.on?.('dhtAnnounce', () => onTracker('dhtAnnounce'));
    const file = primaryMp4(torrent.files || []);
    if (!file || !Number.isSafeInteger(Number(file.length)) || Number(file.length) <= 0 || !Number.isSafeInteger(Number(torrent.pieceLength)) || Number(torrent.pieceLength) <= 0 || Number(torrent.pieceLength) > 16 * 1024 * 1024 || !Array.isArray(torrent.pieces) || torrent.pieces.length === 0) throw new MediaAcquisitionError('SOURCE_INVALID', 'No safe playable MP4 in source');
    state.expectedBytes = Number(file.length);
    acquisitionEvent(item, state, 'file-selected', { file_name: file.name });
    const armProgressWatchdog = () => {
      clearTrackedTimer(progressTimer);
      const code = state.payloadBytes > 0 ? 'DOWNLOAD_STALLED' : state.peerCount === 0 ? 'NO_PEERS' : 'ZERO_BYTE_STALL';
      progressTimer = trackTimer(setTimeout(() => abort(new MediaAcquisitionError(code, code === 'DOWNLOAD_STALLED' ? 'Torrent payload stopped progressing' : 'No torrent payload bytes arrived')), noProgressTimeoutMs));
    };
    armProgressWatchdog();
    const disk = await awaitWithAbort(() => (runtime.statfs || statfs)(work), controller.signal);
    if (torrent.length + file.length + 2 * 1024 ** 3 > disk.bavail * disk.bsize) throw new MediaAcquisitionError('SOURCE_INVALID', 'Insufficient runner disk for this video');
    torrent.deselect(0, torrent.pieces.length - 1, false);
    file.select();
    acquisitionPhase = 'payload';

    readStream = file.createReadStream();
    progressStream = createByteProgressTransform(item, file.length, state, armProgressWatchdog);
    writer = createWriteStream(filePath);
    acquisitionEvent(item, state, 'payload-wait-start');
    await pipeline(readStream, progressStream, writer, { signal: controller.signal });
    clearTrackedTimer(progressTimer);
    progressTimer = null;
    const written = fs.statSync(filePath);
    if (!written.isFile() || written.size <= 10 * 1024 * 1024) throw new MediaAcquisitionError('SOURCE_INVALID', 'NEW_FILE_ZERO_BYTES_OR_CORRUPT');
    acquisitionPhase = 'validation';
    const validated = await (runtime.validateMp4 || validateMp4)(filePath, file.length);
    item.file = filePath;
    item.bytes = validated.bytes;
    acquisitionEvent(item, state, 'payload-complete', { phase: 'validation' });
  } catch (error) {
    const failure = state.failureCode
      ? new MediaAcquisitionError(state.failureCode, state.failureMessage || safeLogError(error), { infoHash: state.infoHash, expectedBytes: state.expectedBytes, payloadBytes: state.payloadBytes })
      : error;
    if (!state.failureCode) state.failureCode = mediaFailureCode(failure);
    acquisitionEvent(item, state, 'acquisition-failure', { phase: acquisitionPhase, error: safeLogError(failure) });
    throw failure;
  } finally {
    for (const timer of timers) clearTrackedTimer(timer);
    controller.signal.removeEventListener('abort', onAbort);
    cleanupPromise ||= destroyTorrentClient(client);
    await cleanupPromise;
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
      ingestStatus: 'skipped_unplayable',
      error: `Missing ${missing[0]}: ${(plan?.files || []).find(item => item.id === id && item.skipped && item.quality === missing[0])?.failureCode || 'Dead stream / 404'}`,
    };
  }
  const unplayable = (plan?.files || []).some(item => item.id === id && item.skipped && /MP4|unplayable|corrupt|container/i.test(String(item.skipReason || '')));
  return { status: 'FLAGGED_FOR_REVIEW', ingestStatus: unplayable ? 'skipped_unplayable' : 'flagged_for_review', error: unplayable ? 'Unplayable or corrupt MP4' : 'Dead stream / 404' };
}
export async function markPermanentlyFailed(ctx, ids, plan) {
  let marked = 0;
  let half = 0;
  for (const id of new Set(ids)) {
    const state = failureState(plan, id);
    let row;
    try {
      [row] = await ctx.query('SELECT ingest_status, transfer_lease_until FROM movies WHERE id = ?', [id]);
    } catch (error) {
      console.error(JSON.stringify({ event: 'media-flag-read-failed', id, error: safeLogError(error) }));
      continue;
    }
    if (!row || !['queued', 'processing', 'transferring', 'retry_pending', 'half', 'flagged_for_review'].includes(row.ingest_status)) continue;
    if (row.ingest_status === 'transferring' && Number(row.transfer_lease_until) > Math.floor(Date.now() / 1000)) continue;
    try {
      assertLegalTransition(row.ingest_status, state.ingestStatus);
const result = await ctx.query("UPDATE movies SET ingest_status = ?, transfer_error = ?, transfer_token = NULL, transfer_lease_until = NULL, updated_at = ? WHERE id = ? AND ingest_status = ? AND (ingest_status <> 'transferring' OR transfer_lease_until IS NULL OR transfer_lease_until <= unixepoch())", [state.ingestStatus, state.error, new Date().toISOString(), id, row.ingest_status]);
      if (!result.length) continue;
      marked += 1;
      if (state.status === 'HALF') half += 1;
      console.warn(JSON.stringify({ event: 'media_flagged', id, status: state.ingestStatus, reason: state.error }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'media-flag-state-transition-failed', id, error: safeLogError(error) }));
    }
  }
  console.log('Flagged ' + marked + ' movies for review in D1 Database.');
  if (half) console.log('Flagged ' + half + ' movies for review with one quality missing in D1 Database.');
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
      const failureCode = error?.code || mediaFailureCode(error);
      if (failureCode) item.failureCode = failureCode;
      if (isNonRetryableValidationError(error) || isNonRetryableAcquisitionError(error)) {
        item.nonRetryableFailure = true;
        item.failureReason = message;
        console.warn(JSON.stringify({ event: 'acquisition-terminal-failure', id: item.id, quality: item.quality, attempt, failure_code: failureCode || 'SOURCE_INVALID', retryable: false, error: message }));
        return false;
      }
      console.warn(JSON.stringify({ event: 'acquisition-retry', id: item.id, quality: item.quality, attempt, error: message }));
      if (attempt < maxAttempts) {
        console.warn(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â°ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â [Movie ID: ${item.id}] Retrying acquisition (Attempt ${attempt + 1}/${maxAttempts})...`);
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
      if (!item.nonRetryableFailure) console.warn(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Pass 1 failed for Movie ${item.id}. Queuing for final retry pass.`);
      if (item.nonRetryableFailure) await markMovieRetryPending(ctx, item.id, item.failureReason);
       await markSkipped(plan, item, persist, item.failureCode || (item.nonRetryableFailure ? 'validation-failure' : 'download-failure'));
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
  const groups = [...new Map(pending.map(item => [Number(item.id), item])).keys()]
    .map(id => pending.filter(item => Number(item.id) === id));
  let persistTail = Promise.resolve();
  const persistQueued = (nextPlan) => {
    const next = persistTail.then(() => persist(nextPlan));
    persistTail = next.catch(() => {});
    return next;
  };
  const workerOptions = { ...options, saveManifest: persistQueued };
  let cursor = 0;
  async function prepareGroup(items) {
    for (const item of items) {
      try {
        if (await acquireWithRetries(ctx, plan, item, 3, workerOptions)) {
          prepared += 1;
          continue;
        }
        console.warn('Pass 1 failed for Movie ' + item.id + '. Queuing for final retry pass.');
        if (item.nonRetryableFailure) {
          await markMovieRetryPending(ctx, item.id, item.failureReason);
          await markSkipped(plan, item, persistQueued, item.failureCode || 'validation-failure');
          if (!permanentlyFailedIds.includes(item.id)) permanentlyFailedIds.push(item.id);
        } else {
          console.warn('Pass 1 failed for Movie ' + item.id + '. Queuing for final retry pass.');
          failedQueue.push(item);
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'movie-preparation-failed', id: item.id, quality: item.quality, error: safeLogError(error) }));
        failedQueue.push(item);
      }
    }
  }
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= groups.length) return;
      await prepareGroup(groups[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, groups.length) }, worker));
  await persistTail;
  if (failedQueue.length) {
    console.log('Starting Second-Chance Retry Pass for ' + failedQueue.length + ' skipped movies...');
    console.log('Starting bounded second-chance retry pass for ' + failedQueue.length + ' quality item(s).');
    let retryCursor = 0;
    async function retryWorker() {
      while (true) {
        const index = retryCursor++;
        if (index >= failedQueue.length) return;
        const item = failedQueue[index];
        try {
          delete item.skipped;
          delete item.skipReason;
          await (options.acquire || acquire)(ctx, item, 4);
          await persistQueued(plan);
          prepared += 1;
        } catch (error) {
          const failureCode = item.mediaDiagnostics?.failureCode || mediaFailureCode(error);
          item.failureCode = failureCode || item.failureCode || 'DOWNLOAD_FAILED';
          console.error(JSON.stringify({ event: 'movie-preparation-permanently-skipped', id: item.id, quality: item.quality, failure_code: item.failureCode, error: safeLogError(error) }));
          if (!permanentlyFailedIds.includes(item.id)) permanentlyFailedIds.push(item.id);
          await markSkipped(plan, item, persistQueued, item.failureCode);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, failedQueue.length) }, retryWorker));
    await persistTail;
  }
  const markedFailed = await markPermanentlyFailed(ctx, permanentlyFailedIds, plan);
  await persist(plan);
  return { prepared, skipped: plan.files.filter(f => f.skipped).length, permanentlyFailedIds, markedFailed };
}export async function commitItem(ctx, item, options = {}) {
  const transferToken = options.transferToken;
  if (typeof transferToken !== 'string' || transferToken.length < 16) throw new Error('TRANSFER_OWNER_REQUIRED');
  qualityWorkflowEvent(item, 'r2-verify-start');
  const object = await ctx.head(item.key);
  if (!validVideo(object) || object.ContentLength !== item.bytes) throw new Error('R2 verification failed before D1 commit');
  qualityWorkflowEvent(item, 'r2-verify-complete');
  const [row] = await ctx.query('SELECT download_sources_json, revision, ingest_status, transfer_token FROM movies WHERE id = ?', [item.id]);
  if (!row || row.transfer_token !== transferToken || row.ingest_status !== 'transferring') throw new Error('TRANSFER_OWNERSHIP_LOST');
  const sources = sourcesOf(row.download_sources_json);
  const existing = sources.find(s => (s.quality || s.resolution)?.toLowerCase() === item.quality);
  const downloadUrl = item.slug ? (siteOrigin + '/api/download/resolve?slug=' + encodeURIComponent(item.slug) + '&quality=' + item.quality) : existing?.download_url || null;
  const updated = { ...existing, quality: item.quality, resolution: item.quality, r2StorageKey: item.key, r2Bytes: item.bytes, size: String((item.bytes / 1024 ** 3).toFixed(2)) + ' GB', download_url: downloadUrl };
  const next = [...sources.filter(s => (s.quality || s.resolution)?.toLowerCase() !== item.quality), updated];
  let verifiedQualities = 0;
  for (const q of ['720p','1080p']) {
    const s = next.find(s => (s.quality || s.resolution)?.toLowerCase() === q);
    const h = await ctx.head(s?.r2StorageKey);
    if (s && validVideo(h) && h.ContentLength === s.r2Bytes) verifiedQualities += 1;
  }
  const ready = verifiedQualities === 2;
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const metadataFields = METADATA_COLUMNS.filter((field) => Object.prototype.hasOwnProperty.call(metadata, field));
  const metadataAssignments = metadataFields.length ? ',' + metadataFields.map((field) => field + '=?').join(',') : '';
  const primary = next.find(s => s.quality === '1080p' && s.r2StorageKey) || updated;
  const nextStatus = ready ? 'ready' : verifiedQualities > 0 ? 'half' : 'retry_pending';
  assertLegalTransition(row.ingest_status, nextStatus);
const result = await ctx.query("UPDATE movies SET download_sources_json=?,r2_storage_key=?,r2_video_bytes=?,ingest_status=?,transfer_token=NULL,transfer_lease_until=NULL,transfer_error=NULL,revision=revision+1,updated_at=?" + metadataAssignments + " WHERE id=? AND revision=? AND publication_status IN ('draft','published') AND ingest_status='transferring' AND transfer_token=? RETURNING id", [JSON.stringify({ status: verifiedQualities > 0 ? 'available' : 'pending', sources: next }), primary.r2StorageKey, primary.r2Bytes, nextStatus, new Date().toISOString(), ...metadataFields.map((field) => metadata[field]), item.id, row.revision, transferToken]);
  if (!result.length) throw new Error('D1 changed or transfer ownership was lost; retry required');
  qualityWorkflowEvent(item, 'd1-commit-complete', { committed_status: nextStatus, verified_qualities: verifiedQualities });
}
async function claimItem(ctx, item) {
  const attemptId = randomUUID();
  const token = item.quality + ':' + attemptId;
  const claim = await claimTransfer(ctx, { id: Number(item.id), quality: item.quality, token, leaseSeconds: 3600 });
  if (!claim.claimed) throw new Error('TRANSFER_ALREADY_OWNED');
  item.attemptId = attemptId;
  item.transferToken = token;
  item.transferLeaseUntil = claim.leaseUntil;
  return token;
}
async function processItem(ctx, item, sync) {
  const token = await claimItem(ctx, item);
  let phase = 'r2_upload';
  try {
    qualityWorkflowEvent(item, 'r2-upload-start');
    if (!item.verified) await sync(item);
    qualityWorkflowEvent(item, 'r2-upload-complete');
    phase = 'd1_commit';
    qualityWorkflowEvent(item, 'd1-commit-start');
    await commitItem(ctx, item, { transferToken: token });
    item.verified = true;
    if (item.file && resolve(item.file).startsWith(mediaRoot + sep)) await rm(dirname(item.file), { recursive: true, force: true });
    item.file = null;
    return true;
  } catch (error) {
    let nextState = 'retry_pending';
    try {
      const rows = await ctx.query('SELECT download_sources_json FROM movies WHERE id = ?', [item.id]);
      const existing = rows[0] ? sourcesOf(rows[0].download_sources_json) : [];
      if (existing.some((source) => source.r2StorageKey && Number(source.r2Bytes) > 0)) nextState = 'half';
    } catch { /* Keep retry_pending when the diagnostic read fails. */ }
    const failureCode = item.mediaDiagnostics?.failureCode || mediaFailureCode(error) || 'TRANSFER_FAILED';
    qualityWorkflowEvent(item, 'transfer-failure', { phase, failure_code: failureCode, error: safeLogError(error) });
    await releaseTransfer(ctx, { id: Number(item.id), token, nextState, error: failureCode + ': ' + safeLogError(error) }).catch((releaseError) => {
      console.error(JSON.stringify({ event: 'transfer-lease-release-failed', id: item.id, error: safeLogError(releaseError) }));
    });
    throw error;
  }
}
export async function drainCloudPlan(plan, sync, _options = {}) {
  const options = _options || {};
  const ctx = options.context || await context();
  const persist = options.saveManifest || saveManifest;
  const enriched = new Set();
  const enrichMovie = async (id) => {
    if (typeof options.enrich !== 'function' || enriched.has(Number(id))) return;
    enriched.add(Number(id));
    try { await options.enrich(ctx, Number(id)); }
    catch (error) { console.warn(JSON.stringify({ event: 'enrichment-failed', movie_id: Number(id), failure_code: 'ENRICHMENT_FAILED', error: safeLogError(error) })); }
  };
  try {
    let consecutiveFailures = 0;
    while (true) {
      try {
        for (const item of plan.files.filter(f => f.verified)) await enrichMovie(item.id);
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
        const batch = [];
        const movieIds = new Set();
        for (const item of pending.filter(f => f.file)) {
          if (movieIds.has(Number(item.id))) continue;
          movieIds.add(Number(item.id));
          batch.push(item);
          if (batch.length >= MEDIA_CONCURRENCY) break;
        }
        if (!batch.length) {
          const item = await prepareOne(ctx, plan, options.prepareOptions || {});
          if (!item) continue;
          batch.push(item);
        }
        const settled = await Promise.allSettled(batch.map(async (item) => {
          await processItem(ctx, item, sync);
          item.verified = true;
          await enrichMovie(item.id);
          console.log(JSON.stringify({ event: 'verified', id: item.id, quality: item.quality, remaining: plan.files.filter(f => !f.verified).length }));
        }));
        const failed = settled.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const pending = plan.files.filter(f => !f.verified && !f.skipped);
        const pendingIds = [...new Set(pending.map(f => f.id))];
        const code = mediaFailureCode(error) || 'TRANSFER_FAILED';
        console.warn(JSON.stringify({ event: 'cloud-plan-failure', failure_code: code, error: safeLogError(error), pending_movie_ids: pendingIds }));
        if (consecutiveFailures >= MAX_RETRIES) {
          for (const item of pending) await markSkipped(plan, item, persist, item.failureCode || code);
          const marked = await markPermanentlyFailed(ctx, pendingIds, plan);
          await persist(plan);
          console.error('MAX_RETRIES=' + MAX_RETRIES + ' reached. Marked Movie IDs as failed: ' + (pendingIds.join(', ') || 'none') + ' (D1 marked: ' + marked + ').');
          return;
        }
        await (options.pause || pause)(10 * 1000);
      }
    }
  } finally {
    try { await diagnoseTransferLocks(ctx); } catch (error) { console.error(JSON.stringify({ event: 'transfer-lease-diagnostic-failed', error: safeLogError(error) })); }
    ctx.s3?.destroy?.();
  }
}if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let ctx;
  let summary;
  let fatalError;
  try {
    ctx = await context();
    await mkdir(mediaRoot, { recursive: true });
    await diagnoseTransferLocks(ctx);
    const maxMovies = maxMoviesFromArgs();
    const plan = await makePlan(ctx, { maxMovies });
    await saveManifest(plan);
    const result = await prepareAll(ctx, plan);
    summary = { event: 'prepared', maxMovies, artwork: { scanned: 0, updated: 0 }, failedMovies: plan.failures.length, total: plan.files.length, verified: plan.files.filter(f => f.verified).length, ...result };
  } catch (error) {
    fatalError = error;
  } finally {
    await cleanupRuntime();
    if (ctx) { try { await diagnoseTransferLocks(ctx); } catch (error) { console.error(JSON.stringify({ event: 'transfer-lock-release-failed', error: safeLogError(error) })); } }
    activeContext = null;
    ctx?.s3.destroy();
  }
  if (fatalError) {
    console.error(JSON.stringify({ event: 'prepare-fatal-error', error: safeLogError(fatalError) }));
    process.exit(1);
  }
  console.log(JSON.stringify(summary));
  process.exit(0);
}

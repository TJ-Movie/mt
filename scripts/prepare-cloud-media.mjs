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
import { approvedImageSource } from '../lib/image-source-policy.mjs';
import { chooseBestArtworkCandidate, inspectArtworkBytes, qualityFromDimensions } from '../lib/artwork-quality.mjs';

export const manifestPath = 'tmp/r2-video-manifest.json';
const mediaRoot = resolve('tmp/media');
const MAX_RETRIES = 5;
export const MAX_BATCH_MOVIES = 20;
export const MOVIE_TIME_BUDGET_MS = 30 * 60 * 1000;
const DEFAULT_MAX_MOVIES = MAX_BATCH_MOVIES;
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
const activeTransferOwners = new Map();
function handleAsyncTorrentFailure(reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(JSON.stringify({ event: 'uncaught-media-error', error: safeLogError(error) }));
  process.exitCode = 1;
}
process.on('uncaughtException', handleAsyncTorrentFailure);
process.on('unhandledRejection', handleAsyncTorrentFailure);

function destroyClientResource(client, timeoutMs = 5000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
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
async function destroyTorrentClient(client, timeoutMs = 5000) {
  if (!activeTorrentClients.delete(client)) return;
  await destroyClientResource(client, timeoutMs);
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


export class MediaAcquisitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MediaAcquisitionError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class MediaInfrastructureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MediaInfrastructureError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function isInfrastructureFailure(error) {
  return error instanceof MediaInfrastructureError || /^(?:D1_|R2_|TRANSFER_|MANIFEST_|LEASE_|STAGED_)/.test(String(error?.code || ''));
}

function mediaFailureCode(error) {
  if (error?.code && /^(METADATA_TIMEOUT|NO_PEERS|ZERO_BYTE_STALL|DOWNLOAD_STALLED|SOURCE_INVALID|MOVIE_TIME_BUDGET_EXCEEDED)$/.test(error.code)) return error.code;
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

const artworkUrl = (value) => approvedImageSource(value);

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

export async function downloadArtwork(url) {
  let current = artworkUrl(url);
  if (!current) return null;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchWithRetry(current, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) {
      if (redirects === 3) throw new Error('ARTWORK_TOO_MANY_REDIRECTS');
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      const next = location ? artworkUrl(new URL(location, current).toString()) : null;
      if (!next) throw new Error('ARTWORK_REDIRECT_NOT_ALLOWED');
      current = next;
      continue;
    }
    if (!response.ok || !response.body) throw new Error('ARTWORK_' + response.status);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)) throw new Error('ARTWORK_UNSUPPORTED_CONTENT_TYPE');
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_ARTWORK_BYTES) throw new Error('ARTWORK_TOO_LARGE');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.byteLength > MAX_ARTWORK_BYTES) throw new Error('ARTWORK_EMPTY_OR_TOO_LARGE');
    return { bytes, contentType };
  }
  throw new Error('ARTWORK_REDIRECT_LIMIT');
}

export async function fetchArtworkMetadata(imdbId) {
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

export async function fetchTmdbArtwork(row) {
  const token = process.env.TMDB_API_TOKEN?.trim();
  const apiKey = process.env.TMDB_API_KEY?.trim();
  const imdbId = metadataText(row.imdb_id, 16);
  if ((!token && !apiKey) || !/^tt\d{7,10}$/.test(imdbId)) return null;
  try {
    const query = new URLSearchParams({ external_source: 'imdb_id', language: 'en-US' });
    const headers = { accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    else query.set('api_key', apiKey);
    const response = await fetchWithRetry('https://api.themoviedb.org/3/find/' + encodeURIComponent(imdbId) + '?' + query, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const result = Array.isArray(payload?.movie_results) ? payload.movie_results.find((entry) => entry?.backdrop_path || entry?.poster_path) : null;
    if (!result) return null;
    return {
      provider: 'tmdb',
      tmdbId: Number(result.id) || null,
      poster: result.poster_path ? `https://image.tmdb.org/t/p/original${metadataText(result.poster_path, 240)}` : '',
      backdrop: result.backdrop_path ? `https://image.tmdb.org/t/p/original${metadataText(result.backdrop_path, 240)}` : '',
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: 'tmdb-artwork-warning', movie_id: row.id, imdbId, error: safeLogError(error) }));
    return null;
  }
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

function validDirector(value) {
  const candidate = metadataText(value, 160);
  return candidate.length >= 3 && !/^(?:pending editorial review|me|mee)$/i.test(candidate);
}

async function fetchOmdbDirector(row) {
  const apiKey = process.env.OMDB_API_KEY?.trim();
  const imdbId = metadataText(row.imdb_id, 16);
  if (!apiKey || !/^tt\d{7,10}$/.test(imdbId)) return '';
  try {
    const query = new URLSearchParams({ apikey: apiKey, i: imdbId, plot: 'short' });
    const response = await fetchWithRetry('https://www.omdbapi.com/?' + query, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.Response !== 'True' || payload.imdbID !== imdbId) return '';
    const director = metadataText(payload.Director, 160).replace(/^N\/A$/i, '');
    return validDirector(director) ? director : '';
  } catch (error) {
    console.warn(JSON.stringify({ event: 'director-fallback-warning', movie_id: row.id, source: 'omdb', error: safeLogError(error) }));
    return '';
  }
}

async function fetchTmdbDirector(row) {
  const token = process.env.TMDB_API_TOKEN?.trim();
  const apiKey = process.env.TMDB_API_KEY?.trim();
  const imdbId = metadataText(row.imdb_id, 16);
  if ((!token && !apiKey) || !/^tt\d{7,10}$/.test(imdbId)) return '';
  try {
    const findQuery = new URLSearchParams({ external_source: 'imdb_id', language: 'en-US' });
    const headers = { accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    else findQuery.set('api_key', apiKey);
    const foundResponse = await fetchWithRetry('https://api.themoviedb.org/3/find/' + encodeURIComponent(imdbId) + '?' + findQuery, { headers, signal: AbortSignal.timeout(20_000) });
    if (!foundResponse.ok) return '';
    const found = await foundResponse.json().catch(() => null);
    const tmdbId = found?.movie_results?.[0]?.id;
    if (!tmdbId) return '';
    const creditsQuery = new URLSearchParams({ language: 'en-US' });
    if (!token) creditsQuery.set('api_key', apiKey);
    const creditsResponse = await fetchWithRetry('https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdbId) + '/credits?' + creditsQuery, { headers, signal: AbortSignal.timeout(20_000) });
    if (!creditsResponse.ok) return '';
    const credits = await creditsResponse.json().catch(() => null);
    const director = (credits?.crew || [])
      .filter((person) => person?.job === 'Director')
      .map((person) => metadataText(person.name, 160))
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');
    return validDirector(director) ? director : '';
  } catch (error) {
    console.warn(JSON.stringify({ event: 'director-fallback-warning', movie_id: row.id, source: 'tmdb', error: safeLogError(error) }));
    return '';
  }
}

async function fallbackDirector(row) {
  const omdb = await fetchOmdbDirector(row);
  return omdb || await fetchTmdbDirector(row);
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

export function artworkSourceCandidates(kind, row, yts, tmdb) {
  const entries = [];
  const add = (provider, value) => {
    const url = artworkUrl(value);
    if (url && !entries.some((entry) => entry.url === url)) entries.push({ provider, url });
  };
  add('current', row[kind]);
  if (kind === 'poster') {
    add('yts', yts?.large_cover_image);
    add('yts', yts?.medium_cover_image);
    add('tmdb', tmdb?.poster);
  } else {
    add('yts', yts?.background_image_original);
    add('yts', yts?.background_image);
    add('tmdb', tmdb?.backdrop);
  }
  return entries;
}

export async function downloadValidatedArtworkCandidate(candidate, kind) {
  const downloaded = await downloadArtwork(candidate.url);
  const quality = inspectArtworkBytes(downloaded.bytes, downloaded.contentType, kind);
  if (!quality.valid) throw new Error('ARTWORK_QUALITY_REJECTED');
  return { ...candidate, ...downloaded, quality };
}

function existingArtworkCandidate(kind, key, head) {
  const metadata = head?.Metadata || {};
  const width = metadata.artworkwidth || metadata.artworkWidth;
  const height = metadata.artworkheight || metadata.artworkHeight;
  if (!width || !height) return null;
  const quality = qualityFromDimensions(kind, width, height, metadata.artworkcontenttype || metadata.artworkContentType || head.ContentType, head.ContentLength);
  return quality.valid ? { provider: 'existing-r2', url: publicArtworkUrl(key), quality } : null;
}

function isSufficientExistingArtwork(kind, candidate) {
  const minimumWidth = kind === 'backdrop' ? 1920 : 500;
  return Boolean(candidate?.quality?.valid && candidate.quality.width >= minimumWidth);
}

async function inspectExistingArtwork(ctx, kind, key, head) {
  const fromMetadata = existingArtworkCandidate(kind, key, head);
  if (fromMetadata) return fromMetadata;
  if (!ctx?.getArtwork) return undefined;
  try {
    const object = await ctx.getArtwork(key);
    if (!object?.Body) return null;
    const bytes = typeof object.Body.transformToByteArray === 'function'
      ? new Uint8Array(await object.Body.transformToByteArray())
      : new Uint8Array(await new Response(object.Body).arrayBuffer());
    const quality = inspectArtworkBytes(bytes, object.ContentType || head?.ContentType, kind);
    return quality.valid ? { provider: 'existing-r2', url: publicArtworkUrl(key), quality } : null;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'existing-artwork-inspection-warning', key, error: safeLogError(error) }));
    return undefined;
  }
}

export async function syncArtworkForMovie(ctx, row) {
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
  try {
    Object.assign(updates, metadataUpdatesForMovie(row, needsMovieMetadata(row) ? await getMetadata() : null));
    if (!validDirector(row.director) && !validDirector(updates.director)) {
      const director = await fallbackDirector(row);
      if (director) updates.director = director;
    }
  }
  catch (error) { errors.push('METADATA_UNAVAILABLE'); }

  let ytsArtwork = null;
  let ytsArtworkLoaded = false;
  const getYtsArtwork = async () => {
    if (!ytsArtworkLoaded) {
      ytsArtworkLoaded = true;
      try { ytsArtwork = await getMetadata(); }
      catch (error) { errors.push('YTS_ARTWORK_UNAVAILABLE'); }
    }
    return ytsArtwork;
  };
  let tmdbArtwork = null;
  let tmdbArtworkLoaded = false;
  const getTmdbArtwork = async () => {
    if (!tmdbArtworkLoaded) {
      tmdbArtworkLoaded = true;
      try { tmdbArtwork = await fetchTmdbArtwork(row); }
      catch (error) { errors.push('TMDB_ARTWORK_UNAVAILABLE'); }
    }
    return tmdbArtwork;
  };

  for (const kind of ['poster', 'backdrop']) {
    const key = artworkKey(row.id, kind);
    if (!key) continue;
    try {
      const existing = await ctx.headArtwork(key);
      const existingIsValid = existing && Number(existing.ContentLength) > 0 && String(existing.ContentType || '').startsWith('image/');
      const stored = existingIsValid ? await inspectExistingArtwork(ctx, kind, key, existing) : null;
      if (existingIsValid && stored === undefined) {
        if (!isManagedArtworkUrl(row[kind], row.id, kind)) updates[kind] = publicArtworkUrl(key);
        continue;
      }
      if (existingIsValid && isSufficientExistingArtwork(kind, stored)) {
        if (!isManagedArtworkUrl(row[kind], row.id, kind)) updates[kind] = publicArtworkUrl(key);
        continue;
      }
      const candidates = [];
      const ytsArtwork = await getYtsArtwork();
      const tmdbArtwork = await getTmdbArtwork();
      if (stored) candidates.push(stored);
      for (const source of artworkSourceCandidates(kind, row, ytsArtwork, tmdbArtwork)) {
        try { candidates.push(await downloadValidatedArtworkCandidate(source, kind)); }
        catch (error) { console.warn(JSON.stringify({ event: 'artwork-candidate-rejected', id: row.id, imdbId: row.imdb_id, kind, provider: source.provider, error: safeLogError(error) })); }
      }
      const current = chooseBestArtworkCandidate(kind, candidates.filter((candidate) => candidate.provider !== 'existing-r2'), stored);
      if (!current) {
        if (existingIsValid && !isManagedArtworkUrl(row[kind], row.id, kind)) updates[kind] = publicArtworkUrl(key);
        else if (!existingIsValid && !isManagedArtworkUrl(row[kind], row.id, kind)) errors.push(kind.toUpperCase() + '_UNAVAILABLE');
        continue;
      }
      if (current.provider === 'existing-r2') {
        if (!isManagedArtworkUrl(row[kind], row.id, kind)) updates[kind] = publicArtworkUrl(key);
        continue;
      }
      await sendWithRetry(ctx.s3, new PutObjectCommand({
        Bucket: ctx.bucket,
        Key: key,
        Body: current.bytes,
        ContentType: current.contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: {
          source: current.provider + '-artwork',
          movieId: String(row.id),
          kind,
          artworkWidth: String(current.quality.width),
          artworkHeight: String(current.quality.height),
          artworkQualityScore: String(current.quality.score),
          artworkContentType: current.contentType,
        },
      }));
      const verified = await ctx.headArtwork(key);
      if (!verified || Number(verified.ContentLength) !== current.bytes.byteLength || !String(verified.ContentType || '').startsWith('image/')) throw new Error('ARTWORK_R2_VERIFY_FAILED');
      updates[kind] = publicArtworkUrl(key);
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
  let rows;
  try {
    rows = await ctx.query("SELECT id, revision, imdb_id, title, description, release_year, runtime, rating, genre, director, cast_json, languages_json, official_watch_url, poster, backdrop FROM movies WHERE publication_status <> 'archived' AND id IN (" + placeholders + ") ORDER BY id", ids);
  } catch (error) {
    throw new MediaInfrastructureError('D1_ENRICHMENT_READ_FAILED', 'D1 enrichment lookup failed', { cause: safeLogError(error) });
  }
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
    let committed;
    try {
      committed = await ctx.query(sql, [...values, result.enrichmentStatus, result.enrichmentError, new Date().toISOString(), result.id, result.revision]);
    } catch (error) {
      throw new MediaInfrastructureError('D1_ENRICHMENT_COMMIT_FAILED', 'D1 enrichment commit failed', { cause: safeLogError(error) });
    }
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
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_MOVIES) throw new Error(`--max-movies must be an integer from 1 to ${MAX_BATCH_MOVIES}`);
  return value;
}

export function isNonRetryableValidationError(error) {
  return /(?:MP4 validation failed|No safe playable MP4 in source)/i.test(safeLogError(error));
}

export function isNonRetryableAcquisitionError(error) {
  return Boolean(error?.code && /^(NO_PEERS|ZERO_BYTE_STALL|DOWNLOAD_STALLED|SOURCE_INVALID|METADATA_TIMEOUT|MOVIE_TIME_BUDGET_EXCEEDED)$/.test(error.code));
}

function movieBudgetError(id) {
  return new MediaAcquisitionError('MOVIE_TIME_BUDGET_EXCEEDED', `Movie ${id} exceeded its 30-minute processing budget`);
}

function assertMovieDeadline(deadlineAt, id) {
  if (Number.isSafeInteger(deadlineAt) && Date.now() >= deadlineAt) throw movieBudgetError(id);
}

async function withMovieDeadline(operation, deadlineAt, id) {
  if (!Number.isSafeInteger(deadlineAt)) return operation();
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw movieBudgetError(id);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(movieBudgetError(id)), remaining); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  async function getArtwork(key) {
    if (!/^(?:artworks\/\d+\/(?:poster|backdrop)\.jpg|cast\/tt\d{7,10}-[1-6]\.jpg)$/.test(key || '')) return null;
    try { return await sendWithRetry(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(requestTimeoutMs) }); }
    catch (e) { if (e.$metadata?.httpStatusCode === 404) return null; throw e; }
  }
  return { s3, bucket, query, head, headArtwork, getArtwork };
}

async function cliContext() {
  const modulePath = process.env.PREPARE_CLOUD_MEDIA_CONTEXT_MODULE;
  if (!modulePath) return context();
  const imported = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof imported.createContext !== 'function') throw new Error('Injected media context must export createContext');
  return imported.createContext();
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
    const failure = updateError instanceof MediaInfrastructureError ? updateError : new MediaInfrastructureError('D1_STATE_UPDATE_FAILED', 'Could not mark movie for review', { cause: safeLogError(updateError) });
    console.error(JSON.stringify({ event: 'movie-review-flag-failed', id, failure_code: failure.code, error: safeLogError(failure) }));
    throw failure;
  }
}
async function markMovieRetryPending(ctx, id, error) {
  const message = safeLogError(error).slice(0, 1000);
  try {
    const result = await ctx.query("UPDATE movies SET ingest_status = ?, transfer_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND publication_status IN ('draft','published') RETURNING id", ['retry_pending', message, id]);
    if (!result?.length) throw new MediaInfrastructureError('D1_STATE_UPDATE_FAILED', 'Could not mark movie retry-pending');
    return true;
  } catch (updateError) {
    const error = updateError instanceof MediaInfrastructureError ? updateError : new MediaInfrastructureError('D1_STATE_UPDATE_FAILED', 'Could not mark movie retry-pending', { cause: safeLogError(updateError) });
    console.error(JSON.stringify({ event: 'movie-status-update-failed', id, status: 'retry_pending', failure_code: error.code, error: safeLogError(error) }));
    throw error;
  }
}
let activeContext = null;
let shutdownStarted = false;
export async function releaseActiveTransferOwners(reason = 'TRANSFER_CANCELLED') {
  const failures = [];
  for (const [token, owner] of activeTransferOwners) {
    let timeout;
    try {
      const released = await Promise.race([
        releaseTransfer(owner.ctx, { id: owner.id, token, nextState: 'retry_pending', error: reason }),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), 5000); }),
      ]);
      clearTimeout(timeout);
      if (!released) {
        const failure = { movie_id: owner.id, failure_code: 'LEASE_RELEASE_UNCONFIRMED' };
        failures.push(failure);
        console.error(JSON.stringify({ event: 'transfer-cancellation-release-failed', ...failure }));
      }
    } catch (error) {
      clearTimeout(timeout);
      const failure = { movie_id: owner.id, failure_code: 'LEASE_RELEASE_FAILED', error: safeLogError(error) };
      failures.push(failure);
      console.error(JSON.stringify({ event: 'transfer-cancellation-release-failed', ...failure }));
    }
  }
  return failures;
}
async function handleShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.warn(JSON.stringify({ event: 'shutdown-requested', signal }));
  const releaseFailures = await releaseActiveTransferOwners('TRANSFER_CANCELLED');
  if (releaseFailures.length) process.exitCode = 1;
  if (activeContext) {
    try { await diagnoseTransferLocks(activeContext); }
    catch (error) {
      process.exitCode = 1;
      console.error(JSON.stringify({ event: 'transfer-lock-release-failed', failure_code: 'D1_LEASE_DIAGNOSTIC_FAILED', error: safeLogError(error) }));
    }
  }
  process.exit();
}process.once('SIGINT', () => { void handleShutdown('SIGINT'); });
process.once('SIGTERM', () => { void handleShutdown('SIGTERM'); });
export async function diagnoseTransferLocks(ctx) {
  const records = await diagnoseStaleTransfers(ctx);
  console.log(JSON.stringify({ event: 'transfer-lease-diagnostic', dry_run: true, count: records.length, records }));
  return records;
}
export async function makePlan(ctx, options = {}) {
  const maxMovies = options.maxMovies ?? DEFAULT_MAX_MOVIES;
  if (!Number.isSafeInteger(maxMovies) || maxMovies < 1 || maxMovies > MAX_BATCH_MOVIES) throw new Error('Invalid maxMovies');
  const configuredIds = options.movieIds ?? (FILTER_MOVIE_IDS.size ? [...FILTER_MOVIE_IDS] : []);
  const targetIds = [...new Set(configuredIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (targetIds.length > 20) throw new Error('Too many targeted movie IDs');
  const select = "SELECT id,slug,imdb_id,download_sources_json,r2_storage_key,r2_video_bytes FROM movies WHERE publication_status IN ('draft','published')";
  const rows = targetIds.length
    ? await ctx.query(select + ' AND id IN (' + targetIds.map(() => '?').join(',') + ') ORDER BY id', targetIds)
    : await ctx.query(select + " ORDER BY CASE WHEN ingest_status IN ('queued','processing','retry_pending','half','transferring') THEN 0 WHEN ingest_status = 'ready' THEN 2 ELSE 1 END, id LIMIT ?", [maxMovies]);
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
      if (isInfrastructureFailure(error)) throw error;
      const message = safeLogError(error);
      plan.failures.push({ id: row.id, imdbId: row.imdb_id, status: 'retry_pending', error: message });
      console.error(JSON.stringify({ event: 'movie-plan-failed', id: row.id, imdbId: row.imdb_id, status: 'retry_pending', error: message }));
      await markMovieRetryPending(ctx, row.id, error);
    }
  }
  return plan;
}
export async function acquire(ctx, item, attempt = 1, runtime = {}) {
  const deadlineAt = Number.isSafeInteger(runtime.deadlineAt) ? runtime.deadlineAt : null;
  assertMovieDeadline(deadlineAt, item.id);
  const [row] = await ctx.query('SELECT download_sources_json FROM movies WHERE id = ?', [item.id]);
  if (!row) throw new MediaAcquisitionError('SOURCE_INVALID', 'Movie no longer exists');
  assertMovieDeadline(deadlineAt, item.id);
  const source = sourcesOf(row.download_sources_json).find(s => (s.quality || s.resolution)?.toLowerCase() === item.quality);
  let descriptor;
  assertMovieDeadline(deadlineAt, item.id);
  if (attempt > 1 || !source) descriptor = await alternativeDescriptor(item.imdbId, item.quality, source?.url);
  assertMovieDeadline(deadlineAt, item.id);
  if (!descriptor) descriptor = sourceMagnet(row.download_sources_json, item.quality);
  if (!descriptor && /^(?:assets|descriptors)\/[\w.-]+\.(?:torrent|bin)$/.test(source?.descriptorKey || '')) {
    const object = await sendWithRetry(ctx.s3, new GetObjectCommand({ Bucket: ctx.bucket, Key: source.descriptorKey }), { abortSignal: AbortSignal.timeout(requestTimeoutMs) });
    if (!object.ContentLength || object.ContentLength > 2097152) { object.Body?.destroy(); throw new MediaAcquisitionError('SOURCE_INVALID', 'Invalid descriptor size'); }
    descriptor = Buffer.from(await object.Body.transformToByteArray());
    assertMovieDeadline(deadlineAt, item.id);
  }
  if (!descriptor) descriptor = await remoteDescriptor(row.download_sources_json, item.quality);
  assertMovieDeadline(deadlineAt, item.id);
  if (!descriptor) throw new MediaAcquisitionError('SOURCE_INVALID', 'No usable torrent source');

  const work = resolve(mediaRoot, `${item.id}-${item.quality}`);
  await mkdir(work, { recursive: true });
  const filePath = resolve(work, `${item.quality}.mp4`);
  const metadataTimeoutMs = runtime.metadataTimeoutMs ?? Number(process.env.TRANSFER_METADATA_TIMEOUT_SECONDS ?? DEFAULT_METADATA_TIMEOUT_MS / 1000) * 1000;
  const noProgressTimeoutMs = runtime.noProgressTimeoutMs ?? Number(process.env.TRANSFER_NO_PROGRESS_TIMEOUT_SECONDS ?? DEFAULT_NO_PROGRESS_TIMEOUT_MS / 1000) * 1000;
  const cleanupTimeoutMs = runtime.cleanupTimeoutMs ?? Math.max(1, Number(process.env.TRANSFER_CLEANUP_TIMEOUT_SECONDS ?? 5)) * 1000;
  if (![metadataTimeoutMs, noProgressTimeoutMs, cleanupTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 900_000)) throw new Error('Invalid media watchdog timeout');
  const state = {
    startedAt: Date.now(), infoHash: null, expectedBytes: null, metadataReceived: false,
    trackerEvent: null, peerCount: 0, payloadBytes: 0, lastProgressAt: null, failureCode: null, failureStage: null, lastAttemptAt: null,
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
    state.failureStage = acquisitionPhase;
    state.lastAttemptAt = new Date().toISOString();
    state.elapsedMs = Date.now() - state.startedAt;
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
    cleanupPromise ||= destroyTorrentClient(client, cleanupTimeoutMs);
    rejectMetadata?.(reason);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (deadlineAt !== null) {
    trackTimer(setTimeout(() => abort(movieBudgetError(item.id)), Math.max(1, deadlineAt - Date.now())));
  }
  try {
    acquisitionEvent(item, state, 'acquisition-start');
    acquisitionPhase = 'metadata';
    metadataTimer = trackTimer(setTimeout(() => abort(new MediaAcquisitionError('METADATA_TIMEOUT', 'Torrent metadata was not received within the metadata watchdog')), metadataTimeoutMs));
    const clientOptions = { webSeeds: false, maxConns: 30, uploadLimit: 131072 };
    client = await awaitWithAbort(
      () => runtime.createClient || ctx.createClient
        ? (runtime.createClient || ctx.createClient)(clientOptions, item)
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
    const disk = await awaitWithAbort(() => (runtime.statfs || ctx.statfs || statfs)(work), controller.signal);
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
    const validated = await (runtime.validateMp4 || ctx.validateMp4 || validateMp4)(filePath, file.length);
    item.file = filePath;
    item.bytes = validated.bytes;
    acquisitionEvent(item, state, 'payload-complete', { phase: 'validation' });
  } catch (error) {
    const failure = state.failureCode
      ? new MediaAcquisitionError(state.failureCode, state.failureMessage || safeLogError(error), { infoHash: state.infoHash, expectedBytes: state.expectedBytes, payloadBytes: state.payloadBytes })
      : error;
    if (!state.failureCode) state.failureCode = mediaFailureCode(failure);
    state.failureStage ||= acquisitionPhase;
    state.lastAttemptAt ||= new Date().toISOString();
    state.elapsedMs = Date.now() - state.startedAt;
    acquisitionEvent(item, state, 'acquisition-failure', { phase: acquisitionPhase, error: safeLogError(failure) });
    throw failure;
  } finally {
    for (const timer of timers) clearTrackedTimer(timer);
    controller.signal.removeEventListener('abort', onAbort);
    cleanupPromise ||= destroyTorrentClient(client, cleanupTimeoutMs);
    await cleanupPromise;
    await rm(resolve(work, 'pieces'), { recursive: true, force: true });
    if (!item.file) await rm(work, { recursive: true, force: true });
  }
}

function qualityDiagnostic(item) {
  const state = item.mediaDiagnostics || {};
  const code = item.failureCode || state.failureCode || item.skipReason || 'DOWNLOAD_FAILED';
  return {
    quality: item.quality,
    failure_code: code,
    failure_stage: item.failureStage || state.failureStage || null,
    info_hash: state.infoHash || item.infoHash || null,
    payload_bytes: Number.isFinite(Number(item.payloadBytes ?? state.payloadBytes)) ? Number(item.payloadBytes ?? state.payloadBytes) : null,
    elapsed_ms: Number.isFinite(Number(item.elapsedMs ?? state.elapsedMs)) ? Number(item.elapsedMs ?? state.elapsedMs) : null,
    last_attempt_at: item.lastAttemptAt || state.lastAttemptAt || null,
  };
}
function movieFailureDiagnostics(plan, id) {
  const failures = (plan?.files || []).filter(item => item.id === id && item.skipped).map(qualityDiagnostic);
  return JSON.stringify({ type: 'MEDIA_FAILURES', qualities: failures });
}
async function persistPlan(plan, persist) {
  try { return await persist(plan); }
  catch (error) { throw new MediaInfrastructureError('MANIFEST_PERSIST_FAILED', 'Could not persist the media manifest', { cause: safeLogError(error) }); }
}
async function markSkipped(plan, item, persist, reason = 'download-failure') {
  item.failureCode ||= reason;
  item.lastAttemptAt ||= new Date().toISOString();
  item.failureStage ||= item.mediaDiagnostics?.failureStage || 'acquisition';
  item.failureDiagnostic = qualityDiagnostic(item);
  if (!Array.isArray(plan.failures)) plan.failures = [];
  plan.failures = plan.failures.filter(failure => !(failure.id === item.id && failure.quality === item.quality));
  plan.failures.push({ id: item.id, quality: item.quality, ...item.failureDiagnostic });
  item.skipped = true;
  item.skipReason = reason;
  item.file = null;
  item.bytes = null;
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
      error: movieFailureDiagnostics(plan, id),
    };
  }
  return { status: 'FAILED', ingestStatus: 'skipped_unplayable', error: movieFailureDiagnostics(plan, id) };
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
      const failure = new MediaInfrastructureError('D1_STATE_READ_FAILED', 'Could not read movie state before failure marking', { cause: safeLogError(error) });
      console.error(JSON.stringify({ event: 'media-flag-read-failed', id, failure_code: failure.code, error: safeLogError(failure) }));
      throw failure;
    }
    if (!row) throw new MediaInfrastructureError('D1_STATE_READ_FAILED', 'Movie state disappeared before failure marking');
    if (!['queued', 'processing', 'transferring', 'retry_pending', 'half', 'flagged_for_review'].includes(row.ingest_status)) continue;
    if (row.ingest_status === 'transferring' && Number(row.transfer_lease_until) > Math.floor(Date.now() / 1000)) throw new MediaInfrastructureError('TRANSFER_OWNERSHIP_CONFLICT', 'Active transfer ownership prevented failure marking');
    try {
      assertLegalTransition(row.ingest_status, state.ingestStatus);
const result = await ctx.query("UPDATE movies SET ingest_status = ?, transfer_error = ?, transfer_token = NULL, transfer_lease_until = NULL, updated_at = ? WHERE id = ? AND ingest_status = ? AND (ingest_status <> 'transferring' OR transfer_lease_until IS NULL OR transfer_lease_until <= unixepoch()) RETURNING id", [state.ingestStatus, state.error, new Date().toISOString(), id, row.ingest_status]);
      if (!result.length) throw new MediaInfrastructureError('D1_STATE_UPDATE_FAILED', 'Movie failure state was not updated');
      marked += 1;
      if (state.status === 'HALF') half += 1;
      console.warn(JSON.stringify({ event: 'media_flagged', id, status: state.ingestStatus, reason: state.error }));
    } catch (error) {
      const failure = error instanceof MediaInfrastructureError ? error : new MediaInfrastructureError('D1_STATE_UPDATE_FAILED', 'Could not persist movie failure state', { cause: safeLogError(error) });
      console.error(JSON.stringify({ event: 'media-flag-state-transition-failed', id, failure_code: failure.code, error: safeLogError(failure) }));
      throw failure;
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
      assertMovieDeadline(options.deadlineAt, item.id);
      await withMovieDeadline(() => acquireItem(ctx, item, attempt, { deadlineAt: options.deadlineAt }), options.deadlineAt, item.id);
      assertMovieDeadline(options.deadlineAt, item.id);
      await persistPlan(plan, persist);
      return true;
    } catch (error) {
      if (isInfrastructureFailure(error)) throw error;
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
        const delay = 5000 * 2 ** (attempt - 1);
        assertMovieDeadline(options.deadlineAt, item.id);
        if (Number.isSafeInteger(options.deadlineAt) && Date.now() + delay >= options.deadlineAt) throw movieBudgetError(item.id);
        await wait(delay);
      }
    }
  }
  return false;
}
export async function prepareOne(ctx, plan, options = {}) {
  if (options.onlyItem) {
    const item = options.onlyItem;
    const persist = options.saveManifest || saveManifest;
    if (item.verified || item.skipped || item.file) return item.file ? item : null;
    try {
      if (await acquireWithRetries(ctx, plan, item, 3, options)) return item;
      if (!item.nonRetryableFailure) console.warn('Pass 1 failed for Movie ' + item.id + '. Queuing for final retry pass.');
      await markSkipped(plan, item, persist, item.failureCode || (item.nonRetryableFailure ? 'validation-failure' : 'download-failure'));
    } catch (error) {
      if (error?.code === 'MOVIE_TIME_BUDGET_EXCEEDED') {
        item.failureCode = 'MOVIE_TIME_BUDGET_EXCEEDED';
        item.failureStage = 'time_budget';
        await markSkipped(plan, item, persist, item.failureCode);
        return null;
      }
      if (isInfrastructureFailure(error)) throw error;
      console.error(JSON.stringify({ event: 'movie-preparation-failed', id: item.id, quality: item.quality, error: safeLogError(error) }));
      await markSkipped(plan, item, persist, 'download-failure');
    }
    return null;
  }
  const persist = options.saveManifest || saveManifest;
  for (const item of plan.files.filter(f => !f.verified && !f.skipped && !f.file)) {
    try {
      if (await acquireWithRetries(ctx, plan, item, 3, options)) return item;
      if (!item.nonRetryableFailure) console.warn(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Pass 1 failed for Movie ${item.id}. Queuing for final retry pass.`);
       await markSkipped(plan, item, persist, item.failureCode || (item.nonRetryableFailure ? 'validation-failure' : 'download-failure'));
    } catch (error) {
      if (isInfrastructureFailure(error)) throw error;
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
          await markSkipped(plan, item, persistQueued, item.failureCode || 'validation-failure');
          if (!permanentlyFailedIds.includes(item.id)) permanentlyFailedIds.push(item.id);
        } else {
          console.warn('Pass 1 failed for Movie ' + item.id + '. Queuing for final retry pass.');
          failedQueue.push(item);
        }
      } catch (error) {
        if (isInfrastructureFailure(error)) throw error;
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
          if (isInfrastructureFailure(error)) throw error;
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
  await persistPlan(plan, persist);
  return { prepared, skipped: plan.files.filter(f => f.skipped).length, permanentlyFailedIds, markedFailed: 0 };
}
export async function commitItem(ctx, item, options = {}) {
  const transferToken = options.transferToken;
  if (typeof transferToken !== 'string' || transferToken.length < 16) throw new Error('TRANSFER_OWNER_REQUIRED');
  qualityWorkflowEvent(item, 'r2-verify-start');
  let object;
  try { object = await ctx.head(item.key); }
  catch (error) { throw new MediaInfrastructureError('R2_VERIFY_FAILED', 'R2 HEAD failed before D1 commit', { cause: safeLogError(error) }); }
  if (!validVideo(object) || object.ContentLength !== item.bytes) throw new MediaInfrastructureError('R2_VERIFY_FAILED', 'R2 verification failed before D1 commit');
  qualityWorkflowEvent(item, 'r2-verify-complete');
  let row;
  try { [row] = await ctx.query('SELECT download_sources_json, revision, ingest_status, transfer_token FROM movies WHERE id = ?', [item.id]); }
  catch (error) { throw new MediaInfrastructureError('D1_COMMIT_FAILED', 'D1 ownership read failed', { cause: safeLogError(error) }); }
  if (!row || row.transfer_token !== transferToken || row.ingest_status !== 'transferring') throw new MediaInfrastructureError('D1_COMMIT_FAILED', 'TRANSFER_OWNERSHIP_LOST');
  const sources = sourcesOf(row.download_sources_json);
  const existing = sources.find(s => (s.quality || s.resolution)?.toLowerCase() === item.quality);
  const downloadUrl = item.slug ? (siteOrigin + '/api/download/resolve?slug=' + encodeURIComponent(item.slug) + '&quality=' + item.quality) : existing?.download_url || null;
  const updated = { ...existing, quality: item.quality, resolution: item.quality, r2StorageKey: item.key, r2Bytes: item.bytes, size: String((item.bytes / 1024 ** 3).toFixed(2)) + ' GB', download_url: downloadUrl };
  const next = [...sources.filter(s => (s.quality || s.resolution)?.toLowerCase() !== item.quality), updated];
  let verifiedQualities = 0;
  for (const q of ['720p','1080p']) {
    const s = next.find(s => (s.quality || s.resolution)?.toLowerCase() === q);
    let h;
    try { h = await ctx.head(s?.r2StorageKey); }
    catch (error) { throw new MediaInfrastructureError('R2_VERIFY_FAILED', 'R2 quality verification failed', { cause: safeLogError(error) }); }
    if (s && validVideo(h) && h.ContentLength === s.r2Bytes) verifiedQualities += 1;
  }
  const ready = verifiedQualities === 2;
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const metadataFields = METADATA_COLUMNS.filter((field) => Object.prototype.hasOwnProperty.call(metadata, field));
  const metadataAssignments = metadataFields.length ? ',' + metadataFields.map((field) => field + '=?').join(',') : '';
  const primary = next.find(s => s.quality === '1080p' && s.r2StorageKey) || updated;
  const nextStatus = ready ? 'ready' : verifiedQualities > 0 ? 'half' : 'retry_pending';
  assertLegalTransition(row.ingest_status, nextStatus);
  let result;
  try {
    result = await ctx.query("UPDATE movies SET download_sources_json=?,r2_storage_key=?,r2_video_bytes=?,ingest_status=?,transfer_token=NULL,transfer_lease_until=NULL,transfer_error=NULL,revision=revision+1,updated_at=?" + metadataAssignments + " WHERE id=? AND revision=? AND publication_status IN ('draft','published') AND ingest_status='transferring' AND transfer_token=? RETURNING id", [JSON.stringify({ status: verifiedQualities > 0 ? 'available' : 'pending', sources: next }), primary.r2StorageKey, primary.r2Bytes, nextStatus, new Date().toISOString(), ...metadataFields.map((field) => metadata[field]), item.id, row.revision, transferToken]);
  } catch (error) {
    throw new MediaInfrastructureError('D1_COMMIT_FAILED', 'Guarded D1 mapping commit failed', { cause: safeLogError(error) });
  }
  if (!result?.length) throw new MediaInfrastructureError('D1_COMMIT_FAILED', 'D1 changed or transfer ownership was lost; retry required');
  qualityWorkflowEvent(item, 'd1-commit-complete', { committed_status: nextStatus, verified_qualities: verifiedQualities });
}
async function claimItem(ctx, item) {
  const attemptId = randomUUID();
  const token = item.quality + ':' + attemptId;
  let claim;
  try {
    claim = await claimTransfer(ctx, { id: Number(item.id), quality: item.quality, token, leaseSeconds: 3600 });
  } catch (error) {
    throw new MediaInfrastructureError('TRANSFER_CLAIM_FAILED', 'Transfer lease claim failed', { cause: safeLogError(error) });
  }
  if (!claim.claimed) throw new MediaInfrastructureError('TRANSFER_ALREADY_OWNED', 'Transfer lease is already owned or the movie is not claimable');
  item.attemptId = attemptId;
  item.transferToken = token;
  item.transferLeaseUntil = claim.leaseUntil;
  return token;
}
async function cleanupStagedItem(item) {
  const candidate = typeof item.file === 'string' ? resolve(item.file) : null;
  if (!candidate || !candidate.startsWith(mediaRoot + sep)) return;
  try {
    await rm(dirname(candidate), { recursive: true, force: true });
  } catch (error) {
    throw new MediaInfrastructureError('STAGED_CLEANUP_FAILED', 'Could not remove staged media artifacts', { cause: safeLogError(error) });
  }
  item.file = null;
  item.bytes = null;
}

async function processItem(ctx, item, sync, deadlineAt) {
  assertMovieDeadline(deadlineAt, item.id);
  const token = await withMovieDeadline(() => claimItem(ctx, item), deadlineAt, item.id);
  activeTransferOwners.set(token, { ctx, id: Number(item.id) });
  let phase = 'r2_upload';
  try {
    qualityWorkflowEvent(item, 'r2-upload-start');
    if (!item.verified) await withMovieDeadline(() => sync(item, { deadlineAt }), deadlineAt, item.id);
    qualityWorkflowEvent(item, 'r2-upload-complete');
    phase = 'd1_commit';
    qualityWorkflowEvent(item, 'd1-commit-start');
    await withMovieDeadline(() => commitItem(ctx, item, { transferToken: token }), deadlineAt, item.id);
    item.verified = true;
    await cleanupStagedItem(item);
    return true;
  } catch (error) {
    const fatalError = error?.code === 'MOVIE_TIME_BUDGET_EXCEEDED'
      ? error
      : isInfrastructureFailure(error)
      ? error
      : new MediaInfrastructureError(phase === 'r2_upload' ? 'R2_UPLOAD_FAILED' : 'D1_COMMIT_FAILED', phase === 'r2_upload' ? 'R2 upload operation failed' : 'Guarded D1 commit operation failed', { cause: safeLogError(error) });
    let nextState = 'retry_pending';
    let stateReadFailure = null;
    try {
      const rows = await ctx.query('SELECT download_sources_json FROM movies WHERE id = ?', [item.id]);
      const existing = rows[0] ? sourcesOf(rows[0].download_sources_json) : [];
      if (existing.some((source) => source.r2StorageKey && Number(source.r2Bytes) > 0)) nextState = 'half';
    } catch (readError) {
      stateReadFailure = new MediaInfrastructureError('D1_STATE_READ_FAILED', 'Could not read media state while releasing transfer', { cause: safeLogError(readError) });
    }
    const failureCode = item.mediaDiagnostics?.failureCode || mediaFailureCode(fatalError) || fatalError?.code || 'TRANSFER_FAILED';
    qualityWorkflowEvent(item, 'transfer-failure', { phase, failure_code: failureCode, error: safeLogError(error) });
    let releaseFailure = null;
    try {
      const released = await releaseTransfer(ctx, { id: Number(item.id), token, nextState, error: failureCode + ': ' + safeLogError(fatalError) });
      if (!released) releaseFailure = new MediaInfrastructureError('LEASE_RELEASE_UNCONFIRMED', 'Transfer lease release did not update the owning row');
    } catch (releaseError) {
      releaseFailure = releaseError instanceof MediaInfrastructureError
        ? releaseError
        : new MediaInfrastructureError('LEASE_RELEASE_FAILED', 'Transfer lease release failed', { cause: safeLogError(releaseError) });
    }
    let cleanupFailure = null;
    try { await cleanupStagedItem(item); }
    catch (cleanupError) { cleanupFailure = cleanupError; }
    if (cleanupFailure) {
      console.error(JSON.stringify({ event: 'staged-cleanup-failed', movie_id: item.id, failure_code: cleanupFailure.code, error: safeLogError(cleanupFailure) }));
      throw cleanupFailure;
    }
    if (releaseFailure) {
      console.error(JSON.stringify({ event: 'transfer-lease-release-failed', movie_id: item.id, failure_code: releaseFailure.code, error: safeLogError(releaseFailure) }));
      throw releaseFailure;
    }
    if (stateReadFailure) throw stateReadFailure;
    throw fatalError;
  } finally {
    activeTransferOwners.delete(token);
  }
}
async function markMovieBudgetExceeded(plan, items, persist) {
  for (const item of items.filter(current => !current.verified && !current.skipped)) {
    item.failureCode = 'MOVIE_TIME_BUDGET_EXCEEDED';
    item.failureStage = 'time_budget';
    await markSkipped(plan, item, persist, item.failureCode);
  }
}

async function processMovieGroup(ctx, plan, items, sync, options, persist, enrichMovie) {
  const id = Number(items[0]?.id);
  const budgetMs = Number.isSafeInteger(options.movieTimeBudgetMs) && options.movieTimeBudgetMs > 0
    ? options.movieTimeBudgetMs
    : MOVIE_TIME_BUDGET_MS;
  const deadlineAt = Date.now() + budgetMs;
  const ordered = [...items].sort((left, right) => (left.quality === '720p' ? 0 : 1) - (right.quality === '720p' ? 0 : 1));

  for (const item of ordered) {
    if (item.verified || item.skipped) continue;
    if (Date.now() >= deadlineAt) {
      await markMovieBudgetExceeded(plan, ordered, persist);
      break;
    }
    try {
      const prepared = item.file
        ? item
        : await prepareOne(ctx, plan, { ...options.prepareOptions, onlyItem: item, deadlineAt, saveManifest: persist });
      if (!prepared) continue;
      await processItem(ctx, item, sync, deadlineAt);
      item.verified = true;
      await persistPlan(plan, persist);
      console.log(JSON.stringify({ event: 'verified', id: item.id, quality: item.quality, remaining: plan.files.filter(file => !file.verified && !file.skipped).length }));
    } catch (error) {
      if (error?.code === 'MOVIE_TIME_BUDGET_EXCEEDED') {
        await markMovieBudgetExceeded(plan, ordered, persist);
        console.warn(JSON.stringify({ event: 'movie-time-budget-exceeded', movie_id: id, failure_code: error.code }));
        break;
      }
      if (isInfrastructureFailure(error)) throw error;
      const failureCode = mediaFailureCode(error) || error?.code || 'TRANSFER_FAILED';
      item.failureCode = failureCode;
      if (failureCode === 'MOVIE_TIME_BUDGET_EXCEEDED') item.failureStage = 'time_budget';
      await markSkipped(plan, item, persist, failureCode);
      console.warn(JSON.stringify({ event: 'movie-quality-failed', movie_id: id, quality: item.quality, failure_code: failureCode, error: safeLogError(error) }));
    }
  }

  if (ordered.some(item => item.skipped)) {
    try { await markPermanentlyFailed(ctx, [id], plan); }
    catch (error) { console.error(JSON.stringify({ event: 'movie-final-state-failed', movie_id: id, failure_code: error?.code || 'D1_STATE_UPDATE_FAILED', error: safeLogError(error) })); }
  }
  if (ordered.some(item => item.verified)) await enrichMovie(id);
}

export async function drainCloudPlan(plan, sync, _options = {}) {
  const options = _options || {};
  const ctx = options.context || await context();
  const persist = options.saveManifest || saveManifest;
  const enriched = new Set();
  const groups = [...new Map(plan.files.map(item => [Number(item.id), item])).keys()]
    .map(id => plan.files.filter(item => Number(item.id) === id));
  let persistTail = Promise.resolve();
  const persistQueued = nextPlan => {
    const next = persistTail.then(() => persist(nextPlan));
    persistTail = next.catch(() => {});
    return next;
  };
  activeContext = ctx;
  const enrichMovie = async (id) => {
    if (typeof options.enrich !== 'function' || enriched.has(Number(id))) return;
    enriched.add(Number(id));
    try { await options.enrich(ctx, Number(id)); }
    catch (error) {
      if (isInfrastructureFailure(error)) throw error;
      console.warn(JSON.stringify({ event: 'enrichment-failed', movie_id: Number(id), failure_code: 'ENRICHMENT_FAILED', error: safeLogError(error) }));
    }
  };
  try {
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= groups.length) return;
        const items = groups[index];
        try {
          await processMovieGroup(ctx, plan, items, sync, options, persistQueued, enrichMovie);
        } catch (error) {
          if (isInfrastructureFailure(error)) throw error;
          console.error(JSON.stringify({ event: 'movie-worker-failed', movie_id: Number(items[0]?.id), failure_code: error?.code || 'MOVIE_PROCESSING_FAILED', error: safeLogError(error) }));
          await markMovieBudgetExceeded(plan, items, persistQueued);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, groups.length) }, worker));
    await persistTail;
    console.log('[complete] cloud snapshot verified in R2 and D1');
  } finally {
    let finalFailure = null;
    try { await diagnoseTransferLocks(ctx); }
    catch (error) { finalFailure = new MediaInfrastructureError('D1_LEASE_DIAGNOSTIC_FAILED', 'Could not verify scoped lease cleanup', { cause: safeLogError(error) }); }
    if (activeContext === ctx) activeContext = null;
    try { ctx.s3?.destroy?.(); }
    catch (error) { finalFailure ||= new MediaInfrastructureError('R2_CLIENT_CLEANUP_FAILED', 'Could not destroy the R2 client', { cause: safeLogError(error) }); }
    if (finalFailure) throw finalFailure;
  }
}if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let ctx;
  let summary;
  let fatalError;
  try {
    ctx = await cliContext();
    await mkdir(mediaRoot, { recursive: true });
    await diagnoseTransferLocks(ctx);
    const maxMovies = maxMoviesFromArgs();
    const plan = await makePlan(ctx, { maxMovies });
    await saveManifest(plan);
    if (process.argv.includes('--descriptor-only')) {
      summary = { event: 'prepared', maxMovies, mode: 'lazy-quality-transfer', artwork: { scanned: 0, updated: 0 }, failedMovies: plan.failures.length, total: plan.files.length, verified: plan.files.filter(f => f.verified).length, prepared: 0, skipped: plan.files.filter(f => f.skipped).length, permanentlyFailedIds: [], markedFailed: 0 };
    } else {
      const result = await prepareAll(ctx, plan);
      summary = { event: 'prepared', maxMovies, artwork: { scanned: 0, updated: 0 }, failedMovies: plan.failures.length, total: plan.files.length, verified: plan.files.filter(f => f.verified).length, ...result };
    }
  } catch (error) {
    fatalError = error;
  } finally {
    await cleanupRuntime();
    if (ctx) {
      try { await diagnoseTransferLocks(ctx); }
      catch (error) {
        const failure = new MediaInfrastructureError('D1_LEASE_DIAGNOSTIC_FAILED', 'Could not verify scoped lease cleanup', { cause: safeLogError(error) });
        console.error(JSON.stringify({ event: 'transfer-lock-release-failed', failure_code: failure.code, error: safeLogError(failure) }));
        fatalError ||= failure;
      }
    }
    activeContext = null;
    ctx?.s3.destroy();
  }
  if (fatalError) {
    console.error(JSON.stringify({ event: 'prepare-fatal-error', error: safeLogError(fatalError) }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(summary));
  }
}

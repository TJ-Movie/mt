import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const DEFAULT_DATABASE_ID = 'a8e45cf6-effe-430f-9f7d-3ff85aea0acc';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const d1Token = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID || process.env.D1_DATABASE_ID || process.env.CLOUDFLARE_DATABASE_ID || DEFAULT_DATABASE_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET_NAME || 'flixlyra-media';
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || 'https://flixlyra.com/media').replace(/\/+$/, '');
const API_ENDPOINTS = [
  'https://movies-api.accel.li/api/v2/movie_details.json',
  'https://yts.mx/api/v2/movie_details.json',
];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RUN_EXECUTE = process.argv.includes('--execute');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, maximum = 5000) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, maximum) : '';
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

function isPlaceholderArtwork(value) {
  const candidate = text(value, 1000);
  return !candidate || candidate.startsWith('/') || /\/(?:rsg|nss)\.png(?:$|[?#])/i.test(candidate);
}

function sourceImage(value) {
  const candidate = text(value, 1000);
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const allowed = hostname === 'image.tmdb.org' ||
      hostname === 'images.metahub.space' ||
      hostname === 'yts.mx' || hostname.endsWith('.yts.mx') ||
      hostname === 'yts.lt' || hostname.endsWith('.yts.lt') ||
      hostname === 'yts.am' || hostname.endsWith('.yts.am') ||
      hostname === 'yts.rs' || hostname.endsWith('.yts.rs') ||
      hostname === 'yts.pm' || hostname.endsWith('.yts.pm');
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceImageCandidate(value) {
  const direct = sourceImage(value);
  if (direct) return direct;
  const path = text(value, 1000);
  if (/^\/[A-Za-z0-9_./-]+\.(?:jpe?g|png|webp)(?:\?.*)?$/i.test(path)) {
    return sourceImage(`https://image.tmdb.org/t/p/original${path}`);
  }
  return null;
}

function fallbackImageSources(movie, imdbId, kind) {
  const id = text(imdbId, 16);
  if (!/^tt\d{7,10}$/.test(id)) return [];

  // MetaHub resolves the IMDb ID to an image without requiring a TMDB API key.
  // Keep these after the YTS fields so a working YTS asset always wins.
  const sizes = kind === 'poster' ? ['original', 'large', 'medium'] : ['large', 'medium', 'original'];
  return sizes.map((size) => sourceImage(`https://images.metahub.space/poster/${size}/${id}.jpg`)).filter(Boolean);
}
function artworkKey(id, kind) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1 || !['poster', 'backdrop'].includes(kind)) return null;
  return `artworks/${Number(id)}/${kind}.jpg`;
}

function publicUrl(key) {
  return `${PUBLIC_BASE}/${key}`;
}

function metadataDirector(value) {
  if (typeof value === 'string') return text(value, 160);
  if (!Array.isArray(value)) return '';
  return value.map((entry) => isRecord(entry) ? entry.name || entry.director : entry)
    .map((entry) => text(entry, 160)).filter(Boolean).slice(0, 3).join(', ');
}

function metadataCast(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((entry) => {
    if (typeof entry === 'string') {
      const actor = text(entry, 120);
      return actor ? [actor] : [];
    }
    if (!isRecord(entry)) return [];
    const actor = text(entry.name || entry.actor, 120);
    if (!actor) return [];
    const character = text(entry.character_name || entry.character, 120);
    const image = sourceImage(entry.url_small_image || entry.image);
    return [{ actor, ...(character ? { character } : {}), ...(image ? { image } : {}) }];
  });
}

function trailerUrl(value) {
  const code = text(value, 64);
  return /^[A-Za-z0-9_-]{11}$/.test(code) ? `https://www.youtube.com/watch?v=${code}` : null;
}

async function queryD1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${d1Token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || payload.result?.some((item) => item.success === false)) {
    throw new Error(`D1 query failed (${response.status})`);
  }
  return payload.result.flatMap((item) => item.results || []);
}

async function fetchMetadata(imdbId) {
  if (!/^tt\d{7,10}$/.test(String(imdbId || ''))) return null;
  let lastError;
  const query = new URLSearchParams({ imdb_id: String(imdbId), with_images: 'true', with_cast: 'true' });
  for (const endpoint of API_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}?${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`YTS_${response.status}`);
      const payload = await response.json();
      const movie = isRecord(payload?.data?.movie) ? payload.data.movie : null;
      if (movie) return movie;
      throw new Error('YTS_INVALID_RESPONSE');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`YTS_UNAVAILABLE: ${safeError(lastError || new Error('no response'))}`);
}

async function downloadImage(url) {
  const source = sourceImage(url);
  if (!source) throw new Error('IMAGE_SOURCE_NOT_ALLOWED');
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`IMAGE_${response.status}`);
  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)) throw new Error('IMAGE_CONTENT_TYPE_NOT_ALLOWED');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('IMAGE_EMPTY_OR_TOO_LARGE');
  return { bytes, contentType };
}

function imageSources(movie, kind, imdbId) {
  // YTS deployments have returned these fields inconsistently. Keep the
  // canonical payload order stable, then try compatible legacy/path fields.
  const fields = [
    'large_cover_image', 'medium_cover_image',
    'background_image', 'background_image_original',
    ...(kind === 'poster'
      ? ['poster_url', 'poster', 'tmdb_poster_url', 'tmdb_poster_path', 'imdb_poster_url']
      : ['backdrop_url', 'backdrop', 'tmdb_backdrop_url', 'tmdb_backdrop_path', 'imdb_backdrop_url']),
  ];
  return [...new Set([
    ...fields.map((field) => sourceImageCandidate(movie?.[field])).filter(Boolean),
    ...fallbackImageSources(movie, imdbId, kind),
  ])];
}
async function uploadArtwork(s3, row, movie, kind) {
  const key = artworkKey(row.id, kind);
  if (!key) throw new Error('INVALID_ARTWORK_KEY');
  const sources = imageSources(movie, kind, row.imdb_id);
  if (!sources.length) {
    console.warn(JSON.stringify({ event: 'artwork-source-missing', id: row.id, imdbId: row.imdb_id, kind, action: 'metadata-only-update' }));
    return null;
  }
  let lastError;
  for (const source of sources) {
    try {
      const downloaded = await downloadImage(source);
      if (!RUN_EXECUTE) return publicUrl(key);
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: downloaded.bytes,
        ContentType: downloaded.contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: { source: 'yts-force-backfill', movieId: String(row.id), kind },
      }));
      const verified = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      if (!verified.ContentLength || Number(verified.ContentLength) !== downloaded.bytes.byteLength) throw new Error('R2_ARTWORK_VERIFY_FAILED');
      return publicUrl(key);
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(JSON.stringify({ event: 'artwork-upload-warning', id: row.id, imdbId: row.imdb_id, kind, error: safeError(lastError || new Error('R2_ARTWORK_UPLOAD_FAILED')), action: 'metadata-only-update' }));
  return null;
}

function updatesFor(movie) {
  return {
    director: metadataDirector(movie.director),
    cast_json: JSON.stringify(metadataCast(movie.cast)),
    official_watch_url: trailerUrl(movie.yt_trailer_code),
  };
}

async function main() {
  if (!accountId || !d1Token) throw new Error('Cloudflare account ID and D1 API token are required (supported fallbacks: CLOUDFLARE_ACCOUNT_ID/R2_ACCOUNT_ID/CF_ACCOUNT_ID and CLOUDFLARE_D1_TOKEN/CLOUDFLARE_API_TOKEN/CF_API_TOKEN)');
  if (RUN_EXECUTE && (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY)) throw new Error('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for --execute');
  const rows = await queryD1('SELECT id, imdb_id, poster, backdrop, director, cast_json, official_watch_url FROM movies ORDER BY id');
  const s3 = RUN_EXECUTE ? new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    maxAttempts: 3,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  }) : null;
  let matched = 0;
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const needsBackfill = isPlaceholderArtwork(row.poster) || isPlaceholderArtwork(row.backdrop) || !text(row.director, 160) || text(row.director, 160).toLowerCase() === 'pending editorial review';
    if (!needsBackfill) continue;
    matched += 1;
    try {
      const movie = await fetchMetadata(row.imdb_id);
      const updates = updatesFor(movie);
      if (isPlaceholderArtwork(row.poster)) {
        const poster = await uploadArtwork(s3, row, movie, 'poster');
        if (poster) updates.poster = poster;
      }
      if (isPlaceholderArtwork(row.backdrop)) {
        const backdrop = await uploadArtwork(s3, row, movie, 'backdrop');
        if (backdrop) updates.backdrop = backdrop;
      }
      const fields = Object.entries(updates).filter(([, value]) => value !== null && value !== '');
      if (!fields.length) throw new Error('YTS_METADATA_EMPTY');
      console.log(JSON.stringify({ event: RUN_EXECUTE ? 'force-backfill-update' : 'force-backfill-plan', id: row.id, imdbId: row.imdb_id, fields: fields.map(([field]) => field) }));
      if (RUN_EXECUTE) {
        await queryD1(`UPDATE movies SET ${fields.map(([field]) => `${field} = ?`).join(', ')} , revision = revision + 1, updated_at = ? WHERE id = ?`, [...fields.map(([, value]) => value), new Date().toISOString(), row.id]);
      }
      updated += 1;
    } catch (error) {
      failed += 1;
      console.warn(JSON.stringify({ event: 'force-backfill-warning', id: row.id, imdbId: row.imdb_id, error: safeError(error) }));
    }
  }
  s3?.destroy();
  console.log(JSON.stringify({ event: 'force-backfill-complete', mode: RUN_EXECUTE ? 'execute' : 'dry-run', totalMovies: rows.length, matched, updated, failed }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'force-backfill-fatal', error: safeError(error) }));
  process.exitCode = 1;
});

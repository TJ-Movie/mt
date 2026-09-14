import 'server-only';
import { AwsClient } from 'aws4fetch';
import { getDatabase, getMediaBucket, getPublishedMovie } from '../db';
import { getRuntimeControls } from './security/runtime-controls';
import { rightsBlockers, validVideoRecord } from './download-readiness';
import type { Movie } from './movies.ts';

export function r2SigningConfigured(): boolean {
  return Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY &&
    /^[a-f0-9]{32}$/.test(process.env.R2_ACCOUNT_ID ?? '') && /^[a-z0-9-]+$/.test(process.env.R2_BUCKET_NAME ?? ''));
}

type SourceRecord = {
  quality?: unknown;
  resolution?: unknown;
  r2StorageKey?: unknown;
  r2Bytes?: unknown;
  r2_storage_key?: unknown;
  r2_video_bytes?: unknown;
  r2Key?: unknown;
  bytes?: unknown;
  storageKey?: unknown;
  r2?: { key?: unknown; bytes?: unknown };
};

function sourceData(source: unknown): { key?: string; bytes?: number } {
  if (!source || typeof source !== 'object') return {};
  const record = source as SourceRecord;
  const rawKey = record.r2StorageKey ?? record.r2_storage_key ?? record.r2Key ?? record.storageKey ?? record.r2?.key;
  const rawBytes = record.r2Bytes ?? record.r2_video_bytes ?? record.bytes ?? record.r2?.bytes;
  const bytes = typeof rawBytes === 'string' && /^\d+$/.test(rawBytes) ? Number(rawBytes) : rawBytes;
  return {
    key: typeof rawKey === 'string' ? rawKey : undefined,
    bytes: typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined,
  };
}

function storedSources(json: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(json || '{}');
    if (Array.isArray(parsed)) return parsed;
    return parsed && typeof parsed === 'object' && Array.isArray((parsed as { sources?: unknown }).sources)
      ? (parsed as { sources: unknown[] }).sources
      : [];
  } catch {
    return [];
  }
}

function sourceQuality(source: unknown): string {
  if (!source || typeof source !== 'object') return '';
  const record = source as SourceRecord;
  const value = typeof record.quality === 'string' ? record.quality : typeof record.resolution === 'string' ? record.resolution : '';
  return value.toLowerCase();
}

function inferredPrimaryQuality(row: { storage_key: string | null; r2_storage_key: string | null }): '720p' | '1080p' | undefined {
  const descriptor = /-(720p|1080p)\.(?:torrent|bin)$/i.exec(row.storage_key ?? '')?.[1];
  const object = /\/(720p|1080p)\.mp4$/i.exec(row.r2_storage_key ?? '')?.[1];
  const quality = (descriptor ?? object)?.toLowerCase();
  return quality === '720p' || quality === '1080p' ? quality : undefined;
}

async function verifiedR2Video(key: string | undefined, bytes: number | undefined) {
  if (typeof key !== 'string') return null;
  const object = await getMediaBucket().head(key);
  const legacyContainer = key.endsWith('/data.bin');
  const contentType = object?.httpMetadata?.contentType;
  const typeOkay = contentType === 'video/mp4' || (legacyContainer && contentType === 'application/octet-stream');
  const verifiedBytes = bytes ?? object?.size;
  if (!object || !validVideoRecord(key, verifiedBytes) || object.size !== verifiedBytes || !typeOkay) return null;
  return { key, bytes: verifiedBytes };
}

function keyMatchesQuality(key: string, quality: '720p' | '1080p'): boolean {
  const encodedQuality = /\/(720p|1080p)\.mp4$/i.exec(key)?.[1]?.toLowerCase();
  return !encodedQuality || encodedQuality === quality;
}

export async function readyVideo(slug: string, requestedQuality?: string) {
  const movie = await getPublishedMovie(slug);
  if (!movie || !getRuntimeControls().externalLinksEnabled || rightsBlockers(movie).length) return null;
  const row = await getDatabase().prepare(
    'SELECT storage_key, r2_storage_key, r2_video_bytes, download_sources_json FROM movies WHERE slug = ?',
  ).bind(slug).first<{ storage_key: string | null; r2_storage_key: string | null; r2_video_bytes: number | null; download_sources_json: string }>();
  if (!row) return null;
  const primaryKey = row?.r2_storage_key;
  const primaryBytes = row?.r2_video_bytes;
  const quality = /^(720p|1080p)$/.test(requestedQuality || '') ? requestedQuality as '720p' | '1080p' : undefined;
  const primaryQuality = inferredPrimaryQuality(row);
  if (!quality) {
    if (typeof primaryKey !== 'string' || typeof primaryBytes !== 'number' || !validVideoRecord(primaryKey, primaryBytes)) return null;
    return { movie, key: primaryKey, bytes: primaryBytes, servedQuality: primaryQuality };
  }

  const sources = storedSources(row.download_sources_json);
  const requestedSource = sources.find((source) => sourceQuality(source) === quality);
  const requested = sourceData(requestedSource);
  const candidates: { key?: string; bytes?: number }[] = [requested];
  if (!requested.key && primaryQuality === quality && typeof primaryKey === 'string' && typeof primaryBytes === 'number') {
    candidates.push({ key: primaryKey, bytes: primaryBytes });
  }
  for (const candidate of candidates) {
    if (candidate.key && !keyMatchesQuality(candidate.key, quality)) continue;
    const video = await verifiedR2Video(candidate.key, candidate.bytes);
    if (video) return { movie, ...video, requestedQuality: quality, servedQuality: quality };
  }

  return null;
}

export async function availableQualitiesForMovie(movie: Movie): Promise<('720p' | '1080p')[]> {
  const available: ('720p' | '1080p')[] = [];
  const sources = movie.downloadSources ?? [];
  for (const quality of ['720p', '1080p'] as const) {
    const source = sources.find((item) => String(item.quality ?? item.resolution).toLowerCase() === quality);
    const candidate = sourceData(source);
    if (candidate.key && keyMatchesQuality(candidate.key, quality) && await verifiedR2Video(candidate.key, candidate.bytes)) available.push(quality);
  }
  return available;
}

/**
 * Return the quality state already persisted by the D1 mapper after an R2
 * verification. Public list responses use this bounded metadata path; the
 * download resolver still performs a fresh R2 HEAD before serving a file.
 */
export function availableQualitiesFromD1(movie: Movie): ('720p' | '1080p')[] {
  return (['720p', '1080p'] as const).filter((quality) => movie.availableQualities?.includes(quality));
}

export async function availableQualitiesForSlug(slug: string): Promise<('720p' | '1080p')[]> {
  const movie = await getPublishedMovie(slug);
  return movie ? availableQualitiesForMovie(movie) : [];
}

export async function signedVideoUrl(video: NonNullable<Awaited<ReturnType<typeof readyVideo>>>): Promise<string | null> {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accessKeyId || !secretAccessKey || !account || !/^[a-f0-9]{32}$/.test(account) || !bucket || !/^[a-z0-9-]+$/.test(bucket)) return null;
  try {
  const object = await getMediaBucket().head(video.key);
  const contentType = object?.httpMetadata?.contentType;
  const legacyContainer = /^assets\/[0-9a-f-]+\/data\.bin$/.test(video.key);
  if (!object || object.size !== video.bytes || (contentType !== 'video/mp4' && !(legacyContainer && contentType === 'application/octet-stream'))) return null;
  // oxlint-disable-next-line no-control-regex -- strip control characters from download filenames.
  const title = video.movie.title.replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').slice(0, 120) || 'Movie';
  const ascii = title.replace(/[^\x20-\x7e]/g, '_');
  const url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${video.key}`);
  url.searchParams.set('X-Amz-Expires', '120');
  url.searchParams.set('response-content-type', 'video/mp4');
  url.searchParams.set('response-content-disposition', `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encodeURIComponent(title + '.mp4').replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  return (await client.sign(url, { method: 'GET', aws: { signQuery: true } })).url;
  } catch {
    return null;
  }
}

import 'server-only';
import { AwsClient } from 'aws4fetch';
import { getDatabase, getMediaBucket, getPublishedMovie } from '../db';
import { getRuntimeControls } from './security/runtime-controls';
import { rightsBlockers, validVideoRecord } from './download-readiness';

export function r2SigningConfigured(): boolean {
  return Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY &&
    /^[a-f0-9]{32}$/.test(process.env.R2_ACCOUNT_ID ?? '') && /^[a-z0-9-]+$/.test(process.env.R2_BUCKET_NAME ?? ''));
}

export async function readyVideo(slug: string, requestedQuality?: string) {
  const movie = await getPublishedMovie(slug);
  if (!movie || !getRuntimeControls().externalLinksEnabled || rightsBlockers(movie).length) return null;
  const row = await getDatabase().prepare(
    "SELECT r2_storage_key, r2_video_bytes, download_sources_json FROM movies WHERE slug = ? AND ingest_status = 'ready'",
  ).bind(slug).first<{ r2_storage_key: string; r2_video_bytes: number; download_sources_json: string }>();
  if (!row) return null;
  let key = row.r2_storage_key;
  let bytes = row.r2_video_bytes;
  const quality = /^(720p|1080p)$/.test(requestedQuality || '') ? requestedQuality : undefined;
  if (quality) {
    try {
      const parsed = JSON.parse(row.download_sources_json || '{}');
      const sources = Array.isArray(parsed) ? parsed : parsed.sources;
      const source = Array.isArray(sources) && sources.find((item: unknown) => item && typeof item === 'object' && String((item as { quality?: unknown }).quality).toLowerCase() === quality);
      const sourceRecord = source as { r2StorageKey?: unknown; r2Bytes?: unknown; r2_storage_key?: unknown; r2_video_bytes?: unknown } | undefined;
      const sourceKey = sourceRecord?.r2StorageKey ?? sourceRecord?.r2_storage_key;
      const sourceBytes = sourceRecord?.r2Bytes ?? sourceRecord?.r2_video_bytes;
      // An explicit quality must never fall back to the row's primary key: that
      // key may point at the other quality (usually the legacy 720p object).
      if (typeof sourceKey !== 'string' || !((typeof sourceBytes === 'number' || (typeof sourceBytes === 'string' && /^\d+$/.test(sourceBytes))) && Number.isSafeInteger(Number(sourceBytes)))) return null;
      key = sourceKey;
      bytes = Number(sourceBytes);
    } catch { return null; }
  }
  if (!validVideoRecord(key, bytes)) return null;
  return { movie, key, bytes };
}

export async function signedVideoUrl(video: NonNullable<Awaited<ReturnType<typeof readyVideo>>>) {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accessKeyId || !secretAccessKey || !account || !/^[a-f0-9]{32}$/.test(account) || !bucket || !/^[a-z0-9-]+$/.test(bucket)) throw new Error('R2 signing is not configured');
  const object = await getMediaBucket().head(video.key);
  const contentType = object?.httpMetadata?.contentType;
  const legacyContainer = /^assets\/[0-9a-f-]+\/data\.bin$/.test(video.key);
  if (!object || object.size !== video.bytes || (contentType !== 'video/mp4' && !(legacyContainer && contentType === 'application/octet-stream'))) throw new Error('Video object unavailable');
  const title = video.movie.title.replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').slice(0, 120) || 'Movie';
  const ascii = title.replace(/[^\x20-\x7e]/g, '_');
  const url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${video.key}`);
  url.searchParams.set('X-Amz-Expires', '120');
  url.searchParams.set('response-content-type', 'video/mp4');
  url.searchParams.set('response-content-disposition', `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encodeURIComponent(title + '.mp4').replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  return (await client.sign(url, { method: 'GET', aws: { signQuery: true } })).url;
}

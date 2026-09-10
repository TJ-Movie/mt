import 'server-only';
import { AwsClient } from 'aws4fetch';
import { getDatabase, getMediaBucket, getPublishedMovie } from '../db';
import { getRuntimeControls } from './security/runtime-controls';
import { rightsBlockers, validVideoRecord } from './download-readiness';

export function r2SigningConfigured(): boolean {
  return Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY &&
    /^[a-f0-9]{32}$/.test(process.env.R2_ACCOUNT_ID ?? '') && /^[a-z0-9-]+$/.test(process.env.R2_BUCKET_NAME ?? ''));
}

export async function readyVideo(slug: string) {
  const movie = await getPublishedMovie(slug);
  if (!movie || !getRuntimeControls().externalLinksEnabled || rightsBlockers(movie).length) return null;
  const row = await getDatabase().prepare(
    "SELECT r2_storage_key, r2_video_bytes FROM movies WHERE slug = ? AND ingest_status = 'ready'",
  ).bind(slug).first<{ r2_storage_key: string; r2_video_bytes: number }>();
  if (!row || !validVideoRecord(row.r2_storage_key, row.r2_video_bytes)) return null;
  return { movie, key: row.r2_storage_key, bytes: row.r2_video_bytes };
}

export async function signedVideoUrl(video: NonNullable<Awaited<ReturnType<typeof readyVideo>>>) {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accessKeyId || !secretAccessKey || !account || !/^[a-f0-9]{32}$/.test(account) || !bucket || !/^[a-z0-9-]+$/.test(bucket)) throw new Error('R2 signing is not configured');
  const object = await getMediaBucket().head(video.key);
  if (!object || object.size !== video.bytes || object.httpMetadata?.contentType !== 'video/mp4') throw new Error('Video object unavailable');
  const title = video.movie.title.replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').slice(0, 120) || 'Movie';
  const ascii = title.replace(/[^\x20-\x7e]/g, '_');
  const url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${video.key}`);
  url.searchParams.set('X-Amz-Expires', '120');
  url.searchParams.set('response-content-type', 'video/mp4');
  url.searchParams.set('response-content-disposition', `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encodeURIComponent(title + '.mp4').replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  return (await client.sign(url, { method: 'GET', aws: { signQuery: true } })).url;
}

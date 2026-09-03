import { getMediaBucket } from '../../../db';

const SAFE_KEY = /^(?:movie-art\/[a-f0-9-]{36}\.(?:jpg|png)|subtitles\/[a-f0-9-]{36}\.(?:srt|vtt|zip|7z))$/;

export async function GET(_request: Request, context: { params: Promise<{ key: string[] }> }) {
  const keyParts = (await context.params).key;
  const key = Array.isArray(keyParts) ? keyParts.join('/') : '';
  if (!SAFE_KEY.test(key)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  try {
    const object = await getMediaBucket().get(key);
    if (!object) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Content-Length', String(object.size));
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
}

export async function HEAD(request: Request, context: { params: Promise<{ key: string[] }> }) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}

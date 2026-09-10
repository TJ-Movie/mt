import { readyVideo, signedVideoUrl } from '../../../../lib/r2-download';
import { enforcePublicRateLimit } from '../../../../lib/security/public-rate-limit';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
  const slug = new URL(request.url).searchParams.get('slug');
  if (!slug || !/^[a-z0-9-]{1,160}$/.test(slug)) return new Response('Not found', { status: 404, headers });
  const rate = await enforcePublicRateLimit(request, 'downloads', 20, 60);
  if (!rate.allowed) return new Response('Try again later', { status: 429, headers: { ...headers, ...rate.headers } });
  try {
    const video = await readyVideo(slug);
    if (!video) return new Response('Download unavailable', { status: 404, headers });
    return new Response(null, { status: 302, headers: { ...headers, Location: await signedVideoUrl(video) } });
  } catch {
    return new Response('Download temporarily unavailable', { status: 503, headers });
  }
}

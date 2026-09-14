import { availableQualitiesForSlug, readyVideo, signedVideoUrl } from '../../../../lib/r2-download';
import { enforcePublicRateLimit } from '../../../../lib/security/public-rate-limit';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
  const requestUrl = new URL(request.url);
  const slug = requestUrl.searchParams.get('slug');
  const quality = requestUrl.searchParams.get('quality')?.toLowerCase();
  if (!slug || !/^[a-z0-9-]{1,160}$/.test(slug)) return new Response('Not found', { status: 404, headers });
  const rate = await enforcePublicRateLimit(request, 'downloads', 20, 60);
  if (!rate.allowed) return new Response('Try again later', { status: 429, headers: { ...headers, ...rate.headers } });
  try {
    const video = await readyVideo(slug, quality);
    if (!video) {
      if (quality && /^(720p|1080p)$/.test(quality)) {
        return Response.json({
          error: `Requested quality (${quality}) is currently unavailable`,
          available_qualities: await availableQualitiesForSlug(slug),
        }, { status: 404, headers: { ...headers, 'Content-Type': 'application/json' } });
      }
      return new Response('Download unavailable', { status: 404, headers });
    }
    const signedUrl = await signedVideoUrl(video);
    if (!signedUrl) return new Response('Download temporarily unavailable', { status: 503, headers });
    return new Response(null, { status: 302, headers: { ...headers, Location: signedUrl } });
  } catch {
    return new Response('Download temporarily unavailable', { status: 503, headers });
  }
}

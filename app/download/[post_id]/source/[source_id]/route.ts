import { getPublishedMovie } from '../../../../../db';
import { readyVideo } from '../../../../../lib/r2-download';
import { logSecurityEvent } from '../../../../../lib/security/security-events';

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

export async function GET(_request: Request, context: { params: Promise<{ post_id: string; source_id: string }> }) {
  const { post_id: slug, source_id: sourceId } = await context.params;
  const movie = await getPublishedMovie(slug);
  const target = movie && /^s(?:0|[1-9]\d?)$/.test(sourceId) && await readyVideo(movie.slug)
    ? `/api/download/resolve?slug=${encodeURIComponent(movie.slug)}` : null;
  if (!target) {
    logSecurityEvent('download_redirect_denied', 'warn', { slug, reason: 'not_found_or_ineligible' });
    return new Response('Not found', { status: 404, headers: HEADERS });
  }
  logSecurityEvent('download_redirect_allowed', 'info', { slug });
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: target.toString() } });
}

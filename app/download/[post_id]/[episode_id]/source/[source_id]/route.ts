import { getPublishedMovie } from '../../../../../../db';
import { resolveApprovedGatewaySource } from '../../../../../../lib/download-gateway';
import { logSecurityEvent } from '../../../../../../lib/security/security-events';

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

export async function GET(_request: Request, context: { params: Promise<{ post_id: string; episode_id: string; source_id: string }> }) {
  const { post_id: slug, episode_id: episodeId, source_id: sourceId } = await context.params;
  const movie = await getPublishedMovie(slug);
  const match = /^s?(\d+)[-e](\d+)$/i.exec(episodeId);
  const episode = movie?.episodes?.find((item) => match
    ? item.season === Number(match[1]) && item.episode === Number(match[2])
    : item.episode === Number(episodeId));
  const target = movie && movie.contentType === 'series' && episode
    ? await resolveApprovedGatewaySource(movie, sourceId, episode)
    : null;
  if (!target) {
    logSecurityEvent('download_redirect_denied', 'warn', { slug, reason: 'episode_not_found_or_ineligible' });
    return new Response('Not found', { status: 404, headers: HEADERS });
  }
  logSecurityEvent('download_redirect_allowed', 'info', { slug, action: 'episode' });
  return new Response(null, { status: 302, headers: { ...HEADERS, Location: target.toString() } });
}

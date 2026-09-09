import { getPublishedMovie } from '../../../../db';
import { resolveOutboundDestination, type OutboundAction } from '../../../../lib/security/outbound-links';
import { getRuntimeControls } from '../../../../lib/security/runtime-controls';
import { logSecurityEvent } from '../../../../lib/security/security-events';
import { approvedGatewaySources } from '../../../../lib/download-gateway';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

export async function GET(_request: Request, context: { params: Promise<{ slug: string; action: string }> }) {
  const { slug, action } = await context.params;
  const movie = await getPublishedMovie(slug);
  if (!movie || (action !== 'watch' && action !== 'telegram')) {
    logSecurityEvent('outbound_redirect_denied', 'warn', { slug, action, reason: 'not_found' });
    return new Response('Not found', { status: 404, headers: NO_STORE_HEADERS });
  }
  if (action === 'telegram' && !movie.telegramUrl && (movie.downloadSources?.length ?? 0) > 0) {
    const gateway = await approvedGatewaySources(movie);
    if (gateway?.sources.length) {
      logSecurityEvent('outbound_redirect_allowed', 'info', { slug, action: 'download_gateway' });
      return new Response(null, { status: 302, headers: { ...NO_STORE_HEADERS, Location: `/download/${movie.slug}` } });
    }
    logSecurityEvent('outbound_redirect_denied', 'warn', { slug, action, reason: 'download_gateway_ineligible' });
    return new Response('Not found', { status: 404, headers: NO_STORE_HEADERS });
  }

  const resolution = resolveOutboundDestination(
    movie,
    action as OutboundAction,
    getRuntimeControls(),
  );
  if (!resolution.ok) {
    logSecurityEvent('outbound_redirect_denied', 'warn', { slug, action, reason: resolution.reason });
    return new Response('Not found', { status: 404, headers: NO_STORE_HEADERS });
  }

  logSecurityEvent('outbound_redirect_allowed', 'info', { slug, action });
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE_HEADERS, Location: resolution.target.toString() },
  });
}

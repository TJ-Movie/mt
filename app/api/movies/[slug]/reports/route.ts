import { createSourceReport, getPublishedMovie } from '../../../../../db';
import { enforcePublicRateLimit, isSameOriginRequest } from '../../../../../lib/security/public-rate-limit';
import { readBoundedJson } from '../../../../../lib/security/request-body';
import { logSecurityEvent } from '../../../../../lib/security/security-events';

const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function cleanText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC').trim();
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return '';
  }
  return normalized.slice(0, maximum);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const slug = (await context.params).slug;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return Response.json({ error: 'Invalid movie.' }, { status: 400, headers: HEADERS });
  }
  if (!isSameOriginRequest(request)) {
    logSecurityEvent('public_request_rejected', 'warn', { scope: 'source-reports', reason: 'cross_origin' });
    return Response.json({ error: 'Request rejected.' }, { status: 403, headers: HEADERS });
  }
  const rateLimit = await enforcePublicRateLimit(request, 'source-reports', 5, 3_600);
  if (!rateLimit.allowed) {
    return Response.json({ error: 'Too many reports. Try again later.' }, { status: 429, headers: { ...HEADERS, ...rateLimit.headers } });
  }

  const body = await readBoundedJson(request, 2_048);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Invalid report.' }, { status: 400, headers: { ...HEADERS, ...rateLimit.headers } });
  }
  const input = body as Record<string, unknown>;
  const kind = input.sourceKind === 'stream'
    ? 'stream'
    : input.sourceKind === 'download'
      ? 'download'
      : null;
  const sourceId = typeof input.sourceId === 'string' && /^s(?:0|[1-9]\d?)$/.test(input.sourceId)
    ? input.sourceId
    : null;
  const reason = cleanText(input.reason, 80);
  const details = cleanText(input.details, 500);
  const movie = await getPublishedMovie(slug);
  const sources = kind === 'stream' ? movie?.streamingSources : movie?.downloadSources;
  const source = sourceId ? sources?.[Number(sourceId.slice(1))] : undefined;
  if (!movie || !kind || !source || !reason) {
    return Response.json({ error: 'Source not found.' }, { status: 400, headers: { ...HEADERS, ...rateLimit.headers } });
  }

  await createSourceReport({
    movieSlug: slug,
    sourceKind: kind,
    sourceLabel: source.label,
    sourceUrl: source.url,
    reason,
    details,
  });
  return Response.json({ reported: true }, { status: 201, headers: { ...HEADERS, ...rateLimit.headers } });
}

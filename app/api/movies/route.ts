import { toPublicMovie } from '../../../lib/public-movie';
import { logSecurityEvent } from '../../../lib/security/security-events';
import { listPublishedMoviesPage } from '../../../db';
import { contentTypes } from '../../../lib/catalogue-options';
import { enforcePublicRateLimit } from '../../../lib/security/public-rate-limit';
import { availableQualitiesFromD1 } from '../../../lib/r2-download';

const MAX_QUERY_LENGTH = 80;
const MAX_FILTER_LENGTH = 30;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 24;
const MAX_PAGE_NUMBER = 1_000;

const SUCCESS_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'RateLimit-Policy': '60;w=60',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

const ERROR_HEADERS = {
  ...SUCCESS_HEADERS,
  'Cache-Control': 'no-store',
};

function safeText(value: string | null, max: number): string | null {
  if (value === null) return '';
  if (value.length > max) return null;
  return value.normalize('NFKC').trim().toLowerCase();
}

function boundedInteger(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function badRequest(reason: string): Response {
  logSecurityEvent('catalogue_request_rejected', 'warn', { reason });
  return Response.json({ error: 'Invalid catalogue request.' }, { status: 400, headers: ERROR_HEADERS });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = safeText(url.searchParams.get('q'), MAX_QUERY_LENGTH);
  const genre = safeText(url.searchParams.get('genre'), MAX_FILTER_LENGTH);
  const language = safeText(url.searchParams.get('language'), MAX_FILTER_LENGTH);
  const type = safeText(url.searchParams.get('type'), MAX_FILTER_LENGTH);
  const page = boundedInteger(url.searchParams.get('page'), 1, MAX_PAGE_NUMBER);
  const limit = boundedInteger(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  if (query === null || genre === null || language === null || type === null) return badRequest('text_limit');
  if (type && type !== 'all' && !contentTypes.includes(type as typeof contentTypes[number])) return badRequest('content_type');
  if (page === null || limit === null) return badRequest('pagination_bounds');
  const rate = await enforcePublicRateLimit(request, 'catalogue', 120, 60);
  if (!rate.allowed) return Response.json({ error: 'Try again later' }, { status: 429, headers: { ...ERROR_HEADERS, ...rate.headers } });

  const pageResult = await listPublishedMoviesPage({
    query,
    genre,
    language,
    contentType: type,
    page,
    limit,
  });
  const results = pageResult.movies.map((movie) => ({
    ...toPublicMovie(movie),
    available_qualities: availableQualitiesFromD1(movie),
  }));

  return Response.json({
    results,
    count: results.length,
    pagination: {
      page: pageResult.page,
      limit: pageResult.limit,
      hasNextPage: pageResult.hasNextPage,
    },
  }, { headers: { ...SUCCESS_HEADERS, ...rate.headers } });
}

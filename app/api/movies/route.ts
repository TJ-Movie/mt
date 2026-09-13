import { toPublicMovie } from '../../../lib/public-movie';
import { logSecurityEvent } from '../../../lib/security/security-events';
import { listPublishedMovies } from '../../../db';
import { contentTypes } from '../../../lib/catalogue-options';
import { enforcePublicRateLimit } from '../../../lib/security/public-rate-limit';
import { availableQualitiesFromD1 } from '../../../lib/r2-download';

const MAX_QUERY_LENGTH = 80;
const MAX_FILTER_LENGTH = 30;
const DEFAULT_PAGE_SIZE = 12;
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
  if (!rate.allowed) return new Response('Try again later', { status: 429, headers: { ...ERROR_HEADERS, ...rate.headers } });

  const movies = await listPublishedMovies();
  const filtered = movies.filter((movie) => {
    const cast = movie.cast.map((member) => typeof member === 'string'
      ? member
      : `${member.actor} ${member.character ?? ''}`).join(' ');
    const text = `${movie.title} ${movie.director} ${cast}`.toLowerCase();
    const movieGenres = movie.genre.toLowerCase().split(',').map((item) => item.trim());
    return (!query || text.includes(query)) && (!genre || genre === 'all' || movieGenres.includes(genre)) && (!language || language === 'all languages' || movie.languages.some((item) => item.toLowerCase() === language)) && (!type || type === 'all' || movie.contentType === type);
  });
  const start = (page - 1) * limit;
  // The D1 row carries qualities that were persisted only after R2 HEAD/size
  // verification. Do not perform two R2 HEAD requests per movie here: a
  // public limit of 24 must remain comfortably below Worker subrequest caps.
  const results = filtered.slice(start, start + limit).map((movie) => ({
    ...toPublicMovie(movie),
    available_qualities: availableQualitiesFromD1(movie),
  }));
  const totalPages = Math.max(1, Math.ceil(filtered.length / limit));

  return Response.json({
    results,
    count: results.length,
    pagination: {
      page,
      limit,
      total: filtered.length,
      totalPages,
      hasNextPage: page < totalPages,
    },
  }, { headers: { ...SUCCESS_HEADERS, ...rate.headers } });
}

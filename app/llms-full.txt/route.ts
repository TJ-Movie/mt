import { listPublishedMovies } from '../../db';
import { toPublicMovie } from '../../lib/public-movie';

const SITE_ORIGIN = 'https://flixlyra.com';

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const movies = (await listPublishedMovies()).map(toPublicMovie);
  const entries = movies.map((movie) => {
    const routeBase = movie.contentType === 'series' ? 'series' : 'movie';
    const url = `${SITE_ORIGIN}/${routeBase}/${encodeURIComponent(movie.slug)}`;
    return [
      `### ${oneLine(movie.title)}`,
      `URL: ${url}`,
      `Type: ${movie.contentType === 'series' ? 'TV series' : 'Movie'}`,
      `Year: ${movie.year}`,
      `Genre: ${oneLine(movie.genre)}`,
      `Director: ${oneLine(movie.director)}`,
      `Subtitle languages: ${movie.languages.map(oneLine).join(', ')}`,
      `Description: ${oneLine(movie.description)}`,
      `Available qualities: ${movie.available_qualities.join(', ') || 'none'}`,
      '',
    ].join('\n');
  });
  const body = [
    '# Flixlyra public catalogue',
    '',
    'This document contains only published, public catalogue metadata.',
    'Internal D1 fields, R2 object keys, private source URLs, rights-review data, and administrative records are excluded.',
    '',
    ...entries,
  ].join('\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=900, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

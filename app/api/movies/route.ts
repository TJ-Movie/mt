import { movies } from '../../../lib/movies';

const safeText = (value: string | null, max = 80) => (value ?? '').trim().slice(0, max).toLowerCase();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = safeText(url.searchParams.get('q'));
  const genre = safeText(url.searchParams.get('genre'), 30);
  const language = safeText(url.searchParams.get('language'), 30);
  const results = movies.filter((movie) => {
    const text = `${movie.title} ${movie.director} ${movie.cast.join(' ')}`.toLowerCase();
    return (!query || text.includes(query)) && (!genre || movie.genre.toLowerCase() === genre) && (!language || movie.languages.some((item) => item.toLowerCase() === language));
  }).map(({ officialWatchUrl: _watch, telegramUrl: _telegram, ...publicMovie }) => publicMovie);

  return Response.json({ results, count: results.length }, {
    headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300', 'X-Content-Type-Options': 'nosniff' },
  });
}

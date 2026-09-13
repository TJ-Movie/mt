import type { MetadataRoute } from 'next';
import { listPublishedMovies } from '../db';
import { toPublicMovie } from '../lib/public-movie';

const SITE_ORIGIN = 'https://flixlyra.com';

function validLastModified(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? undefined : timestamp.toISOString();
}

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const movies = await listPublishedMovies();
  return [
    { url: SITE_ORIGIN, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_ORIGIN}/movies`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${SITE_ORIGIN}/privacy`, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${SITE_ORIGIN}/content-policy`, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${SITE_ORIGIN}/advertise`, changeFrequency: 'monthly', priority: 0.4 },
    ...movies.map((movie) => {
      const publicMovie = toPublicMovie(movie);
      const routeBase = publicMovie.contentType === 'series' ? 'series' : 'movie';
      return {
        url: `${SITE_ORIGIN}/${routeBase}/${encodeURIComponent(publicMovie.slug)}`,
        lastModified: validLastModified((movie as { updatedAt?: string }).updatedAt),
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      };
    }),
  ];
}

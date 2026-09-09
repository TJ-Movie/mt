import type { MetadataRoute } from 'next';
import { listPublishedMovies } from '../db';

const origin = 'https://flixlyra.com';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> { const movies = await listPublishedMovies(); return [{ url: origin, changeFrequency: 'weekly', priority: 1 }, { url: `${origin}/privacy`, changeFrequency: 'monthly', priority: .3 }, { url: `${origin}/content-policy`, changeFrequency: 'monthly', priority: .4 }, { url: `${origin}/advertise`, changeFrequency: 'monthly', priority: .4 }, ...movies.map((movie) => ({ url: `${origin}/${movie.contentType === 'series' ? 'series' : 'movie'}/${movie.slug}`, changeFrequency: 'weekly' as const, priority: .8 }))]; }

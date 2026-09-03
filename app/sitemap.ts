import type { MetadataRoute } from 'next';
import { listPublishedMovies } from '../db';

const origin = 'https://sublyra-cinema.alive-stoat-6821.chatgpt.site';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> { const movies = await listPublishedMovies(); return [{ url: origin, changeFrequency: 'weekly', priority: 1 }, { url: `${origin}/privacy`, changeFrequency: 'monthly', priority: .3 }, { url: `${origin}/content-policy`, changeFrequency: 'monthly', priority: .4 }, { url: `${origin}/advertise`, changeFrequency: 'monthly', priority: .4 }, ...movies.map((movie) => ({ url: `${origin}/movies/${movie.slug}`, changeFrequency: 'weekly' as const, priority: .8 }))]; }

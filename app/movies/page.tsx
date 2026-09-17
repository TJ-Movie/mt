import type { Metadata } from 'next';
import { MovieCatalogue } from '../../components/movie-catalogue';
import { toPublicMovie } from '../../lib/public-movie';
import { getRuntimeControls } from '../../lib/security/runtime-controls';
import { listPublishedMoviesPage, type PublishedMovieFilters } from '../../db';

export const metadata: Metadata = {
  title: 'Movies — Flixlyra',
  description: 'Browse the published Flixlyra movie catalogue.',
  alternates: { canonical: '/movies' },
};

type SearchParamValue = string | string[] | undefined;
type MoviesPageProps = { searchParams?: Promise<Record<string, SearchParamValue>> };

function firstParam(value: SearchParamValue): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function initialFilters(params: Record<string, SearchParamValue>): PublishedMovieFilters {
  return {
    query: firstParam(params.q).slice(0, 80),
    genre: firstParam(params.genre).slice(0, 30) || 'All',
    language: firstParam(params.language).slice(0, 30) || 'All languages',
    contentType: firstParam(params.type).slice(0, 30) || 'all',
  };
}

export default async function MoviesPage({ searchParams }: MoviesPageProps) {
  const filters = initialFilters(searchParams ? await searchParams : {});
  const page = await listPublishedMoviesPage({ ...filters, page: 1, limit: 24 });
  const publicMovies = page.movies.map(toPublicMovie);
  const { adsEnabled } = getRuntimeControls();
  return <MovieCatalogue movies={publicMovies} adsEnabled={adsEnabled} initialFilters={{ query: filters.query ?? '', genre: filters.genre ?? 'All', language: filters.language ?? 'All languages', contentType: filters.contentType ?? 'all' }} hasNextPage={page.hasNextPage} />;
}

import type { Movie } from './movies.ts';

/**
 * The only movie fields that may cross a server-to-client or API boundary.
 * Keep this as an explicit allowlist: new private fields added to Movie remain
 * server-only until they are deliberately reviewed and copied here.
 */
export type PublicMovie = Pick<
  Movie,
  | 'slug'
  | 'title'
  | 'tagline'
  | 'description'
  | 'year'
  | 'runtime'
  | 'rating'
  | 'genre'
  | 'director'
  | 'cast'
  | 'languages'
  | 'poster'
  | 'backdrop'
  | 'featured'
>;

export function toPublicMovie(movie: Movie): PublicMovie {
  return {
    slug: movie.slug,
    title: movie.title,
    tagline: movie.tagline,
    description: movie.description,
    year: movie.year,
    runtime: movie.runtime,
    rating: movie.rating,
    genre: movie.genre,
    director: movie.director,
    cast: [...movie.cast],
    languages: [...movie.languages],
    poster: movie.poster,
    backdrop: movie.backdrop,
    featured: movie.featured,
  };
}

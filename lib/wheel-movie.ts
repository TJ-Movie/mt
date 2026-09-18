import type { PublicMovie } from './public-movie';

export type WheelMovie = Pick<
  PublicMovie,
  | 'slug'
  | 'title'
  | 'tagline'
  | 'description'
  | 'year'
  | 'runtime'
  | 'rating'
  | 'contentType'
  | 'genre'
  | 'poster'
  | 'backdrop'
>;

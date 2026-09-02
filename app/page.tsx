import { movies } from '../lib/movies';
import { MovieBrowser } from '../components/movie-browser';

export default function Home() {
  return <MovieBrowser movies={movies} />;
}

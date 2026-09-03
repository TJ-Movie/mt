import { movies } from '../lib/movies';
import { MovieBrowser } from '../components/movie-browser';

export default function Home() {
  const catalogueSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Sublyra movie collection',
    description: 'A multilingual cinema discovery collection with 10+ subtitle languages.',
    url: 'https://sublyra-cinema.alive-stoat-6821.chatgpt.site',
    mainEntity: movies.map((movie) => ({ '@type': 'Movie', name: movie.title, dateCreated: String(movie.year), genre: movie.genre })),
  };
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(catalogueSchema).replace(/</g, '\\u003c') }}/><MovieBrowser movies={movies}/></>;
}

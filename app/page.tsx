import { MovieBrowser } from '../components/movie-browser';
import { headers } from 'next/headers';
import { toPublicMovie } from '../lib/public-movie';
import { serializeJsonLd } from '../lib/security/json-ld';
import { getRuntimeControls } from '../lib/security/runtime-controls';
import { listPublishedMovies } from '../db';

export default async function Home() {
  const publicMovies = (await listPublishedMovies()).map(toPublicMovie);
  const nonce = (await headers()).get('x-csp-nonce') ?? undefined;
  const { adsEnabled } = getRuntimeControls();
  const catalogueSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Flixlyra movie collection',
    description:
      'A multilingual cinema discovery collection with 10+ subtitle languages.',
    url: 'https://flixlyra.com',
    mainEntity: publicMovies.map((movie) => ({
      '@type': 'Movie',
      name: movie.title,
      dateCreated: String(movie.year),
      genre: movie.genre,
    })),
  };
  return (
    <>
      <script
        suppressHydrationWarning
        nonce={nonce}
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(catalogueSchema) }}
      />
      <MovieBrowser movies={publicMovies} adsEnabled={adsEnabled} />
    </>
  );
}

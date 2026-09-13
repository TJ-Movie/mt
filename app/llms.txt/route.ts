const BODY = `# Flixlyra

Flixlyra is a public movie and series discovery catalogue focused on global cinema and subtitle languages.

Canonical: https://flixlyra.com/

## Public pages

- Home: https://flixlyra.com/
- Movie catalogue: https://flixlyra.com/movies
- Movie detail: https://flixlyra.com/movie/{slug}
- Series detail: https://flixlyra.com/series/{slug}
- Sitemap: https://flixlyra.com/sitemap.xml
- Full public catalogue context: https://flixlyra.com/llms-full.txt

## Public catalogue boundary

Only published catalogue records are public. Public fields include title, synopsis, genre, year, runtime, cast, artwork, subtitle languages, and verified availability labels.

Do not infer or expose internal D1 fields, R2 object keys, private source URLs, rights-review data, credentials, or administrative records.

## Disallowed paths

- /admin
- /studio
- /api/admin/
- /api/download/
- /out/
`;

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=900, s-maxage=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

function ordered(rows) {
  return rows.slice().sort((left, right) =>
    Number(right.featured) - Number(left.featured)
      || right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || right.id - left.id,
  );
}

function page(rows, pageNumber, limit, predicate = () => true) {
  const filtered = ordered(rows.filter(predicate));
  const start = (pageNumber - 1) * limit;
  return { rows: filtered.slice(start, start + limit), hasNextPage: start + limit < filtered.length };
}

const catalogue = Array.from({ length: 100 }, (_, index) => ({
  id: index + 1,
  title: index === 79 ? 'Avatar Beyond The First Page' : 'Movie ' + String(index + 1),
  featured: index < 3,
  updatedAt: '2026-09-' + String(30 - Math.floor(index / 4)).padStart(2, '0'),
  createdAt: '2026-01-01T00:00:00.000Z',
  publicationStatus: index === 98 ? 'draft' : 'published',
  genre: index % 2 ? 'Drama' : 'Action',
}));

test('homepage handles zero, small, and large catalogues with a maximum of 12', () => {
  assert.deepEqual(catalogue.slice(0, 0), []);
  assert.equal(catalogue.slice(0, 8).length, 8);
  assert.equal(catalogue.slice(0, 12).length, 12);
  assert.equal(catalogue.slice(0, 100).slice(0, 12).length, 12);
});

test('homepage code requests a query-level limit and exposes View All Movies', () => {
  const pageSource = source('app/page.tsx');
  const browserSource = source('components/movie-browser.tsx');
  assert.match(pageSource, /HOMEPAGE_MOVIE_LIMIT = 12/);
  assert.match(pageSource, /listPublishedMoviesPage\(\{ page: 1, limit: HOMEPAGE_MOVIE_LIMIT \}\)/);
  assert.match(pageSource, /showFilters=\{false\}/);
  assert.match(browserSource, /View All Movies/);
  assert.match(browserSource, /href=\{viewAllHref\}/);
});

test('server catalogue query is bounded, published-only, and deterministically ordered', () => {
  const dbSource = source('db/index.ts');
  assert.match(dbSource, /publication_status = 'published'/);
  assert.match(dbSource, /ORDER BY featured DESC, updated_at DESC, created_at DESC, id DESC LIMIT \? OFFSET \?/);
  assert.match(dbSource, /safeLimit \+ 1/);
  assert.doesNotMatch(dbSource, /SELECT COUNT\(\*\) AS total/);
});

test('movies page and API use a 24-item bounded batch', () => {
  const pageSource = source('app/movies/page.tsx');
  const apiSource = source('app/api/movies/route.ts');
  const browserSource = source('components/movie-catalogue.tsx');
  assert.match(pageSource, /limit: 24/);
  assert.match(pageSource, /<MovieCatalogue/);
  assert.match(apiSource, /const DEFAULT_PAGE_SIZE = 24/);
  assert.match(apiSource, /listPublishedMoviesPage/);
  assert.doesNotMatch(apiSource, /listPublishedMovies\(\)/);
  assert.match(browserSource, /const PAGE_SIZE = 24/);
});

test('initial batch and second batch contain no duplicates', () => {
  const first = page(catalogue, 1, 24);
  const second = page(catalogue, 2, 24);
  assert.equal(first.rows.length, 24);
  assert.equal(second.rows.length, 24);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 48);
  assert.equal(first.hasNextPage, true);
});

test('final batch is short and disables Load More', () => {
  const final = page(catalogue.slice(0, 50), 3, 24);
  assert.equal(final.rows.length, 2);
  assert.equal(final.hasNextPage, false);
  assert.match(source('components/movie-catalogue.tsx'), /hasNext \? .*Load More/s);
});

test('ordering uses the unique id tie-breaker', () => {
  const tied = [
    { id: 1, featured: false, updatedAt: '2026-01-01', createdAt: '2026-01-01' },
    { id: 2, featured: false, updatedAt: '2026-01-01', createdAt: '2026-01-01' },
  ];
  assert.deepEqual(ordered(tied).map((row) => row.id), [2, 1]);
});

test('search scans the full published set before paging', () => {
  const result = page(catalogue, 1, 24, (row) => row.publicationStatus === 'published' && row.title.toLowerCase().includes('avatar'));
  assert.deepEqual(result.rows.map((row) => row.id), [80]);
  assert.match(source('db/index.ts'), /lower\(title\) LIKE .*lower\(director\) LIKE .*lower\(cast_json\) LIKE/s);
});

test('search and filter changes reset to page one and Load More keeps the criteria', () => {
  const filter = (row) => row.publicationStatus === 'published' && row.genre === 'Drama';
  const first = page(catalogue, 1, 24, filter);
  const next = page(catalogue, 2, 24, filter);
  assert.equal(first.rows.every(filter), true);
  assert.equal(next.rows.every(filter), true);
  assert.equal(page(catalogue, 1, 24, filter).rows[0].id, first.rows[0].id);
  assert.equal(new Set([...first.rows, ...next.rows].map((row) => row.id)).size, first.rows.length + next.rows.length);
});

test('draft and archived records never enter public pages', () => {
  const publicRows = page(catalogue, 1, 24, (row) => row.publicationStatus === 'published').rows;
  assert.equal(publicRows.some((row) => row.publicationStatus !== 'published'), false);
  assert.match(source('db/index.ts'), /WHERE publication_status = 'published'/);
});

test('pagination requests are guarded against duplicate fast clicks and per-card calls', () => {
  const browserSource = source('components/movie-catalogue.tsx');
  assert.match(browserSource, /loadingRef\.current/);
  assert.match(browserSource, /new Map\(current\.map/);
  assert.equal(browserSource.split("fetch('/api/movies?").length - 1, 1);
  assert.doesNotMatch(browserSource, /fetch\([^\n]*movie\.slug/);
});

test('pagination and filter URL parameters have distinct request identities', () => {
  const browserSource = source('components/movie-catalogue.tsx');
  const apiSource = source('app/api/movies/route.ts');
  for (const value of ['page', 'limit', 'q', 'genre', 'language', 'type']) assert.match(browserSource, new RegExp('params[^\\n]*' + value));
  assert.match(apiSource, /Cache-Control.*no-store/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminMovie } from '../db/index.ts';
import {
  filterAndSortStudioMovies,
  isNewStudioMovie,
  studioMediaState,
  studioQualityState,
  studioSummary,
  type StudioFilters,
} from '../lib/admin/studio-view.ts';

const filters: StudioFilters = {
  publication: 'all',
  media: 'all',
  rights: 'all',
  review: 'all',
};

function movie(overrides: Partial<AdminMovie> = {}): AdminMovie {
  return {
    id: 1,
    title: 'Untitled',
    slug: 'untitled',
    imdbId: 'tt0000001',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    publicationStatus: 'draft',
    rightsStatus: 'pending',
    enrichmentStatus: 'pending',
    availableQualities: [],
    ingestStatus: 'queued',
    ingest_status: 'queued',
    ...overrides,
  } as unknown as AdminMovie;
}

void test('search matches title, slug, IMDb ID and D1 ID', () => {
  const item = movie({ id: 62, title: 'Enfrentados: Marfil', slug: 'enfrentados-marfil', imdbId: 'tt36073210' });
  for (const query of ['enfrentados', 'enfrentados-marfil', 'tt36073210', '62']) {
    assert.deepEqual(filterAndSortStudioMovies([item], query, filters), [item]);
  }
});

void test('publication, media, rights and review filters combine', () => {
  const half = movie({
    id: 62,
    publicationStatus: 'published',
    rightsStatus: 'verified',
    enrichmentStatus: 'ready',
    availableQualities: ['1080p'],
    ingestStatus: 'half',
    ingest_status: 'half',
  });
  const ready = movie({
    id: 63,
    publicationStatus: 'published',
    rightsStatus: 'verified',
    enrichmentStatus: 'ready',
    availableQualities: ['720p', '1080p'],
    ingestStatus: 'ready',
    ingest_status: 'ready',
  });
  assert.deepEqual(
    filterAndSortStudioMovies([half, ready], '', { publication: 'published', media: 'half', rights: 'verified', review: 'ready' }),
    [half],
  );
  assert.deepEqual(
    filterAndSortStudioMovies([half, ready], '', { publication: 'published', media: 'ready', rights: 'verified', review: 'ready' }),
    [ready],
  );
});

void test('media and quality chips expose HALF with unavailable quality', () => {
  const item = movie({ availableQualities: ['1080p'], ingestStatus: 'half', ingest_status: 'half' });
  assert.equal(studioMediaState(item), 'half');
  assert.equal(studioQualityState(item, '720p'), 'queued');
  assert.equal(studioQualityState(item, '1080p'), 'verified');
});

void test('failed movies expose failed quality status', () => {
  const item = movie({ ingestStatus: 'skipped_unplayable', ingest_status: 'skipped_unplayable' });
  assert.equal(studioMediaState(item), 'failed');
  assert.equal(studioQualityState(item, '720p'), 'failed');
});

void test('newest, oldest, title and updated sorting are deterministic', () => {
  const older = movie({ id: 1, title: 'Zed', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' });
  const newer = movie({ id: 2, title: 'Alpha', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' });
  assert.deepEqual(filterAndSortStudioMovies([older, newer], '', filters, 'newest').map((item) => item.id), [2, 1]);
  assert.deepEqual(filterAndSortStudioMovies([older, newer], '', filters, 'oldest').map((item) => item.id), [1, 2]);
  assert.deepEqual(filterAndSortStudioMovies([older, newer], '', filters, 'title-asc').map((item) => item.id), [2, 1]);
  assert.deepEqual(filterAndSortStudioMovies([older, newer], '', filters, 'updated').map((item) => item.id), [2, 1]);
});

void test('NEW badge uses createdAt and a seven-day window', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  assert.equal(isNewStudioMovie(movie({ createdAt: '2026-09-12T00:00:00.000Z' }), now), true);
  assert.equal(isNewStudioMovie(movie({ createdAt: '2026-09-01T00:00:00.000Z' }), now), false);
});

void test('summary counts use the loaded dataset without backend queries', () => {
  const items = [
    movie({ id: 1, publicationStatus: 'published', rightsStatus: 'verified', availableQualities: ['720p', '1080p'], ingestStatus: 'ready', ingest_status: 'ready' }),
    movie({ id: 2, publicationStatus: 'draft', availableQualities: ['1080p'], ingestStatus: 'half', ingest_status: 'half' }),
    movie({ id: 3, publicationStatus: 'draft', ingestStatus: 'skipped_unplayable', ingest_status: 'skipped_unplayable' }),
  ];
  assert.deepEqual(studioSummary(items), {
    total: 3, published: 1, draft: 2, archived: 0, ready: 1, half: 1, failed: 1, queued: 0,
    rightsPending: 2, rightsVerified: 1, reviewReady: 0, needsReview: 3,
  });
});

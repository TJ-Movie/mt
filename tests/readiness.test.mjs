import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMovieReadiness, qualityReadiness } from '../lib/download-readiness.ts';
import { normalizeCast, parseCastJson, castImage } from '../lib/cast.ts';

const base = {
  slug: 'phase-two-film', title: 'Phase Two Film', tagline: '', description: 'A film', year: 2026, runtime: '1h 30m', rating: 8,
  genre: 'Drama', director: 'Director', cast: [{ actor: 'Named Actor' }], languages: ['English'], poster: '/og.png', backdrop: '/og.png',
  featured: false, publicationStatus: 'published', rightsStatus: 'verified', rightsVerifiedAt: '2026-01-01T00:00:00.000Z',
  rightsExpiresAt: '2030-01-01T00:00:00.000Z', rightsReviewer: 'Reviewer', rightsReference: 'License',
  downloadSources: [{ label: '720p', quality: '720p', resolution: '720p', size: '1 GB', url: 'https://source.test/720', r2StorageKey: 'assets/12345678-1234-4123-8123-123456789abc/720p.mp4', r2Bytes: 100 }],
};

test('720p success plus 1080p failure is partial, not total failure', () => {
  const readiness = evaluateMovieReadiness(base);
  assert.equal(readiness.qualities['720p'].ready, true);
  assert.equal(readiness.qualities['1080p'].ready, false);
  assert.equal(readiness.qualities['720p'].r2Verified, true);
  assert.equal(readiness.publishable, true);
  assert.deepEqual(readiness.cast.warnings, ['CAST_IMAGE_MISSING:1']);
});

test('1080p remains usable when 720p is missing', () => {
  const movie = { ...base, downloadSources: [{ label: '1080p', quality: '1080p', resolution: '1080p', size: '2 GB', url: 'https://source.test/1080', r2StorageKey: 'assets/12345678-1234-4123-8123-123456789abc/1080p.mp4', r2Bytes: 200 }] };
  const readiness = evaluateMovieReadiness(movie);
  assert.equal(readiness.qualities['720p'].ready, false);
  assert.equal(readiness.qualities['1080p'].ready, true);
  assert.equal(readiness.publishable, true);
});

test('cast names survive missing images and legacy shapes normalize safely', () => {
  const members = normalizeCast([{ name: 'Legacy Actor', character_name: 'Role' }, { actor: 'Manual Actor', image: '', manualOverride: true }]);
  assert.equal(members[0].actor, 'Legacy Actor');
  assert.equal(members[1].actor, 'Manual Actor');
  assert.equal(castImage(members[0]), undefined);
});

test('malformed cast JSON produces a diagnostic instead of pretending it is valid empty cast', () => {
  const result = parseCastJson('{broken');
  assert.equal(result.parseError, true);
  assert.deepEqual(result.members, []);
});

test('unverified or invalid quality mapping is never ready', () => {
  const result = qualityReadiness({ ...base, downloadSources: [{ label: '720p', quality: '720p', resolution: '720p', size: '1 GB', url: 'https://source.test/720' }] }, '720p');
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes('R2_OBJECT_MISSING'));
});

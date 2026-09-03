import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { movies, type Movie } from '../lib/movies.ts';
import { toPublicMovie } from '../lib/public-movie.ts';
import { serializeJsonLd } from '../lib/security/json-ld.ts';
import {
  resolveOutboundDestination,
  validateOutboundDestination,
} from '../lib/security/outbound-links.ts';
import { getRuntimeControls } from '../lib/security/runtime-controls.ts';

const verifiedMovie: Movie = {
  ...movies[0],
  rightsStatus: 'verified',
  rightsVerifiedAt: '2026-01-01T00:00:00.000Z',
  rightsExpiresAt: '2027-01-01T00:00:00.000Z',
  rightsReviewer: 'security-reviewer',
  rightsReference: 'RIGHTS-TEST-001',
  officialWatchUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  telegramUrl: 'https://t.me/sublyra_test/123',
  telegramChannel: 'sublyra_test',
};

void test('PublicMovie is an explicit allowlist and clones arrays', () => {
  const publicMovie = toPublicMovie(verifiedMovie);
  const keys = Object.keys(publicMovie);
  for (const forbidden of [
    'officialWatchUrl',
    'telegramUrl',
    'telegramChannel',
    'rightsStatus',
    'rightsVerifiedAt',
    'rightsExpiresAt',
    'rightsReviewer',
    'rightsReference',
  ]) assert.equal(keys.includes(forbidden), false);
  assert.notEqual(publicMovie.cast, verifiedMovie.cast);
  assert.notEqual(publicMovie.languages, verifiedMovie.languages);
});

void test('JSON-LD serializer escapes every HTML-significant terminator', () => {
  const input = { text: '</script><script>&\u2028\u2029' };
  const serialized = serializeJsonLd(input);
  assert.equal(serialized.includes('<'), false);
  assert.equal(serialized.includes('>'), false);
  assert.equal(serialized.includes('&'), false);
  assert.deepEqual(JSON.parse(serialized), input);
});

void test('runtime switches fail closed and require explicit true', () => {
  assert.deepEqual(getRuntimeControls({}), {
    externalLinksEnabled: false,
    adsEnabled: false,
  });
  assert.deepEqual(getRuntimeControls({
    SUBLYRA_EXTERNAL_LINKS_ENABLED: ' TRUE ',
    SUBLYRA_ADS_ENABLED: 'true',
  }), { externalLinksEnabled: true, adsEnabled: true });
});

void test('outbound destinations accept only the exact approved shapes', () => {
  assert.ok(validateOutboundDestination('watch', verifiedMovie.officialWatchUrl!));
  assert.ok(validateOutboundDestination('watch', 'https://youtu.be/abcdefghijk?t=30'));
  assert.ok(validateOutboundDestination('telegram', verifiedMovie.telegramUrl!, 'sublyra_test'));

  assert.equal(validateOutboundDestination('watch', 'http://www.youtube.com/watch?v=abcdefghijk'), null);
  assert.equal(validateOutboundDestination('watch', 'https://youtube.com.evil.example/watch?v=abcdefghijk'), null);
  assert.equal(validateOutboundDestination('watch', 'https://www.youtube.com/embed/abcdefghijk'), null);
  assert.equal(validateOutboundDestination('telegram', 'https://t.me/another_channel/123', 'sublyra_test'), null);
  assert.equal(validateOutboundDestination('telegram', 'https://telegram.me/sublyra_test/123', 'sublyra_test'), null);
});

void test('rights gate and kill switch deny by default', () => {
  const enabled = { externalLinksEnabled: true, adsEnabled: false };
  const disabled = { externalLinksEnabled: false, adsEnabled: false };
  const now = Date.parse('2026-09-03T00:00:00.000Z');

  assert.equal(resolveOutboundDestination(verifiedMovie, 'watch', enabled, now).ok, true);
  assert.deepEqual(resolveOutboundDestination(verifiedMovie, 'watch', disabled, now), {
    ok: false,
    reason: 'kill_switch',
  });
  assert.deepEqual(resolveOutboundDestination({ ...verifiedMovie, rightsStatus: 'blocked' }, 'watch', enabled, now), {
    ok: false,
    reason: 'rights_not_verified',
  });
  assert.deepEqual(resolveOutboundDestination({ ...verifiedMovie, rightsExpiresAt: '2026-01-01T00:00:00.000Z' }, 'watch', enabled, now), {
    ok: false,
    reason: 'rights_expired',
  });
});

void test('catalogue artwork is self-hosted', () => {
  for (const movie of movies) {
    assert.ok(movie.poster.startsWith('/'));
    assert.ok(movie.backdrop.startsWith('/'));
  }
});

void test('private movie records are protected from Client Component imports', async () => {
  const movieSource = await readFile(new URL('../lib/movies.ts', import.meta.url), 'utf8');
  const browserSource = await readFile(new URL('../components/movie-browser.tsx', import.meta.url), 'utf8');
  assert.match(movieSource, /^import ['"]server-only['"];?/m);
  assert.doesNotMatch(browserSource, /from ['"]\.\.\/lib\/movies(?:\.ts)?['"]/);
  assert.match(browserSource, /from ['"]\.\.\/lib\/catalogue-options['"]/);
});

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
import { requiresRightsReset, validateAdminMovieInput } from '../lib/admin/movie-input.ts';
import { sanitizeUploadedImage } from '../lib/admin/image-sanitizer.ts';
import { isAdminEmail, isAdminUserId } from '../lib/security/admin-allowlist.ts';

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

void test('admin authorization is an explicit bounded allowlist', () => {
  assert.equal(isAdminUserId('owner-a', 'owner-a, owner-b'), true);
  assert.equal(isAdminUserId('owner-c', 'owner-a, owner-b'), false);
  assert.equal(isAdminUserId('owner-a', ''), false);
  assert.equal(isAdminUserId('eleventh', '1,2,3,4,5,6,7,8,9,10,eleventh'), false);
  assert.equal(isAdminEmail('Owner@Example.com', 'owner@example.com'), true);
  assert.equal(isAdminEmail('attacker@example.com', 'owner@example.com'), false);
});

const validAdminMovie = {
  ...verifiedMovie,
  publicationStatus: 'published' as const,
  rightsVerifiedAt: '2026-01-01T00:00:00.000Z',
  rightsExpiresAt: '2027-01-01T00:00:00.000Z',
  rightsReviewer: 'rights-owner',
  rightsReference: 'RIGHTS-TEST-001',
  poster: '/og.png',
  backdrop: '/media/movie-art/123e4567-e89b-12d3-a456-426614174000.jpg',
};

void test('admin movie validation accepts a complete rights-cleared record', () => {
  const result = validateAdminMovieInput(validAdminMovie, Date.parse('2026-09-03T00:00:00.000Z'));
  assert.equal(result.ok, true);
});

void test('admin movie validation rejects missing rights evidence and hostile destinations', () => {
  const result = validateAdminMovieInput({
    ...validAdminMovie,
    rightsReviewer: null,
    rightsReference: null,
    officialWatchUrl: 'https://youtube.com.evil.example/watch?v=abcdefghijk',
    poster: 'https://attacker.example/poster.svg',
  }, Date.parse('2026-09-03T00:00:00.000Z'));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.rightsReviewer);
  assert.ok(result.errors.rightsReference);
  assert.ok(result.errors.officialWatchUrl);
  assert.ok(result.errors.poster);
});

void test('verified delivery changes require a fresh pending-to-verified cycle', () => {
  const current = { rightsStatus: validAdminMovie.rightsStatus, rightsExpiresAt: validAdminMovie.rightsExpiresAt, rightsReference: validAdminMovie.rightsReference, officialWatchUrl: validAdminMovie.officialWatchUrl ?? null, telegramUrl: validAdminMovie.telegramUrl ?? null, telegramChannel: validAdminMovie.telegramChannel ?? null };
  assert.equal(requiresRightsReset(current, { ...current, telegramUrl: 'https://t.me/sublyra_test/456' }), true);
  assert.equal(requiresRightsReset(current, { ...current, rightsStatus: 'pending' }), false);
  assert.equal(requiresRightsReset({ ...current, rightsStatus: 'pending' }, current), false);
});

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length, false);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  return chunk;
}

void test('image sanitizer strips PNG metadata and rejects spoofed content types', async () => {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 1, false);
  headerView.setUint32(4, 1, false);
  header.set([8, 6, 0, 0, 0], 8);
  const bytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk('IHDR', header),
    ...pngChunk('tEXt', new TextEncoder().encode('secret metadata')),
    ...pngChunk('IDAT', new Uint8Array([0])),
    ...pngChunk('IEND', new Uint8Array()),
  ]);
  const sanitized = await sanitizeUploadedImage(new File([bytes], 'art.png', { type: 'image/png' }));
  assert.ok(sanitized);
  assert.equal(new TextDecoder().decode(sanitized.bytes).includes('tEXt'), false);
  assert.equal(await sanitizeUploadedImage(new File([bytes], 'art.svg', { type: 'image/svg+xml' })), null);
});

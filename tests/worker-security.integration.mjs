import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUBLYRA_EXTERNAL_LINKS_ENABLED = 'false';
process.env.SUBLYRA_ADS_ENABLED = 'false';
process.env.SUBLYRA_ADMIN_USER_IDS = 'test-owner';
globalThis.__SUBLYRA_TEST_ENV__ = {};

const worker = (await import('../dist/server/index.js')).default;
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function request(path, init) {
  return worker.fetch(
    new Request(`https://sublyra.test${path}`, init),
    {},
    executionContext,
  );
}

void test('homepage returns hardened headers without private movie fields', async () => {
  const response = await request('/');
  const body = await response.text();
  const csp = response.headers.get('content-security-policy') ?? '';

  assert.equal(response.status, 200);
  assert.match(csp, /'nonce-[a-f0-9]+'/);
  assert.doesNotMatch(csp, /'unsafe-inline'/);
  assert.equal(
    response.headers.get('strict-transport-security'),
    'max-age=31536000; includeSubDomains',
  );
  assert.doesNotMatch(
    body,
    /officialWatchUrl|telegramUrl|rightsReference|rightsReviewer/,
  );
});

void test('catalogue API enforces DTO and resource bounds', async () => {
  const response = await request('/api/movies?page=2&limit=2');
  const body = await response.text();
  const data = JSON.parse(body);

  assert.equal(response.status, 200);
  // The production bundle is deliberately tested without a D1 binding: it must
  // return an empty catalogue rather than resurrecting static/archived records.
  assert.equal(data.results.length, 0);
  assert.equal(data.pagination.total, 0);
  assert.equal(response.headers.get('ratelimit-policy'), '60;w=60');
  assert.doesNotMatch(
    body,
    /officialWatchUrl|telegramUrl|rightsReference|rightsReviewer/,
  );

  const longQuery = await request(`/api/movies?q=${'x'.repeat(81)}`);
  assert.equal(longQuery.status, 400);
  assert.match(longQuery.headers.get('cache-control') ?? '', /no-store/);

  const oversizedPage = await request('/api/movies?limit=25');
  assert.equal(oversizedPage.status, 400);
});

void test('external links fail closed and unsupported methods are denied', async () => {
  const redirect = await request('/out/the-last-lantern/telegram');
  assert.equal(redirect.status, 404);
  assert.match(redirect.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(redirect.headers.get('location'), null);

  const unsupportedAction = await request('/out/the-last-lantern/evil');
  assert.equal(unsupportedAction.status, 404);
  assert.equal(unsupportedAction.headers.get('location'), null);

  const unsupportedMethod = await request('/api/movies', { method: 'POST' });
  assert.equal(unsupportedMethod.status, 405);
});

void test('studio and admin APIs deny unauthenticated or cross-site access', async () => {
  const studio = await request('/studio');
  assert.ok(studio.status === 307 || studio.status === 308);
  assert.match(studio.headers.get('location') ?? '', /^\/signin-with-chatgpt\?return_to=/);

  const unauthenticated = await request('/api/admin/movies');
  assert.equal(unauthenticated.status, 404);
  assert.match(unauthenticated.headers.get('cache-control') ?? '', /no-store/);

  const crossSite = await request('/api/admin/movies', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'x-sublyra-action': 'admin-write',
      'oai-authenticated-user-id': 'test-owner',
      'oai-authenticated-user-email': 'owner@example.test',
    },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
});

void test('anonymous write routes reject requests without same-origin browser evidence', async () => {
  const comment = await request('/api/movies/the-last-lantern/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test', body: 'test' }),
  });
  assert.equal(comment.status, 403);

  const report = await request('/api/movies/the-last-lantern/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceKind: 'stream', sourceId: 's0', reason: 'test' }),
  });
  assert.equal(report.status, 403);
});

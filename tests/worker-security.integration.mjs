import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUBLYRA_EXTERNAL_LINKS_ENABLED = 'false';
process.env.SUBLYRA_ADS_ENABLED = 'false';

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
  assert.equal(data.results.length, 2);
  assert.equal(data.pagination.total, 6);
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

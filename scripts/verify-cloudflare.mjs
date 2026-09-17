import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const origin = process.argv[2];
assert.ok(['https://flixlyra.com', 'https://flixlyra.flixlyra-platform-326e.workers.dev'].includes(origin));
const get = (path, init = {}) => fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(30000), ...init });
const home = await get('/');
assert.equal(home.status, 200);
const html = await home.text();
assert.match(html, /Flixlyra/);
const catalogue = await get('/api/movies?limit=24');
assert.equal(catalogue.status, 200);
const data = await catalogue.json();
assert.ok(Array.isArray(data.results));
assert.ok(data.results.length <= 24);
assert.equal(data.pagination.page, 1);
assert.equal(data.pagination.limit, 24);
assert.equal(typeof data.pagination.hasNextPage, 'boolean');
console.log("Homepage and bounded catalogue: OK");

for (const path of ['/studio', '/api/admin/movies', '/api/admin/domains', '/api/admin/ingest/yts']) {
  const response = await get(path, path.endsWith('/yts') ? { method: 'POST' } : {});
  assert.ok([302, 307, 308, 401, 403, 404].includes(response.status));
  const location = response.headers.get('location');
  if (location) assert.equal(new URL(location).hostname, 'throbbing-limit-326e.cloudflareaccess.com');
  console.log(`${path}: anonymous access denied (${response.status})`);
}
if (origin.includes('.workers.dev')) {
  for (const path of ['/studio', '/api/admin/movies']) {
    const response = await get(path, { headers: {
      'Cf-Access-Jwt-Assertion': 'invalid.jwt.assertion',
      'Cf-Access-Authenticated-User-Email': 'tharushajayasooriya@gmail.com',
      'oai-authenticated-user-id': 'test-owner',
      'oai-authenticated-user-email': 'tharushajayasooriya@gmail.com',
    } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('location'), null);
  }
  console.log('Forged identity headers: rejected without redirects');
}
const media = JSON.parse(await readFile('outputs/cloudflare-migration/media.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const asset of media) {
  const response = await get(asset.path);
  assert.equal(response.status, 200, asset.path);
  const expected = await readFile('outputs/cloudflare-migration/' + asset.key.split('/').at(-1));
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(expected), asset.path);
}
console.log(`R2 media: ${media.length} files verified byte-for-byte`);

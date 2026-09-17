import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const wrangler = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8'));
const proxy = fs.readFileSync(path.join(root, 'proxy.ts'), 'utf8');
const media = fs.readFileSync(path.join(root, 'app', 'media', '[...key]', 'route.ts'), 'utf8');
const db = fs.readFileSync(path.join(root, 'db', 'index.ts'), 'utf8');

test('Free-plan public caching is enabled without an unsupported CPU override', () => {
  assert.equal(wrangler.cache?.enabled, true);
  assert.equal('limits' in wrangler, false);
  assert.equal(wrangler.assets?.run_worker_first, undefined);
});

test('only safe public page GET/HEAD requests receive cacheable headers', () => {
  assert.match(proxy, /function isPublicPageRequest/);
  assert.match(proxy, /public, max-age=60, s-maxage=300/);
  assert.match(proxy, /if \(!publicPage && \(!existingCsrf/);
  assert.match(proxy, /movies\\|movie\\|series/);
});

test('artwork delivery remains streaming and immutable', () => {
  assert.match(media, /new Response\(object\.body/);
  assert.match(media, /public, max-age=31536000, immutable/);
  assert.doesNotMatch(media, /arrayBuffer\(\)/);
});

test('public movie normalization no longer uses per-row SQL json_each quality subqueries', () => {
  assert.doesNotMatch(db, /FROM json_each\(CASE WHEN json_type\(download_sources_json\)/);
  assert.match(db, /availableQualitiesFromSources/);
  assert.match(db, /r2KeyForQuality/);
});

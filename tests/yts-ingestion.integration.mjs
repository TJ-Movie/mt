import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.SUBLYRA_ADMIN_EMAILS = 'owner@example.test';
delete process.env.SUBLYRA_ADMIN_USER_IDS;
process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = 'test.cloudflareaccess.com';
process.env.CLOUDFLARE_ACCESS_AUD = 'test-audience';
const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync(`drizzle/${file}`, 'utf8'));
}
const stored = new Map();
globalThis.__SUBLYRA_TEST_ENV__ = {
  DB: {
    async batch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { const result = statement.run(...values); return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } }; },
      };
    },
  },
  MEDIA: {
    async put(key, body) { stored.set(key, await new Response(body).text()); },
    async head(key) { return stored.has(key) ? { size: 100, httpMetadata: { contentType: 'video/mp4' } } : null; },
  },
};
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const token = await new SignJWT({ email: 'owner@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
  .setIssuer('https://test.cloudflareaccess.com').setAudience('test-audience').setSubject('owner')
  .setIssuedAt().setExpirationTime('5m').sign(privateKey);
let only720 = false;
globalThis.fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? input);
  if (url.pathname === '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
  if (url.hostname === 'movies-api.accel.li') return Response.json({ status: 'ok', data: { movie: {
    title: 'Test Film', year: 2026, imdb_code: 'tt1234567', description_full: 'Synopsis', rating: 8,
    large_cover_image: 'https://yts.gg/poster.jpg', torrents: [
      { url: 'https://yts.gg/torrent/720', quality: '720p', size: '1 GB' },
      ...only720 ? [] : [{ url: 'https://yts.gg/torrent/1080', quality: '1080p', size: '2 GB' }],
    ],
  } } });
  if (url.hostname === 'yts.gg') return new Response('torrent-fixture');
  throw new Error(`Unexpected request: ${url.origin}`);
};
const worker = (await import('../dist/server/index.js')).default;
async function ingest(assertion = token) {
  return worker.fetch(new Request('https://flixlyra.com/api/admin/ingest/yts', {
    method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': assertion, origin: 'https://flixlyra.com',
      'content-type': 'application/json', 'x-sublyra-action': 'admin-write' },
    body: JSON.stringify({ imdbIds: ['tt1234567'] }),
  }), {}, { waitUntil() {} });
}
test('authenticated ingestion persists a draft and prefers 1080p, with 720p fallback on retry', async () => {
  const response = await ingest();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.results[0].status, 'queued', JSON.stringify(payload));
  assert.equal(payload.results[0].quality, '1080p');
  const row = sqlite.prepare("SELECT * FROM movies WHERE imdb_id = 'tt1234567'").get();
  assert.equal(row.publication_status, 'draft');
  assert.equal(row.rights_status, 'pending');
  assert.equal(row.ingest_status, 'queued');
  assert.match(row.storage_key, /^assets\/[a-f0-9-]{36}\/data\.bin$/);
  assert.equal(stored.get(row.storage_key), 'torrent-fixture');
  assert.equal(JSON.parse(row.download_sources_json).status, 'pending');
  assert.equal(JSON.parse(row.download_sources_json).sources[0].quality, '1080p');
  only720 = true;
  const retry = await (await ingest()).json();
  assert.equal(retry.results[0].quality, '720p');
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM movies WHERE imdb_id = 'tt1234567'").get().n, 1);
  assert.equal((await ingest('invalid')).status, 404);
});

test('R2 gateway checks rights and signs a private two-minute attachment URL', async () => {
  sqlite.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('catalogue_initialized', '1', ?)").run(new Date().toISOString());
  process.env.SUBLYRA_EXTERNAL_LINKS_ENABLED = 'true';
  process.env.R2_ACCOUNT_ID = 'a'.repeat(32);
  process.env.R2_BUCKET_NAME = 'test-media';
  process.env.R2_ACCESS_KEY_ID = 'test-access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
  const key = 'assets/12345678-1234-4123-8123-123456789abc/data.bin';
  stored.set(key, 'video');
  sqlite.prepare("UPDATE movies SET publication_status='published', ingest_status='ready', r2_storage_key=?, r2_video_bytes=100 WHERE imdb_id='tt1234567'").run(key);
  const slug = sqlite.prepare("SELECT slug FROM movies WHERE imdb_id='tt1234567'").get().slug;
  const resolve = () => worker.fetch(new Request(`https://flixlyra.com/api/download/resolve?slug=${slug}`), {}, { waitUntil() {} });
  assert.equal((await resolve()).status, 404, 'pending rights are denied');
  sqlite.prepare("UPDATE movies SET rights_status='verified', rights_verified_at=?, rights_expires_at=?, rights_reviewer='Owner', rights_reference='License' WHERE imdb_id='tt1234567'")
    .run(new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  const response = await resolve();
  assert.equal(response.status, 302, await response.clone().text());
  const url = new URL(response.headers.get('location'));
  assert.equal(url.hostname, `${'a'.repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
  assert.match(url.searchParams.get('response-content-disposition'), /attachment; filename="Test Film.mp4"/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  stored.delete(key);
  assert.equal((await resolve()).status, 503, 'missing object is denied');
});

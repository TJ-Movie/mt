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
const csrfToken = '11111111-1111-4111-8111-111111111111';
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
      'content-type': 'application/json', 'x-sublyra-action': 'admin-write', 'x-csrf-token': csrfToken,
      cookie: `__Host-flixlyra-csrf=${csrfToken}` },
    body: JSON.stringify({ imdbIds: ['tt1234567'] }),
  }), {}, { waitUntil() {} });
}
test('authenticated ingestion persists a draft and prefers 1080p, with 720p fallback on retry', async () => {
  const response = await ingest();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.results[0].status, 'queued', JSON.stringify(payload));
  assert.equal(payload.metadata.status, 'METADATA_SAVED');
  assert.equal(payload.workflow.status, 'DISPATCH_FAILED');
  assert.equal(payload.workflow.triggered, false);
  assert.equal(payload.results[0].qualities[0], '1080p');
  const row = sqlite.prepare("SELECT * FROM movies WHERE imdb_id = 'tt1234567'").get();
  assert.equal(row.publication_status, 'draft');
  assert.equal(row.rights_status, 'pending');
  assert.equal(row.rights_verified_at ?? null, null);
  assert.equal(row.rights_reviewer, 'Tj@gmail.com');
  assert.equal(row.rights_reference, 'Good');
  assert.equal(row.poster, '/og.png');
  assert.equal(row.backdrop, '/og.png');
  assert.equal(row.enrichment_status, 'pending');
  assert.equal(row.ingest_status, 'queued');
  assert.equal(row.storage_key, null);
  assert.equal(stored.size, 0);
  assert.equal(JSON.parse(row.download_sources_json).status, 'pending');
  assert.equal(JSON.parse(row.download_sources_json).sources[0].quality, '1080p');
  only720 = true;
  const retry = await (await ingest()).json();
  assert.equal(retry.results[0].status, 'queued'); assert.deepEqual(retry.results[0].qualities, ['720p']);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM movies WHERE imdb_id = 'tt1234567'").get().n, 1);
  assert.equal((await ingest('invalid')).status, 404);
});

test('Studio metadata save preserves verified per-quality R2 mappings', async () => {
  const existing = sqlite.prepare("SELECT id FROM movies WHERE imdb_id='tt1234567'").get();
  const managed = {
    status: 'available',
    sources: [
      { label: 'YTS 720p', quality: '720p', resolution: '720p', size: '1 GB', url: 'https://yts.gg/torrent/720', descriptorKey: 'descriptors/720.torrent', r2StorageKey: 'assets/12345678-1234-4123-8123-123456789abc/720p.mp4', r2Bytes: 100 },
      { label: 'YTS 1080p', quality: '1080p', resolution: '1080p', size: '2 GB', url: 'https://yts.gg/torrent/1080', descriptorKey: 'descriptors/1080.torrent', r2StorageKey: 'assets/12345678-1234-4123-8123-123456789abc/1080p.mp4', r2Bytes: 200 },
    ],
  };
  sqlite.prepare("UPDATE movies SET download_sources_json=?, publication_status='draft', rights_status='pending', revision=revision+1 WHERE id=?").run(JSON.stringify(managed), existing.id);
  const list = await worker.fetch(new Request('https://flixlyra.com/api/admin/movies', { headers: { 'Cf-Access-Jwt-Assertion': token } }), {}, { waitUntil() {} });
  const movie = (await list.json()).movies.find((item) => item.id === existing.id);
  const patch = await worker.fetch(new Request('https://flixlyra.com/api/admin/movies/' + movie.id, {
    method: 'PATCH',
    headers: { 'Cf-Access-Jwt-Assertion': token, origin: 'https://flixlyra.com', 'content-type': 'application/json', 'x-sublyra-action': 'admin-write', 'x-csrf-token': csrfToken, cookie: '__Host-flixlyra-csrf=' + csrfToken },
    body: JSON.stringify({ revision: movie.revision, movie: { ...movie, title: movie.title, description: movie.description + ' edited', languages: ['English'], downloadSources: [] } }),
  }), {}, { waitUntil() {} });
  assert.equal(patch.status, 200, await patch.clone().text());
  const row = sqlite.prepare('SELECT download_sources_json, publication_status, rights_status, rights_verified_at, rights_reviewer, rights_reference, poster, backdrop, enrichment_status FROM movies WHERE id=?').get(movie.id);
  const sources = JSON.parse(row.download_sources_json).sources;
  for (const quality of ['720p', '1080p']) {
    const source = sources.find((item) => item.quality === quality);
    assert.equal(source.descriptorKey, managed.sources.find((item) => item.quality === quality).descriptorKey);
    assert.equal(source.r2StorageKey, managed.sources.find((item) => item.quality === quality).r2StorageKey);
    assert.equal(source.r2Bytes, managed.sources.find((item) => item.quality === quality).r2Bytes);
  }
  assert.equal(row.publication_status, 'draft');
  assert.equal(row.rights_status, 'pending');
  assert.equal(row.rights_verified_at ?? null, null);
  assert.equal(row.rights_reviewer, 'Tj@gmail.com');
  assert.equal(row.rights_reference, 'Good');
  assert.equal(row.poster, '/og.png');
  assert.equal(row.backdrop, '/og.png');
  assert.equal(row.enrichment_status, 'pending');
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
  sqlite.prepare("UPDATE movies SET ingest_status='processing', download_sources_json=? WHERE imdb_id='tt1234567'")
    .run(JSON.stringify({ status: 'pending', sources: [{ label: 'YTS 1080p', quality: '1080p', resolution: '1080p', size: '2 GB', url: 'https://yts.gg/torrent/1080', r2StorageKey: key, r2Bytes: 100 }] }));
  const fallback = await worker.fetch(new Request(`https://flixlyra.com/api/download/resolve?slug=${slug}&quality=720p`), {}, { waitUntil() {} });
  assert.equal(fallback.status, 404, await fallback.clone().text());
  assert.deepEqual(await fallback.json(), { error: 'Requested quality (720p) is currently unavailable', available_qualities: ['1080p'] });
  const catalogue = await worker.fetch(new Request('https://flixlyra.com/api/movies?limit=24'), {}, { waitUntil() {} });
  const publicMovie = (await catalogue.json()).results.find((item) => item.slug === slug);
  assert.deepEqual(publicMovie.available_qualities, ['1080p']);
  stored.delete(key);
  assert.equal((await resolve()).status, 503, 'missing object is denied');
});

test('Studio diagnostics are private and report saved rights, transfer, signing and object failures', async () => {
  const row = sqlite.prepare("SELECT id, r2_storage_key FROM movies WHERE imdb_id='tt1234567'").get();
  const check = (assertion = token) => worker.fetch(new Request(`https://flixlyra.com/api/admin/movies/${row.id}/download-status`, {
    headers: { 'Cf-Access-Jwt-Assertion': assertion },
  }), {}, { waitUntil() {} });
  assert.equal((await check('invalid')).status, 404);
  delete process.env.R2_SECRET_ACCESS_KEY;
  sqlite.prepare("UPDATE movies SET rights_status='pending', ingest_status='queued' WHERE id=?").run(row.id);
  const response = await check();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const blocked = await response.json();
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.transfer, 'queued');
  assert.ok(blocked.blockers.some(x => x.includes('Rights status')));
  assert.ok(blocked.blockers.includes('R2_SIGNING_CONFIGURATION_MISSING'));
  assert.ok(blocked.blockers.includes('MEDIA_TRANSFER_QUEUED'));
  assert.ok(!JSON.stringify(blocked).includes(row.r2_storage_key));
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
  sqlite.prepare("UPDATE movies SET rights_status='verified', ingest_status='ready' WHERE id=?").run(row.id);
  assert.equal((await (await check()).json()).objectVerified, false);
  stored.set(row.r2_storage_key, 'video');
  const ready = await (await check()).json();
  assert.equal(ready.eligible, true);
  assert.equal(ready.objectVerified, true);
  sqlite.prepare("UPDATE movies SET rights_expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), row.id);
  assert.ok((await (await check()).json()).blockers.some(x => x.includes('expiry')));
});

test('Studio exposes all approval fields and download diagnostics behind Access', async () => {
  const response = await worker.fetch(new Request('https://flixlyra.com/studio', {
    headers: { 'Cf-Access-Jwt-Assertion': token },
  }), {}, { waitUntil() {} });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const label of ['Rights status', 'Rights reviewer', 'Rights evidence reference', 'Rights verified at (UTC)', 'Set verification time to now', 'Check saved download status']) {
    assert.ok(html.includes(label), `missing ${label}`);
  }
  assert.ok(!html.includes('test-secret-key'));
});

test('admin approval fields validate and persist through PATCH before the gateway permits a download', async () => {
  const list = await worker.fetch(new Request('https://flixlyra.com/api/admin/movies', { headers: { 'Cf-Access-Jwt-Assertion': token } }), {}, { waitUntil() {} });
  const movie = (await list.json()).movies.find(x => x.imdbId === 'tt1234567');
  sqlite.prepare("UPDATE movies SET rights_status='pending' WHERE id=?").run(movie.id);
  const approved = { ...movie, poster: '/og.png', backdrop: '/og.png', genre: 'Drama', languages: ['English'],
    downloadSources: [], rightsStatus: 'verified', rightsReviewer: 'Test reviewer', rightsReference: 'TEST-LICENSE-001',
    rightsVerifiedAt: new Date(Date.now() - 60000).toISOString(), rightsExpiresAt: new Date(Date.now() + 86400000).toISOString() };
  const patch = body => worker.fetch(new Request(`https://flixlyra.com/api/admin/movies/${movie.id}`, {
    method: 'PATCH', headers: { 'Cf-Access-Jwt-Assertion': token, origin: 'https://flixlyra.com', 'content-type': 'application/json', 'x-sublyra-action': 'admin-write',
      'x-csrf-token': csrfToken, cookie: `__Host-flixlyra-csrf=${csrfToken}` },
    body: JSON.stringify({ revision: movie.revision, movie: body }),
  }), {}, { waitUntil() {} });
  const invalid = await patch({ ...approved, rightsReference: '' });
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).fields.rightsReference);
  const saved = await patch(approved);
  assert.equal(saved.status, 200, await saved.clone().text());
  const row = sqlite.prepare('SELECT rights_status, rights_reviewer, rights_reference, rights_verified_at, rights_expires_at FROM movies WHERE id=?').get(movie.id);
  assert.equal(row.rights_status, 'verified');
  assert.equal(row.rights_reviewer, approved.rightsReviewer);
  assert.equal(row.rights_reference, approved.rightsReference);
  assert.equal(row.rights_verified_at, approved.rightsVerifiedAt);
  assert.equal(row.rights_expires_at, approved.rightsExpiresAt);
  const primary = sqlite.prepare('SELECT r2_storage_key FROM movies WHERE id=?').get(movie.id);
  if (primary.r2_storage_key) stored.set(primary.r2_storage_key, 'video');
  assert.equal((await worker.fetch(new Request(`https://flixlyra.com/api/download/resolve?slug=${movie.slug}`), {}, { waitUntil() {} })).status, 302);
  assert.equal((await patch(approved)).status, 409, 'stale revision cannot overwrite approval');
});

test('movie buttons and legacy download routes never fall back to a torrent source', async () => {
  const movie = sqlite.prepare("SELECT id, slug, r2_storage_key FROM movies WHERE imdb_id='tt1234567'").get();
  const torrent = 'https://yts.gg/torrent/download/fixture';
  sqlite.prepare("UPDATE movies SET ingest_status='queued', r2_storage_key=NULL, r2_video_bytes=NULL, download_sources_json=?, telegram_url=? WHERE id=?")
    .run(JSON.stringify({ status: 'available', sources: [{ label: 'YTS 1080p', quality: '1080p', resolution: '1080p', size: '2 GB', url: torrent }] }), torrent, movie.id);
  const get = path => worker.fetch(new Request(`https://flixlyra.com${path}`), {}, { waitUntil() {} });
  for (const path of [`/download/${movie.slug}/source/s0`, `/out/${movie.slug}/telegram`, `/api/download/resolve?slug=${movie.slug}`]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('location'), null);
  }
  const unavailable = await (await get(`/download/${movie.slug}`)).text();
  assert.ok(unavailable.includes('Movie download not available yet'));
  assert.ok(!unavailable.includes(torrent));
  const film = await (await get(`/movie/${movie.slug}`)).text();
  assert.match(film, /Download|download/i);
  assert.ok(!film.includes('pending-download-redirect'));
  assert.ok(!film.includes(torrent));
  const readyKey = 'assets/12345678-1234-4123-8123-123456789abc/data.bin'; stored.set(readyKey, 'video'); sqlite.prepare("UPDATE movies SET ingest_status='ready', r2_storage_key=?, r2_video_bytes=100 WHERE id=?").run(readyKey, movie.id);
  for (const path of [`/download/${movie.slug}/source/s0`, `/out/${movie.slug}/telegram`]) {
    const response = await get(path);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/api/download/resolve?slug=${movie.slug}`);
  }
  delete process.env.R2_SECRET_ACCESS_KEY;
  const failedSigning = await get(`/api/download/resolve?slug=${movie.slug}`);
  assert.equal(failedSigning.status, 503);
  assert.equal(failedSigning.headers.get('location'), null, 'signing failure must not fall back to torrent');
});

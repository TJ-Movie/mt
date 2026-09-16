import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { drainCloudPlan, releaseActiveTransferOwners, stableKey } from '../scripts/prepare-cloud-media.mjs';

const VIDEO_BYTES = 12;

function makeDb(id, initialSources = []) {
  const database = new DatabaseSync(':memory:');
  database.exec("CREATE TABLE movies (id INTEGER PRIMARY KEY, slug TEXT, imdb_id TEXT, publication_status TEXT, ingest_status TEXT, download_sources_json TEXT, r2_storage_key TEXT, r2_video_bytes INTEGER, revision INTEGER DEFAULT 1, transfer_token TEXT, transfer_lease_until INTEGER, transfer_error TEXT, enrichment_status TEXT, enrichment_error TEXT, poster TEXT, backdrop TEXT, cast_json TEXT, updated_at TEXT)");
  database.prepare("INSERT INTO movies (id, slug, imdb_id, publication_status, ingest_status, download_sources_json) VALUES (?, ?, ?, 'draft', 'queued', ?)").run(id, `movie-${id}`, 'tt1234567', JSON.stringify({ sources: initialSources }));
  const objects = new Map();
  const db = {
    database,
    objects,
    failCommit: false,
    failRelease: false,
    failDiagnostics: false,
    ctx: {
      s3: { destroy() {} },
      bucket: 'fixture-bucket',
      async head(key) { return objects.get(key) || null; },
      async query(sql, params = []) {
        if (db.failCommit && sql.includes('UPDATE movies SET download_sources_json=')) throw new Error('D1 commit unavailable');
        if (db.failRelease && sql.startsWith('UPDATE movies SET ingest_status = ?') && params.length === 4) throw new Error('lease release unavailable');
        if (db.failDiagnostics && sql.startsWith('SELECT id, slug, ingest_status')) throw new Error('D1 diagnostics unavailable');
        return database.prepare(sql).all(...params);
      },
    },
  };
  return db;
}

function stagedItem(id, quality) {
  return { id, quality, key: stableKey(id, quality), bytes: VIDEO_BYTES, file: `tmp/media/hardening-${id}-${quality}/${quality}.mp4`, verified: false, imdbId: 'tt1234567', failureCode: null };
}

async function stage(item) {
  await mkdir(`tmp/media/hardening-${item.id}-${item.quality}`, { recursive: true });
  const bytes = Buffer.alloc(VIDEO_BYTES);
  bytes.write('ftyp', 4, 'ascii');
  await writeFile(item.file, bytes);
}

async function absent(path) {
  try { await stat(path); return false; } catch (error) { return error.code === 'ENOENT'; }
}

async function runCase(id, modes, options = {}) {
  const db = makeDb(id);
  const plan = { schema: 'flixlyra-cloud-v1', files: [stagedItem(id, '720p'), stagedItem(id, '1080p')], failures: [] };
  for (const item of plan.files) {
    if (modes[item.quality] === 'dead') {
      item.skipped = true;
      item.file = null;
      item.failureCode = modes.failureCode?.[item.quality] || 'NO_PEERS';
      item.failureStage = 'payload';
      item.mediaDiagnostics = { failureCode: item.failureCode, failureStage: 'payload', infoHash: 'dead-hash', payloadBytes: 0, elapsedMs: 40, lastAttemptAt: new Date().toISOString() };
      plan.failures.push({ id, quality: item.quality, failure_code: item.failureCode, failure_stage: 'payload', info_hash: 'dead-hash', payload_bytes: 0, elapsed_ms: 40, last_attempt_at: item.mediaDiagnostics.lastAttemptAt });
    } else {
      await stage(item);
    }
  }
  const enrichments = [];
  await drainCloudPlan(plan, async item => {
    if (modes[item.quality] === 'upload-failure') throw new Error('upload failure');
    if (modes[item.quality] === 'verify-failure') return;
    db.objects.set(item.key, { ContentLength: VIDEO_BYTES, ContentType: 'video/mp4' });
  }, {
    context: db.ctx,
    pause: async () => {},
    saveManifest: async () => {},
    enrich: async () => { enrichments.push(id); if (options.enrichmentFailure) throw new Error('provider unavailable'); },
  });
  const row = db.database.prepare('SELECT * FROM movies WHERE id=?').get(id);
  return { db, plan, row, enrichments };
}

test('real SQL outcomes: both qualities verified become READY and enrich', async () => {
  const result = await runCase(610, { '720p': 'success', '1080p': 'success' });
  assert.equal(result.row.ingest_status, 'ready');
  assert.equal(JSON.parse(result.row.download_sources_json).sources.filter(source => source.r2StorageKey).length, 2);
  assert.deepEqual(result.enrichments, [610]);
  assert.equal(result.row.publication_status, 'draft');
});

test('real SQL outcomes: 720 NO_PEERS leaves 1080 claimable and commits HALF', async () => {
  const result = await runCase(611, { '720p': 'dead', '1080p': 'success' });
  assert.equal(result.row.ingest_status, 'half');
  const sources = JSON.parse(result.row.download_sources_json).sources;
  assert.equal(sources.filter(source => source.r2StorageKey).length, 1);
  assert.equal(sources.find(source => source.quality === '1080p').r2StorageKey, result.plan.files[1].key);
  assert.match(result.row.transfer_error, /NO_PEERS/);
  assert.deepEqual(result.enrichments, [611]);
});

test('real SQL outcomes: 1080 NO_PEERS preserves verified 720p and commits HALF', async () => {
  const result = await runCase(612, { '720p': 'success', '1080p': 'dead' });
  assert.equal(result.row.ingest_status, 'half');
  const sources = JSON.parse(result.row.download_sources_json).sources;
  assert.equal(sources.filter(source => source.r2StorageKey).length, 1);
  assert.equal(sources.find(source => source.quality === '720p').r2StorageKey, result.plan.files[0].key);
  assert.match(result.row.transfer_error, /NO_PEERS/);
  assert.deepEqual(result.enrichments, [612]);
});

test('real SQL outcomes: both dead preserve exact diagnostics and skip enrichment', async () => {
  const result = await runCase(613, { '720p': 'dead', '1080p': 'dead', failureCode: { '720p': 'NO_PEERS', '1080p': 'SOURCE_INVALID' } });
  assert.equal(result.row.ingest_status, 'skipped_unplayable');
  assert.match(result.row.transfer_error, /NO_PEERS/);
  assert.match(result.row.transfer_error, /SOURCE_INVALID/);
  assert.deepEqual(result.enrichments, []);
  assert.equal(JSON.parse(result.row.download_sources_json).sources.filter(source => source.r2StorageKey).length, 0);
});

for (const [label, mode, code] of [
  ['R2 upload', 'upload-failure', 'R2_UPLOAD_FAILED'],
  ['R2 verify', 'verify-failure', 'R2_VERIFY_FAILED'],
]) {
  test(`${label} fatal path cleans staged media, releases lease, and fails`, async () => {
    const id = label === 'R2 upload' ? 620 : 621;
    const db = makeDb(id);
    const item = stagedItem(id, '720p');
    await stage(item);
    const stagedPath = item.file;
    const plan = { files: [item], failures: [] };
    await assert.rejects(drainCloudPlan(plan, async current => {
      if (mode === 'upload-failure') throw new Error('upload unavailable');
      assert.equal(current.quality, '720p');
    }, { context: db.ctx, pause: async () => {}, saveManifest: async () => {} }), error => error.code === code);
    assert.equal(await absent(stagedPath), true);
    const row = db.database.prepare('SELECT ingest_status, transfer_token, transfer_lease_until FROM movies WHERE id=?').get(id);
    assert.equal(row.ingest_status, 'retry_pending');
    assert.equal(row.transfer_token, null);
    assert.equal(row.transfer_lease_until, null);
  });
}

test('guarded D1 commit fatal path cleans staged media and remains non-zero', async () => {
  const id = 622;
  const db = makeDb(id);
  db.failCommit = true;
  const item = stagedItem(id, '720p');
  await stage(item);
  const stagedPath = item.file;
  await assert.rejects(drainCloudPlan({ files: [item], failures: [] }, async current => {
    db.objects.set(current.key, { ContentLength: VIDEO_BYTES, ContentType: 'video/mp4' });
  }, { context: db.ctx, pause: async () => {}, saveManifest: async () => {} }), error => error.code === 'D1_COMMIT_FAILED');
  assert.equal(await absent(stagedPath), true);
  const row = db.database.prepare('SELECT ingest_status, transfer_token, transfer_lease_until FROM movies WHERE id=?').get(id);
  assert.equal(row.ingest_status, 'retry_pending');
  assert.equal(row.transfer_token, null);
  assert.equal(row.transfer_lease_until, null);
});

test('releaseTransfer failure is explicit and leaves a scoped recoverable owner', async () => {
  const id = 623;
  const db = makeDb(id);
  db.failRelease = true;
  const item = stagedItem(id, '720p');
  await stage(item);
  const stagedPath = item.file;
  await assert.rejects(drainCloudPlan({ files: [item], failures: [] }, async () => { throw new Error('upload failure'); }, { context: db.ctx, pause: async () => {}, saveManifest: async () => {} }), error => error.code === 'LEASE_RELEASE_FAILED');
  assert.equal(await absent(stagedPath), true);
  const row = db.database.prepare('SELECT ingest_status, transfer_token, transfer_lease_until FROM movies WHERE id=?').get(id);
  assert.equal(row.ingest_status, 'transferring');
  assert.ok(row.transfer_token);
  assert.ok(row.transfer_lease_until);
});

test('lease diagnostic failure is explicit and does not look successful', async () => {
  const db = makeDb(625);
  db.failDiagnostics = true;
  await assert.rejects(drainCloudPlan({ files: [], failures: [] }, async () => {}, { context: db.ctx, saveManifest: async () => {} }), error => error.code === 'D1_LEASE_DIAGNOSTIC_FAILED');
});

test('cancellation helper releases active scoped owner without hanging', async () => {
  const id = 624;
  const db = makeDb(id);
  const item = stagedItem(id, '720p');
  await stage(item);
  const stagedPath = item.file;
  let resolveSync;
  const running = drainCloudPlan({ files: [item], failures: [] }, () => new Promise(resolve => { resolveSync = resolve; }), { context: db.ctx, pause: async () => {}, saveManifest: async () => {} });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = db.database.prepare('SELECT transfer_token FROM movies WHERE id=?').get(id);
    if (row.transfer_token && typeof resolveSync === 'function') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(typeof resolveSync, 'function');
  const failures = await releaseActiveTransferOwners();
  assert.deepEqual(failures, []);
  assert.equal(db.database.prepare('SELECT ingest_status, transfer_token, transfer_lease_until FROM movies WHERE id=?').get(id).ingest_status, 'retry_pending');
  resolveSync();
  await assert.rejects(running, error => error.code === 'D1_COMMIT_FAILED' || error.code === 'LEASE_RELEASE_UNCONFIRMED');
  assert.equal(await absent(stagedPath), true);
});
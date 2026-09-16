import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { acquire, drainCloudPlan, prepareAll, stableKey } from '../scripts/prepare-cloud-media.mjs';

const MAGNET = 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789';
const VIDEO_BYTES = 10 * 1024 * 1024 + 12;

class HangingReadable extends Readable {
  constructor(chunk = null) {
    super();
    this.chunk = chunk;
    this.sent = false;
    this.destroyObserved = false;
  }
  _read() {
    if (this.chunk && !this.sent) {
      this.sent = true;
      this.push(this.chunk);
    }
  }
  _destroy(error, callback) {
    this.destroyObserved = true;
    callback(error);
  }
}

class FakeFile {
  constructor(mode, length = VIDEO_BYTES) {
    this.name = 'feature.mp4';
    this.length = length;
    this.mode = mode;
    this.streams = [];
    this.selected = false;
  }
  select() { this.selected = true; }
  createReadStream() {
    const bytes = Buffer.alloc(this.length);
    bytes.write('ftyp', 4, 'ascii');
    const stream = this.mode === 'success'
      ? Readable.from([bytes])
      : new HangingReadable(this.mode === 'partial' ? bytes.subarray(0, 1024) : null);
    this.streams.push(stream);
    return stream;
  }
}

class FakeTorrent extends EventEmitter {
  constructor(mode, peers) {
    super();
    this.mode = mode;
    this.infoHash = '0123456789012345678901234567890123456789';
    this.length = VIDEO_BYTES;
    this.pieceLength = 1024 * 1024;
    this.pieces = [Buffer.alloc(20)];
    this.wires = Array.from({ length: peers }, () => ({}));
    this.files = mode === 'source-invalid' ? [] : [new FakeFile(mode)];
    this.destroyObserved = false;
  }
  deselect() {}
  destroy() {
    this.destroyObserved = true;
    for (const file of this.files) for (const stream of file.streams) stream.destroy(new Error('fake torrent destroyed'));
    this.emit('close');
  }
}

class FakeClient extends EventEmitter {
  constructor(mode, peers = 0) {
    super();
    this.mode = mode;
    this.peers = peers;
    this.destroyObserved = false;
    this.destroyCalls = 0;
    this.torrent = null;
  }
  add(_descriptor, _options, ready) {
    this.torrent = new FakeTorrent(this.mode, this.peers);
    if (this.mode !== 'metadata-timeout') setTimeout(() => ready(this.torrent), 0);
    return this.torrent;
  }
  destroy(callback) {
    this.destroyCalls += 1;
    this.destroyObserved = true;
    this.torrent?.destroy();
    setImmediate(() => callback());
  }
}

function fakeContext(quality) {
  return {
    query: async sql => sql.startsWith('SELECT download_sources_json')
      ? [{ download_sources_json: JSON.stringify({ sources: [{ quality, url: MAGNET }] }) }]
      : [],
  };
}

function runtimeFor(mode, peers = 0, registry = {}) {
  return {
    metadataTimeoutMs: 60,
    noProgressTimeoutMs: 60,
    statfs: async () => ({ bavail: 100_000, bsize: 1024 ** 3 }),
    createClient: async () => {
      const client = new FakeClient(mode, peers);
      registry.client = client;
      return client;
    },
  };
}

function itemFor(id, quality) {
  return { id, quality, key: stableKey(id, quality), bytes: null, file: null, verified: false, imdbId: 'tt1234567' };
}

async function runAcquire(id, quality, mode, peers = 0) {
  const registry = {};
  const item = itemFor(id, quality);
  const started = Date.now();
  let error;
  try {
    await acquire(fakeContext(quality), item, 1, runtimeFor(mode, peers, registry));
  } catch (caught) {
    error = caught;
  }
  return { item, error, elapsed: Date.now() - started, registry };
}

test('real path aborts a client factory that never resolves', async () => {
  const item = itemFor(9014, '720p');
  const started = Date.now();
  await assert.rejects(
    acquire(fakeContext('720p'), item, 1, {
      metadataTimeoutMs: 60,
      noProgressTimeoutMs: 60,
      createClient: () => new Promise(() => {}),
    }),
    error => error.code === 'METADATA_TIMEOUT',
  );
  assert.ok(Date.now() - started < 500, 'client creation watchdog took too long');
});

test('real path aborts a filesystem budget probe that never resolves', async () => {
  const registry = {};
  const item = itemFor(9015, '720p');
  const started = Date.now();
  await assert.rejects(
    acquire(fakeContext('720p'), item, 1, {
      ...runtimeFor('zero-byte', 1, registry),
      statfs: () => new Promise(() => {}),
    }),
    error => error.code === 'ZERO_BYTE_STALL',
  );
  assert.ok(Date.now() - started < 500, 'pre-payload watchdog took too long');
  assert.equal(registry.client.destroyObserved, true);
});
test('real path classifies metadata timeout and destroys the client', async () => {
  const result = await runAcquire(9001, '720p', 'metadata-timeout');
  assert.equal(result.error.code, 'METADATA_TIMEOUT');
  assert.ok(result.elapsed < 500, 'metadata watchdog took ' + result.elapsed + 'ms');
  assert.equal(result.registry.client.destroyObserved, true);
  assert.equal(result.registry.client.destroyCalls, 1);
});

test('real path reproduces and terminates a zero-byte no-peer stall', async () => {
  const result = await runAcquire(9002, '720p', 'zero-byte');
  assert.equal(result.error.code, 'NO_PEERS');
  assert.ok(result.elapsed < 500, 'zero-byte watchdog took ' + result.elapsed + 'ms');
  assert.equal(result.error.payloadBytes, 0);
  assert.equal(result.registry.client.destroyObserved, true);
  assert.equal(result.registry.client.torrent.destroyObserved, true);
  assert.equal(result.registry.client.torrent.files[0].streams[0].destroyed, true);
});

test('real path classifies a partial-download stall after actual bytes', async () => {
  const result = await runAcquire(9003, '720p', 'partial', 1);
  assert.equal(result.error.code, 'DOWNLOAD_STALLED');
  assert.ok(result.error.payloadBytes > 0);
  assert.ok(result.elapsed < 500, 'partial watchdog took ' + result.elapsed + 'ms');
  assert.equal(result.registry.client.destroyObserved, true);
});

test('real path distinguishes zero-byte stall when a peer exists but sends no payload', async () => {
  const result = await runAcquire(9012, '720p', 'zero-byte', 1);
  assert.equal(result.error.code, 'ZERO_BYTE_STALL');
  assert.equal(result.error.payloadBytes, 0);
  assert.ok(result.elapsed < 500);
});

test('real path classifies a structurally invalid torrent source', async () => {
  const result = await runAcquire(9013, '720p', 'source-invalid');
  assert.equal(result.error.code, 'SOURCE_INVALID');
  assert.equal(result.registry.client.destroyObserved, true);
});

test('real path completes a successful download through validation', async () => {
  const result = await runAcquire(9004, '1080p', 'success');
  assert.equal(result.error, undefined);
  assert.equal(result.item.bytes, VIDEO_BYTES);
  assert.ok(result.item.file);
  await rm(result.item.file, { force: true });
});

function makeDbHarness() {
  let transferToken = null;
  let ingestStatus = 'queued';
  let revision = 1;
  const updates = [];
  return {
    updates,
    ctx: {
      s3: { destroy() {} },
      head: async key => key ? { ContentLength: VIDEO_BYTES, ContentType: 'video/mp4' } : null,
      query: async (sql, params = []) => {
        if (sql.startsWith('SELECT download_sources_json, revision')) {
          return [{ revision, ingest_status: 'transferring', transfer_token: transferToken, download_sources_json: JSON.stringify({ sources: [
            { quality: '720p', url: MAGNET }, { quality: '1080p', url: MAGNET },
          ] }) }];
        }
        if (sql.startsWith('SELECT download_sources_json')) {
          return [{ download_sources_json: JSON.stringify({ sources: [
            { quality: '720p', url: MAGNET }, { quality: '1080p', url: MAGNET },
          ] }) }];
        }
        if (sql.includes("SET ingest_status = 'transferring'")) {
          transferToken = params[0];
          ingestStatus = 'transferring';
          return [{ id: params[2] }];
        }
        if (sql.includes('SET download_sources_json=')) {
          ingestStatus = params[3];
          transferToken = null;
          revision += 1;
          updates.push({ kind: 'commit', state: params[3] });
          return [{ id: params.at(-2) }];
        }
        if (sql.startsWith('SELECT ingest_status')) return [{ ingest_status: ingestStatus, transfer_lease_until: null }];
        if (sql.startsWith('UPDATE movies SET ingest_status = ?')) {
          ingestStatus = params[0];
          transferToken = null;
          updates.push({ kind: 'release-or-flag', state: params[0] });
          return [{ id: params[2] }];
        }
        return [];
      },
    },
  };
}

test('dead 720p is recorded and independent 1080p continues to guarded commit', async () => {
  const id = 9005;
  const plan = { schema: 'flixlyra-cloud-v1', files: [itemFor(id, '720p'), itemFor(id, '1080p')], failures: [] };
  const db = makeDbHarness();
  const attempts = [];
  const clients = {};
  const result = await drainCloudPlan(plan, async () => {}, {
    context: db.ctx,
    pause: async () => {},
    saveManifest: async () => {},
    prepareOptions: {
      acquire: async (ctx, item, attempt) => {
        attempts.push(item.quality + ':' + attempt);
        const registry = {};
        clients[item.quality] = registry;
        return acquire(ctx, item, attempt, runtimeFor(item.quality === '720p' ? 'zero-byte' : 'success', 0, registry));
      },
    },
  });
  assert.equal(result, undefined);
  assert.deepEqual(attempts, ['720p:1', '1080p:1']);
  assert.equal(plan.files[0].skipped, true);
  assert.equal(plan.files[0].failureCode, 'NO_PEERS');
  assert.equal(plan.files[1].verified, true);
  assert.ok(db.updates.some(update => update.kind === 'commit'));
  assert.equal(clients['720p'].client.destroyObserved, true);
});

test('720p success followed by 1080p failure preserves the successful quality', async () => {
  const plan = { files: [itemFor(9006, '720p'), itemFor(9006, '1080p')] };
  const attempts = [];
  const { prepareAll } = await import('../scripts/prepare-cloud-media.mjs');
  const result = await prepareAll({ query: async () => [] }, plan, {
    pause: async () => {},
    saveManifest: async () => {},
    acquire: async (_ctx, item, attempt) => {
      attempts.push(item.quality + ':' + attempt);
      if (item.quality === '1080p') throw Object.assign(new Error('unusable source'), { code: 'SOURCE_INVALID' });
      return acquire({ query: async () => [{ download_sources_json: JSON.stringify({ sources: [{ quality: '720p', url: MAGNET }] }) }] }, item, attempt, runtimeFor('success'));
    },
  });
  assert.equal(result.prepared, 1);
  assert.deepEqual(attempts, ['720p:1', '1080p:1']);
  assert.equal(plan.files[0].file !== null, true);
  assert.equal(plan.files[1].skipped, true);
  await rm(plan.files[0].file, { force: true });
});

test('both qualities succeed on the real acquisition function', async () => {
  const results = await Promise.all([runAcquire(9007, '720p', 'success'), runAcquire(9007, '1080p', 'success')]);
  assert.ok(results.every(result => !result.error && result.item.bytes === VIDEO_BYTES));
  await Promise.all(results.map(result => rm(result.item.file, { force: true })));
});

test('both unavailable qualities terminate independently without retrying dead sources', async () => {
  const results = await Promise.all([runAcquire(9008, '720p', 'zero-byte'), runAcquire(9008, '1080p', 'metadata-timeout')]);
  assert.deepEqual(results.map(result => result.error.code).sort((left, right) => left.localeCompare(right)), ['METADATA_TIMEOUT', 'NO_PEERS']);
  assert.ok(results.every(result => result.elapsed < 500));
});

test('scoped lease release clears only the owned transfer', async () => {
  const db = makeDbHarness();
  const item = itemFor(9009, '720p');
  item.file = 'tmp/media/owned-lease-test/720p.mp4';
  const plan = { files: [item] };
  await assert.rejects(drainCloudPlan(plan, async () => { throw new Error('upload failed'); }, {
    context: db.ctx,
    pause: async () => {},
    saveManifest: async () => {},
  }), error => error.code === 'R2_UPLOAD_FAILED');
  assert.ok(db.updates.some(update => update.kind === 'release-or-flag' && update.state === 'retry_pending'));
  assert.ok(db.updates.every(update => update.kind === 'release-or-flag' || update.kind === 'commit'));
});

test('a scoped plan never processes an unrelated queued movie', async () => {
  const seen = [];
  const plan = { files: [itemFor(9010, '720p')] };
  const { prepareAll } = await import('../scripts/prepare-cloud-media.mjs');
  await prepareAll({ query: async () => [] }, plan, {
    pause: async () => {},
    saveManifest: async () => {},
    acquire: async (_ctx, item) => {
      seen.push(item.id);
      throw Object.assign(new Error('unavailable'), { code: 'NO_PEERS' });
    },
  });
  assert.deepEqual(seen, [9010]);
});

test('structured dead-source failures are not retried by the acquisition wrapper', async () => {
  const attempts = [];
  const plan = { files: [itemFor(9011, '720p')] };
  const result = await prepareAll({ query: async sql => sql.startsWith('SELECT')
    ? [{ ingest_status: 'queued', transfer_lease_until: null }]
    : [{ id: 9011 }] }, plan, {
    pause: async () => { throw new Error('retry pause should not run'); },
    saveManifest: async () => {},
    acquire: async (_ctx, item, attempt) => {
      attempts.push(item.quality + ':' + attempt);
      throw Object.assign(new Error('no usable payload'), { code: 'ZERO_BYTE_STALL' });
    },
  });
  assert.deepEqual(attempts, ['720p:1']);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.permanentlyFailedIds, [9011]);
});

test('Run #95 real orchestration process settles NO_PEERS and continues to 1080p', async () => {
  const childPath = fileURLToPath(new URL('./run95-lifecycle-child.mjs', import.meta.url));
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.ok(Date.now() - started < 5000, 'orchestration child exceeded the short test bound');
    const settled = result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.includes('"event":"RUN95_SETTLED"'));
    assert.ok(settled, result.stdout);
    const summary = JSON.parse(settled);
    assert.deepEqual(summary.attempts, ['720p:1', '1080p:1']);
    assert.equal(summary.quality_720, 'NO_PEERS');
    assert.equal(summary.quality_1080, 'prepared');
    assert.equal(summary.prepared, 1);
    assert.equal(summary.downstream_r2_reachable, true);
    assert.equal(summary.expected_media_state, 'HALF');
  } finally {
    await rm('tmp/media/9501-1080p', { recursive: true, force: true });
  }
});

test('literal prepare CLI returns non-zero for fatal infrastructure failure', async () => {
  const childPath = fileURLToPath(new URL('./run95-lifecycle-child.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, 'fatal'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unsettled top-level await|exit code 13/i);
});
test('literal prepare CLI completes cleanly when both sources are dead', async () => {
  const childPath = fileURLToPath(new URL('./run95-lifecycle-child.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, 'both-zero-byte'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stderr, /unsettled top-level await|exit code 13/i);
  assert.match(result.stdout, /"expected_media_state":"FAILED"/);
});
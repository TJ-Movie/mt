import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assertLegalTransition, claimTransfer, diagnoseStaleTransfers, isLeaseActive, releaseTransfer } from '../scripts/ingest-state.mjs';
import { parse } from 'yaml';

function makeContext() {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE movies (id INTEGER PRIMARY KEY, slug TEXT, ingest_status TEXT, transfer_token TEXT, transfer_lease_until INTEGER, transfer_error TEXT, updated_at TEXT)');
  database.exec("INSERT INTO movies (id, slug, ingest_status) VALUES (1, 'one', 'queued'), (2, 'two', 'transferring')");
  return {
    database,
    async query(sql, params = []) {
      return database.prepare(sql).all(...params);
    },
  };
}

test('legal transitions reject unknown and illegal states', () => {
  assert.doesNotThrow(() => assertLegalTransition('queued', 'processing'));
  assert.throws(() => assertLegalTransition('ready', 'none'), /Illegal/);
  assert.throws(() => assertLegalTransition('unknown', 'ready'), /Unknown/);
});

test('only one worker can claim an active movie transfer', async () => {
  const ctx = makeContext();
  const now = 2_000_000_000;
  const first = await claimTransfer(ctx, { id: 1, quality: '720p', token: '720p:attempt-a-123456', leaseSeconds: 3600, now });
  const second = await claimTransfer(ctx, { id: 1, quality: '720p', token: '720p:attempt-b-123456', leaseSeconds: 3600, now });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  const row = ctx.database.prepare('SELECT ingest_status, transfer_token, transfer_lease_until FROM movies WHERE id=1').get();
  assert.equal(row.ingest_status, 'transferring');
  assert.equal(row.transfer_token, first.token);
  assert.equal(row.transfer_lease_until, now + 3600);
  assert.equal(isLeaseActive(row.transfer_lease_until, now), true);
});

test('stale transfer diagnostics are read-only and classify missing and expired leases', async () => {
  const ctx = makeContext();
  const now = 2_000_000_000;
  ctx.database.prepare("UPDATE movies SET transfer_token=NULL, transfer_lease_until=NULL WHERE id=2").run();
  const records = await diagnoseStaleTransfers(ctx, { now });
  assert.deepEqual(records.map((item) => item.classification), ['missing-owner-and-lease']);
  assert.equal(ctx.database.prepare('SELECT ingest_status FROM movies WHERE id=2').get().ingest_status, 'transferring');
  ctx.database.prepare("UPDATE movies SET transfer_token='expired-token', transfer_lease_until=? WHERE id=2").run(now - 1);
  const expired = await diagnoseStaleTransfers(ctx, { now });
  assert.equal(expired[0].classification, 'expired-lease');
  assert.equal(expired[0].recommended_transition, 'retry_pending');
  const recovered = await claimTransfer(ctx, { id: 2, quality: '1080p', token: '1080p:recovered-123456', leaseSeconds: 3600, now });
  assert.equal(recovered.claimed, true);
});

test('owned transfer release clears ownership and never leaves transferring without a lease', async () => {
  const ctx = makeContext();
  const claim = await claimTransfer(ctx, { id: 2, quality: '1080p', token: '1080p:attempt-c-123456', leaseSeconds: 3600, now: 2_000_000_000 });
  assert.equal(claim.claimed, true);
  assert.equal(await releaseTransfer(ctx, { id: 2, token: claim.token, nextState: 'retry_pending', error: 'test failure' }), true);
  const row = ctx.database.prepare('SELECT ingest_status, transfer_token, transfer_lease_until FROM movies WHERE id=2').get();
  assert.equal(row.ingest_status, 'retry_pending');
  assert.equal(row.transfer_token, null);
  assert.equal(row.transfer_lease_until, null);
});
test('only r2-sync remains a normal production media mutation path', () => {
  const canonical = readFileSync('.github/workflows/r2-sync.yml', 'utf8');
  const legacy = parse(readFileSync('.github/workflows/magnet-to-r2.yml', 'utf8'));
  const preparation = readFileSync('scripts/prepare-cloud-media.mjs', 'utf8');
  assert.doesNotMatch(canonical, /--force-commit/);
  assert.equal(legacy.jobs.transfer.if, false);
  assert.doesNotMatch(preparation, /resetTransferLocks/);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryMp4, sourceMagnet, transferLimits, hasDiskBudget, uploadStream } from '../scripts/magnet-to-r2.mjs';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { guardedSource } from '../scripts/webtorrent-guard.mjs';
import { runChild } from '../scripts/transfer-process.mjs';
import { compileFunction } from 'node:vm';

test('peer requests before storage initialization and after destruction fail safely', () => {
  const original = '      if (this.pieces[index]) return\n      this.store.get(index, { offset, length }, cb)';
  const patched = guardedSource(original);
  assert.equal(guardedSource(patched), patched, 'patch is idempotent');
  assert.throws(() => guardedSource('changed upstream code'), /changed/);
  const handler = compileFunction(patched, ['wire', 'index', 'offset', 'length', 'cb']);
  let destroyed = 0, reads = 0;
  const wire = { destroy() { destroyed++; } };
  for (const state of [{ destroyed: true, ready: true }, { destroyed: false, ready: false }, { destroyed: false, ready: true, store: null }]) {
    assert.doesNotThrow(() => handler.call(state, wire, 0, 0, 10, () => {}));
  }
  assert.equal(destroyed, 3);
  handler.call({ destroyed: false, ready: true, pieces: [], store: { get() { reads++; } } }, wire, 0, 0, 10, () => {});
  assert.equal(reads, 1);
});

test('lifecycle guard matches the locked dependency request handler', () => {
  const source = readFileSync('node_modules/webtorrent/lib/torrent.js', 'utf8');
  const patched = guardedSource(source);
  assert.equal(guardedSource(patched), patched);
  assert.match(patched, /if \(this.destroyed \|\| !this.ready \|\| !this.store\) return wire.destroy\(\)/);
});

test('an isolated process crash does not prevent the next film from running', async () => {
  const failed = await runChild(['-e', 'process.exit(7)'], { timeoutMs: 5000 });
  assert.equal(failed.code, 7);
  const next = await runChild(['-e', 'process.exit(0)'], { timeoutMs: 5000 });
  assert.equal(next.code, 0);
});

test('a hung child is terminated within its independent deadline', async () => {
  const result = await runChild(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300, graceMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('torrent async stream becomes an AWS-compatible binary Node stream', async () => {
  const source = (async function* () { yield Buffer.from('video'); yield Buffer.from('-bytes'); })();
  const stream = uploadStream(source);
  assert.ok(stream instanceof Readable);
  assert.equal(stream.readableObjectMode, false);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'video-bytes');
});

test('selects largest MP4 and ignores samples, trailers and other containers', () => {
  assert.equal(primaryMp4([
    { name: 'sample.mp4', length: 900 }, { name: 'film.mkv', length: 1000 },
    { name: 'Film.MP4', length: 800 }, { name: 'film-trailer.mp4', length: 850 },
  ]).name, 'Film.MP4');
  assert.equal(primaryMp4([{ name: 'film.mkv', length: 1 }]), undefined);
});
test('normalizes magnets and strips arbitrary web seeds', () => {
  const hash = 'a'.repeat(40);
  assert.equal(sourceMagnet(JSON.stringify({ sources: [{ url: `magnet:?xt=urn:btih:${hash}&ws=http://localhost/secret` }] })), `magnet:?xt=urn:btih:${hash}`);
  assert.equal(sourceMagnet('{invalid'), null);
  assert.equal(sourceMagnet('[{"url":"https://localhost/a.torrent"}]'), null);
});

test('transfer bounds reject invalid or unbounded configurations', () => {
  const limits = transferLimits({ TRANSFER_BATCH_SIZE: '3', TRANSFER_TIMEOUT_SECONDS: '2400' });
  assert.equal(limits.batch, 3);
  assert.equal(limits.timeout, 2400);
  for (const value of ['0', '-1', '21', 'NaN', '1.5']) {
    assert.throws(() => transferLimits({ TRANSFER_BATCH_SIZE: value }), /Invalid/);
  }
  assert.throws(() => transferLimits({ TRANSFER_MAX_BYTES: 'Infinity' }), /Invalid/);
});

test('disk budgeting reserves space and rejects oversized torrents', () => {
  const limits = { maxBytes: 400, reserve: 100 };
  assert.equal(hasDiskBudget(400, 500, limits), true);
  assert.equal(hasDiskBudget(400, 499, limits), false);
  assert.equal(hasDiskBudget(401, 900, limits), false);
  assert.equal(hasDiskBudget(0, 900, limits), false);
});

test('workflow uses trusted triggers, pinned actions, scoped secrets and finite limits', () => {
  const workflow = parse(readFileSync('.github/workflows/magnet-to-r2.yml', 'utf8'));
  assert.deepEqual(workflow.on.repository_dispatch.types, ['magnet-to-r2']);
  assert.ok('workflow_dispatch' in workflow.on);
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.transfer;
  assert.equal(job['timeout-minutes'], 180);
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const step = job.steps.find(step => step.env?.R2_ACCESS_KEY_ID);
  assert.equal(step.env.R2_ACCOUNT_ID, '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  assert.equal(step.env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
  const limits = transferLimits(step.env);
  assert.equal(limits.batch, 20);
  assert.ok(limits.timeout + 300 < limits.run);
  assert.ok(limits.run < step['timeout-minutes'] * 60);
  assert.doesNotMatch(step.run, /--watch|client_payload/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableKey, makePlan, commitItem, prepareAll, markPermanentlyFailed } from './prepare-cloud-media.mjs';
import { verifyPlan } from './verify-cloud-media.mjs';

test('stable keys survive runner restarts and distinguish qualities', () => {
  assert.equal(stableKey(12,'720p'), stableKey(12,'720p'));
  assert.notEqual(stableKey(12,'720p'), stableKey(12,'1080p'));
  assert.throws(() => stableKey('12','720p'));
});
test('planning keeps mapped legacy objects and detects missing quality', async () => {
  const legacy = 'assets/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/data.bin';
  const plan = await makePlan({ query: async () => [{ id: 12, download_sources_json: JSON.stringify({ sources: [{ quality: '720p', url: 'https://yts.gg/torrent/720' }, { quality: '1080p', r2StorageKey: legacy }] }) }],
    head: async key => key === legacy ? { ContentLength: 123, ContentType: 'video/mp4' } : null });
  assert.equal(plan.files[0].verified, false);
  assert.equal(plan.files[1].key, legacy);
  assert.equal(plan.files[1].verified, true);
});
test('D1 ready requires both verified qualities and uses a revision guard', async () => {
  const item = { id: 12, quality: '720p', key: stableKey(12,'720p'), bytes: 123 };
  for (const complete of [false,true]) {
    let update;
    const ctx = { head: async key => key && (complete || key === item.key) ? { ContentLength: 123, ContentType: 'video/mp4' } : null,
      query: async (sql, params) => {
        if (sql.startsWith('SELECT')) return [{ revision: 4, ingest_status: 'transferring', transfer_token: '720p:attempt-123456', download_sources_json: JSON.stringify({ sources: [{ quality:'1080p',r2StorageKey:stableKey(12,'1080p'),r2Bytes:123 }] }) }];
        update = { sql, params }; return [{id:12}];
      } };
    const token = '720p:attempt-123456';
    await commitItem(ctx,item,{ transferToken: token });
    assert.equal(update.params[3], complete ? 'ready' : 'half');
    assert.match(update.sql, /AND revision=\?/);
    assert.doesNotMatch(update.sql.split('WHERE')[0], /publication_status/);
  }
});
test('manifest accepts completed snapshots but rejects missing or corrupt staged files', async () => {
  const root = await mkdtemp(join(tmpdir(),'cloud-media-test-'));
  try {
    const item = { id:1,quality:'720p',key:stableKey(1,'720p'),bytes:12,verified:true,file:null };
    const plan = { schema:'flixlyra-cloud-v1',files:[item] };
    assert.equal((await verifyPlan(plan,root)).verified,1);
    item.verified=false;
    await assert.rejects(verifyPlan(plan,root),/staged video/);
    item.file=join(root,'720p.mp4');
    await writeFile(item.file,Buffer.from('0000ftyp0000'));
    assert.equal((await verifyPlan(plan,root)).staged,1);
    await writeFile(item.file,Buffer.alloc(12));
    await assert.rejects(verifyPlan(plan,root),/Invalid staged MP4/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('two-pass preparation retries queued movies after the primary batch', async () => {
  const root = await mkdtemp(join(tmpdir(),'cloud-media-prepare-test-'));
  const plan = { schema:'flixlyra-cloud-v1', files: [
    { id:14, quality:'720p', key:stableKey(14,'720p'), bytes:null, file:null, verified:false },
    { id:15, quality:'720p', key:stableKey(15,'720p'), bytes:null, file:null, verified:false },
  ] };
  const attempts = new Map();
  const saved = [];
  const warnings = [];
  const logs = [];
  const errors = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalError = console.error;
  console.warn = message => warnings.push(String(message));
  console.log = message => logs.push(String(message));
  console.error = message => errors.push(String(message));
  try {
    const result = await prepareAll({}, plan, {
      acquire: async (_ctx, item, attempt) => {
        attempts.set(item.id, [...(attempts.get(item.id) || []), attempt]);
        if (item.id === 14 && attempt < 4) throw new Error('dead stream');
        item.file = join(root, `${item.id}.mp4`);
        item.bytes = 12;
        await writeFile(item.file, Buffer.from('0000ftyp0000'));
      },
      pause: async () => {},
      saveManifest: async snapshot => saved.push(structuredClone(snapshot)),
    });
    assert.deepEqual(result, { prepared:2, skipped:0, permanentlyFailedIds:[], markedFailed:0 });
    assert.deepEqual(attempts.get(14), [1,2,3,4]);
    assert.deepEqual(attempts.get(15), [1]);
    assert.equal(plan.files[0].skipped, undefined);
    assert.equal(plan.files[0].file, join(root, '14.mp4'));
    assert.equal(plan.files[1].skipped, undefined);
    assert.equal(plan.files[1].file, join(root, '15.mp4'));
    assert.ok(saved.some(snapshot => snapshot.files[1].file === join(root, '15.mp4')));
    assert.ok(logs.includes('Starting Second-Chance Retry Pass for 1 skipped movies...'));
    assert.ok(errors.length === 0);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    console.error = originalError;
    await rm(root,{recursive:true,force:true});
  }
});

test('two-pass preparation permanently skips a movie after the final retry', async () => {
  const root = await mkdtemp(join(tmpdir(),'cloud-media-permanent-skip-test-'));
  const plan = { schema:'flixlyra-cloud-v1', files: [{
    id:14, quality:'720p', key:stableKey(14,'720p'), bytes:null, file:null, verified:false,
  }] };
  const attempts = [];
  const warnings = [];
  const logs = [];
  const errors = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalError = console.error;
  console.warn = message => warnings.push(String(message));
  console.log = message => logs.push(String(message));
  console.error = message => errors.push(String(message));
  try {
    const result = await prepareAll({ query: async (sql) => sql.startsWith('SELECT') ? [{ ingest_status: 'queued', transfer_lease_until: null }] : [{ id: 14 }] }, plan, {
      acquire: async (_ctx, _item, attempt) => { attempts.push(attempt); throw new Error('dead stream'); },
      pause: async () => {},
      saveManifest: async () => {},
    });
    assert.deepEqual(result, { prepared:0, skipped:1, permanentlyFailedIds:[14], markedFailed:1 });
    assert.deepEqual(attempts, [1,2,3,4]);
    assert.ok(warnings.some(message => message.includes('Pass 1 failed for Movie 14')));
    assert.ok(logs.includes('Starting Second-Chance Retry Pass for 1 skipped movies...'));
    assert.ok(errors.some(message => message.includes('movie-preparation-permanently-skipped') && message.includes('14')));
    assert.equal(plan.files[0].skipped, true);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    console.error = originalError;
    await rm(root,{recursive:true,force:true});
  }
});

test('permanent D1 failure marking uses the guarded repository schema and survives a DB glitch', async () => {
  const calls = [];
  const marked = await markPermanentlyFailed({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT')) return [{ ingest_status: 'queued', transfer_lease_until: null }];
      return [{ id: 14 }];
    },
  }, [14,14]);
  assert.equal(marked, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /SELECT ingest_status/);
  assert.match(calls[1].sql, /ingest_status = \?/);

  const unavailable = await markPermanentlyFailed({ query: async () => { throw new Error('network glitch'); } }, [15]);
  assert.equal(unavailable, 0);
});

test('permanent failure preserves a successfully prepared quality as a half-ready record', async () => {
  const calls = [];
  const plan = { files: [
    { id: 16, quality: '720p', verified: true, file: null },
    { id: 16, quality: '1080p', verified: false, file: null },
  ] };
  const marked = await markPermanentlyFailed({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT')) return [{ ingest_status: 'queued', transfer_lease_until: null }];
      return [{ id: 16 }];
    },
  }, [16], plan);
  assert.equal(marked, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /SELECT ingest_status/);
  assert.match(calls[1].sql, /ingest_status = \?/);
  assert.deepEqual(calls[1].params.slice(0, 2), ['skipped_unplayable', 'Missing 1080p: Dead stream / 404']);
});

test('verification accepts a manifest containing only skipped pending movies', async () => {
  const root = await mkdtemp(join(tmpdir(),'cloud-media-skipped-test-'));
  try {
    const plan = { schema:'flixlyra-cloud-v1', files: [{
      id:14, quality:'720p', key:stableKey(14,'720p'), bytes:null, file:null, verified:false, skipped:true,
    }] };
    assert.deepEqual(await verifyPlan(plan,root), { total:1, staged:0, verified:0, skipped:1 });
  } finally { await rm(root,{recursive:true,force:true}); }
});

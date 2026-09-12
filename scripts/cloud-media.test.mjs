import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableKey, makePlan, commitItem, prepareAll } from './prepare-cloud-media.mjs';
import { verifyPlan } from './verify-cloud-media.mjs';

test('stable keys survive runner restarts and distinguish qualities', () => {
  assert.equal(stableKey(12,'720p'), stableKey(12,'720p'));
  assert.notEqual(stableKey(12,'720p'), stableKey(12,'1080p'));
  assert.throws(() => stableKey('12','720p'));
});
test('planning keeps mapped legacy objects and detects missing quality', async () => {
  const legacy = 'assets/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/data.bin';
  const plan = await makePlan({ query: async () => [{ id: 12, download_sources_json: JSON.stringify({ sources: [{ quality: '1080p', r2StorageKey: legacy }] }) }],
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
        if (sql.startsWith('SELECT')) return [{ revision: 4, download_sources_json: JSON.stringify({ sources: [{ quality:'1080p',r2StorageKey:stableKey(12,'1080p'),r2Bytes:123 }] }) }];
        update = { sql, params }; return [{id:12}];
      } };
    await commitItem(ctx,item);
    assert.equal(update.params[3], complete ? 'ready' : 'processing');
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

test('preparation skips a failed movie and continues with later movies', async () => {
  const root = await mkdtemp(join(tmpdir(),'cloud-media-prepare-test-'));
  const plan = { schema:'flixlyra-cloud-v1', files: [
    { id:14, quality:'720p', key:stableKey(14,'720p'), bytes:null, file:null, verified:false },
    { id:15, quality:'720p', key:stableKey(15,'720p'), bytes:null, file:null, verified:false },
  ] };
  const attempts = new Map();
  const saved = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const result = await prepareAll({}, plan, {
      acquire: async (_ctx, item) => {
        attempts.set(item.id, (attempts.get(item.id) || 0) + 1);
        if (item.id === 14) throw new Error('dead stream');
        item.file = join(root, `${item.id}.mp4`);
        item.bytes = 12;
        await writeFile(item.file, Buffer.from('0000ftyp0000'));
      },
      saveManifest: async snapshot => saved.push(structuredClone(snapshot)),
    });
    assert.deepEqual(result, { prepared:1, skipped:1 });
    assert.equal(attempts.get(14), 3);
    assert.equal(attempts.get(15), 1);
    assert.equal(plan.files[0].skipped, true);
    assert.equal(plan.files[0].file, null);
    assert.equal(plan.files[1].skipped, undefined);
    assert.equal(plan.files[1].file, join(root, '15.mp4'));
    assert.ok(saved.some(snapshot => snapshot.files[1].file === join(root, '15.mp4')));
    assert.ok(warnings.includes('⚠️ Warning: Skipping Movie 14 due to download failure'));
  } finally {
    console.warn = originalWarn;
    await rm(root,{recursive:true,force:true});
  }
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableKey, makePlan, commitItem } from './prepare-cloud-media.mjs';
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

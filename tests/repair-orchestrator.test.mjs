import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { idsFrom, parseSources, sourceFor, validVideo } from '../scripts/repair-draft-media.mjs';
import { idsFrom as auditIdsFrom } from '../scripts/targeted-media-audit.mjs';

test('repair scope is explicit and unique', () => {
  assert.deepEqual(idsFrom('52,51,52'), [52, 51]);
  assert.throws(() => idsFrom('52,all'), /INVALID/);
});

test('quality mapping supports current wrapped source data', () => {
  const sources = parseSources(JSON.stringify({ sources: [{ quality: '720p', r2StorageKey: 'assets/x/720p.mp4', r2Bytes: 10 }] }));
  assert.equal(sourceFor(sources, '720p').r2StorageKey, 'assets/x/720p.mp4');
});

test('verified media requires matching positive video bytes', () => {
  assert.equal(validVideo({ ContentLength: 10, ContentType: 'video/mp4' }, 10), true);
  assert.equal(validVideo({ ContentLength: 9, ContentType: 'video/mp4' }, 10), false);
  assert.equal(validVideo({ ContentLength: 10, ContentType: 'image/jpeg' }, 10), false);
});

test('targeted audit rejects empty scope', () => {
  assert.deepEqual(auditIdsFrom('53,53'), [53]);
  assert.throws(() => auditIdsFrom(''), /REQUIRED/);
});

test('targeted repair workflow uses scoped validation instead of the global audit', () => {
  const workflow = readFileSync(new URL('../.github/workflows/r2-sync.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Run targeted post-repair audit/);
  assert.match(workflow, /if: inputs\.dispatch_mode == 'targeted'/);
  assert.match(workflow, /if: inputs\.dispatch_mode != 'targeted'/);
  assert.match(workflow, /repair_drafts/);
});

test('full audit no longer fails only because catalogue size changed', () => {
  const audit = readFileSync(new URL('../scripts/full-system-audit.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(audit, /expectedMovies:\s*30/);
  assert.match(audit, /if \(failures\.length\) process\.exitCode = 1/);
});

test('normal Studio ingestion dispatches the saved movie IDs to the canonical workflow', () => {
  const route = readFileSync(new URL('../app/api/admin/ingest/yts/route.ts', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/r2-sync.yml', import.meta.url), 'utf8');
  assert.match(route, /movie_ids: movieIds\.join\(','\)/);
  assert.match(route, /dispatch_mode: 'targeted'/);
  assert.match(workflow, /Fetch artwork and cast for targeted ingest/);
  assert.match(workflow, /Run Continuous Smart R2 Sync/);
});

test('normal Studio copy exposes one ingestion action without recovery controls', () => {
  const studio = readFileSync(new URL('../components/admin/movie-studio.tsx', import.meta.url), 'utf8');
  assert.match(studio, /Ingest Movies/);
  assert.match(studio, /metadata, artwork, cast, and available 720p\/1080p media automatically/);
  assert.doesNotMatch(studio, /repair_drafts|purge_orphans|artwork_only/);
});

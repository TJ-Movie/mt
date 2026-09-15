import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { buildTargetedWorkflowInputs, serializeWorkflowDispatchBody } from '../lib/github-dispatch.ts';
import { selectRowsForMovieIds, validateDispatchScope } from '../scripts/prepare-cloud-media.mjs';

test('single targeted dispatch serializes the exact GitHub workflow body', () => {
  const inputs = buildTargetedWorkflowInputs([53], { movie_ids: '53' });
  assert.deepEqual(JSON.parse(serializeWorkflowDispatchBody('main', inputs)), {
    ref: 'main',
    inputs: { movie_ids: '53', dispatch_mode: 'targeted' },
  });
});

test('multiple targeted IDs serialize as a canonical comma-separated string', () => {
  const inputs = buildTargetedWorkflowInputs([53, 48], { movie_ids: '53,48' });
  assert.equal(inputs.movie_ids, '53,48');
  assert.equal(inputs.dispatch_mode, 'targeted');
});

test('targeted dispatch with missing or mismatched IDs fails closed', () => {
  assert.throws(() => buildTargetedWorkflowInputs([53], {}), /GITHUB_DISPATCH_MOVIE_IDS_REQUIRED/);
  assert.throws(() => buildTargetedWorkflowInputs([53], { movie_ids: '48' }), /GITHUB_DISPATCH_MOVIE_IDS_MISMATCH/);
});

test('targeted preparation rejects an empty scope before selection', () => {
  assert.throws(() => validateDispatchScope('targeted', new Set()), /TARGETED_DISPATCH_MOVIE_IDS_REQUIRED/);
  assert.throws(() => validateDispatchScope('targeted', new Set([53]), '53,bad'), /TARGETED_DISPATCH_MOVIE_IDS_INVALID/);
});

test('targeted preparation selects only requested movies', () => {
  const rows = [{ id: 48 }, { id: 53 }];
  assert.deepEqual(selectRowsForMovieIds(rows, [53]).map((row) => row.id), [53]);
});

test('canonical workflow exposes targeted mode and passes the scope to preparation', () => {
  const source = readFileSync('.github/workflows/r2-sync.yml', 'utf8');
  const workflow = parse(source);
  assert.equal(workflow.on.workflow_dispatch.inputs.dispatch_mode.default, 'queue');
  assert.match(source, /TRANSFER_DISPATCH_MODE: \$\{\{ inputs\.dispatch_mode \}\}/);
  assert.match(source, /Validate targeted dispatch scope/);
});
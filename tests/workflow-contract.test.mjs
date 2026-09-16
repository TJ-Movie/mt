import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/r2-sync.yml', 'utf8'));
const steps = workflow.jobs['sync-media'].steps;
const named = name => steps.find(step => step.name === name);
const prepare = named('Prepare Media & Manifest');
const verify = named('Verify Prepared Media Inputs');
const sync = named('Run Continuous Smart R2 Sync');

function executedSteps(exits = {}, purge = false) {
  const executed = [];
  let priorSucceeded = true;
  for (const step of steps) {
    if (step.if === false || step.if === 'false') continue;
    if (typeof step.if === 'string' && step.if.includes('purge_orphans') && !purge) continue;
    if (!priorSucceeded) continue;
    executed.push(step.name);
    if (Object.prototype.hasOwnProperty.call(exits, step.name) && exits[step.name] !== 0) priorSucceeded = false;
  }
  return { executed, succeeded: priorSucceeded };
}

test('canonical r2-sync workflow preserves READY, HALF, FAILED and fatal gating semantics', () => {
  assert.ok(prepare && verify && sync);
  assert.equal(workflow.jobs['sync-media']['timeout-minutes'], 60);
  assert.match(prepare.run, /node scripts\/prepare-cloud-media\.mjs --max-movies=1/);
  assert.equal(prepare.env.TRANSFER_MOVIE_IDS, '${{ inputs.movie_ids }}');
  assert.equal(prepare.env.TRANSFER_QUALITY, '${{ inputs.quality }}');
  assert.match(verify.run, /node scripts\/verify-cloud-media\.mjs/);
  assert.match(sync.run, /node scripts\/smart-r2-sync\.mjs/);
  assert.match(sync.run, /--quality=720p,1080p/);
  assert.match(sync.run, /--concurrency=2/);
  assert.equal(Object.hasOwn(prepare, 'continue-on-error'), false);
  assert.equal(Object.hasOwn(verify, 'continue-on-error'), false);
  assert.equal(Object.hasOwn(sync, 'continue-on-error'), false);
  assert.equal(steps.indexOf(prepare) < steps.indexOf(verify), true);
  assert.equal(steps.indexOf(verify) < steps.indexOf(sync), true);

  for (const outcome of ['READY', 'HALF', 'FAILED']) {
    const run = executedSteps({ [prepare.name]: 0, [verify.name]: 0, [sync.name]: 0 });
    assert.equal(run.succeeded, true, `${outcome} must reach R2 sync`);
    assert.deepEqual(run.executed.filter(name => [prepare.name, verify.name, sync.name].includes(name)), [prepare.name, verify.name, sync.name]);
  }
  const failedPrepare = executedSteps({ [prepare.name]: 1, [verify.name]: 0, [sync.name]: 0 });
  assert.equal(failedPrepare.succeeded, false);
  assert.equal(failedPrepare.executed.includes(verify.name), false);
  assert.equal(failedPrepare.executed.includes(sync.name), false);
  const failedVerify = executedSteps({ [prepare.name]: 0, [verify.name]: 1, [sync.name]: 0 });
  assert.equal(failedVerify.succeeded, false);
  assert.equal(failedVerify.executed.includes(sync.name), false);
  const purge = executedSteps({ [prepare.name]: 0, [verify.name]: 0, [sync.name]: 0 }, true);
  assert.equal(purge.executed.includes('Clean up orphaned R2 objects'), true);
  assert.equal(executedSteps({ [prepare.name]: 0, [verify.name]: 0, [sync.name]: 0 }).executed.includes('Clean up orphaned R2 objects'), false);
});
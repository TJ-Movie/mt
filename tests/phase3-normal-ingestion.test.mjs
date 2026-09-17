import test from 'node:test';
import assert from 'node:assert/strict';
import { drainCloudPlan, prepareAll, stableKey, MEDIA_CONCURRENCY } from '../scripts/prepare-cloud-media.mjs';

const VIDEO_BYTES = 12;

function item(id, quality, verified = false) {
  return { id, quality, key: stableKey(id, quality), bytes: verified ? VIDEO_BYTES : null, file: null, verified, imdbId: 'tt1234567' };
}
function dbHarness() {
  const state = new Map();
  const sources = new Map();
  const tokens = new Map();
  const updates = [];
  const ctx = {
    s3: { destroy() {} },
    head: async key => key ? { ContentLength: VIDEO_BYTES, ContentType: 'video/mp4' } : null,
    query: async (sql, params = []) => {
      if (sql.startsWith('UPDATE movies SET ingest_status = \'transferring\'')) {
        const movieId = Number(params[2]);
        const currentState = state.get(movieId) || 'queued';
        const currentToken = tokens.get(movieId) || null;
        const claimable = ['queued', 'processing', 'retry_pending', 'half', 'flagged_for_review', 'ready'].includes(currentState) && !currentToken;
        if (!claimable) return [];
        state.set(movieId, 'transferring');
        tokens.set(movieId, params[0]);
        updates.push({ kind: 'claim', id: movieId });
        return [{ id: movieId }];
      }
      if (sql.startsWith('SELECT download_sources_json, revision')) {
        const movieId = Number(params[0]);
        return [{ revision: 1, ingest_status: state.get(movieId) || 'queued', transfer_token: tokens.get(movieId) || null, download_sources_json: JSON.stringify({ sources: sources.get(movieId) || [] }) }];
      }
      if (sql.startsWith('SELECT download_sources_json')) {
        const movieId = Number(params[0]);
        return [{ download_sources_json: JSON.stringify({ sources: sources.get(movieId) || [] }) }];
      }
      if (sql.includes('SET download_sources_json=')) {
        const movieId = Number(params.at(-3));
        const parsed = JSON.parse(params[0]);
        sources.set(movieId, parsed.sources);
        state.set(movieId, params[3]);
        tokens.delete(movieId);
        updates.push({ kind: 'commit', id: movieId, state: params[3] });
        return [{ id: movieId }];
      }
      if (sql.startsWith('SELECT ingest_status')) {
        const movieId = Number(params[0]);
        return [{ ingest_status: state.get(movieId) || 'queued', transfer_lease_until: null }];
      }
      if (sql.startsWith('SELECT id, slug, ingest_status')) return [];
      if (sql.startsWith('UPDATE movies SET ingest_status = ?')) {
        const movieId = Number(params[params.length === 4 ? 2 : 3]);
        state.set(movieId, params[0]);
        tokens.delete(movieId);
        updates.push({ kind: params.length === 4 ? 'release' : 'final-state', id: movieId, state: params[0] });
        return [{ id: movieId }];
      }
      return [];
    },
  };
  return { ctx, state, sources, tokens, updates };
}
function optionsFor(modes, events = [], acquireDelayMs = 0) {
  return {
    pause: async () => {},
    saveManifest: async () => {},
    prepareOptions: {
      acquire: async (_ctx, current) => {
        events.push(current.quality);
        const delay = typeof acquireDelayMs === 'function' ? acquireDelayMs(current) : acquireDelayMs;
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        const mode = modes[current.quality] || 'success';
        if (mode !== 'success') throw Object.assign(new Error(mode), { code: mode });
        current.bytes = VIDEO_BYTES;
        current.file = null;
      },
    },
  };
}
async function runMovie(modes, extra = {}) {
  const db = dbHarness();
  const events = [];
  const plan = { files: [item(100, '720p'), item(100, '1080p')], failures: [] };
  const enrichment = [];
  await drainCloudPlan(plan, async () => {}, { context: db.ctx, pause: async () => {}, saveManifest: async () => {}, movieTimeBudgetMs: extra.movieTimeBudgetMs, ...optionsFor(modes, events, extra.acquireDelayMs || 0), enrich: async (_ctx, id) => {
    enrichment.push(id);
    if (extra.enrichmentError) throw new Error('provider unavailable');
  } });
  return { plan, db, events, enrichment };
}

test('both qualities verified then enrichment runs and media is READY', async () => {
  const result = await runMovie({ '720p': 'success', '1080p': 'success' });
  assert.equal(result.plan.files.filter(x => x.verified).length, 2);
  assert.deepEqual(result.db.updates.filter(x => x.kind === 'commit').map(x => x.state), ['half', 'ready']);
  assert.deepEqual(result.enrichment, [100]);
});

test('sequential quality acquisition completes under one bounded outer preparation budget', async () => {
  const qualityWorkMs = 75;
  const outerBudgetMs = qualityWorkMs * 2 + 1_000;
  let timer;
  const result = await Promise.race([
    runMovie({ '720p': 'success', '1080p': 'success' }, { acquireDelayMs: qualityWorkMs }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('synthetic outer preparation budget expired')), outerBudgetMs); }),
  ]);
  clearTimeout(timer);
  assert.deepEqual(result.events, ['720p', '1080p']);
  assert.deepEqual(result.db.updates.filter(x => x.kind === 'commit').map(x => x.state), ['half', 'ready']);
  assert.deepEqual(result.enrichment, [100]);
});

test('movie deadline preserves a durable 720p quality when 1080p times out', async () => {
  const result = await runMovie({ '720p': 'success', '1080p': 'success' }, {
    movieTimeBudgetMs: 25,
    acquireDelayMs: current => current.quality === '1080p' ? 100 : 0,
  });
  assert.equal(result.plan.files[0].verified, true);
  assert.equal(result.plan.files[1].skipped, true);
  assert.equal(result.plan.files[1].failureCode, 'MOVIE_TIME_BUDGET_EXCEEDED');
  assert.equal(result.db.state.get(100), 'half');
  assert.equal(result.db.tokens.size, 0);
});

test('a timed-out movie releases its worker so the next movie and sibling worker continue', async () => {
  const db = dbHarness();
  const plan = { files: [200, 201, 202].flatMap(id => [item(id, '720p'), item(id, '1080p')]), failures: [] };
  let active = 0;
  let maximum = 0;
  await drainCloudPlan(plan, async () => {}, {
    context: db.ctx,
    pause: async () => {},
    saveManifest: async () => {},
    movieTimeBudgetMs: 25,
    prepareOptions: {
      acquire: async (_ctx, current) => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (current.id === 200 && current.quality === '720p') await new Promise(resolve => setTimeout(resolve, 100));
        active -= 1;
        current.bytes = VIDEO_BYTES;
      },
    },
  });
  assert.equal(maximum, MEDIA_CONCURRENCY);
  assert.equal(plan.files.filter(file => file.id === 202 && file.verified).length, 2);
  assert.equal(db.tokens.size, 0);
});

test('720p failure is isolated and 1080p continues to HALF and enrichment', async () => {
  const result = await runMovie({ '720p': 'ZERO_BYTE_STALL', '1080p': 'success' });
  assert.equal(result.plan.files[0].skipped, true);
  assert.equal(result.plan.files[0].failureCode, 'ZERO_BYTE_STALL');
  assert.equal(result.plan.files[1].verified, true);
  assert.deepEqual(result.enrichment, [100]);
});

test('1080p failure preserves verified 720p and still enriches HALF', async () => {
  const result = await runMovie({ '720p': 'success', '1080p': 'SOURCE_INVALID' });
  assert.equal(result.plan.files[0].verified, true);
  assert.equal(result.plan.files[1].skipped, true);
  assert.deepEqual(result.enrichment, [100]);
});

test('both quality failures finish FAILED without enrichment', async () => {
  const result = await runMovie({ '720p': 'NO_PEERS', '1080p': 'ZERO_BYTE_STALL' });
  assert.equal(result.plan.files.every(x => x.skipped), true);
  assert.deepEqual(result.enrichment, []);
  assert.equal(result.db.updates.some(x => x.kind === 'commit'), false);
});

test('enrichment failure preserves READY media', async () => {
  const result = await runMovie({ '720p': 'success', '1080p': 'success' }, { enrichmentError: true });
  assert.equal(result.plan.files.every(x => x.verified), true);
  assert.deepEqual(result.enrichment, [100]);
  assert.equal(result.db.updates.at(-1).state, 'ready');
});

test('enrichment failure preserves HALF media', async () => {
  const result = await runMovie({ '720p': 'success', '1080p': 'SOURCE_INVALID' }, { enrichmentError: true });
  assert.equal(result.plan.files[0].verified, true);
  assert.equal(result.plan.files[1].skipped, true);
  assert.deepEqual(result.enrichment, [100]);
  assert.ok(result.db.updates.some(update => update.kind === 'commit' && update.state === 'half'));
});
test('enrichment-only retry does not call media acquisition', async () => {
  const db = dbHarness();
  const plan = { files: [item(101, '720p', true), item(101, '1080p', true)], failures: [] };
  let acquired = 0;
  let enriched = 0;
  await drainCloudPlan(plan, async () => { acquired += 1; }, { context: db.ctx, pause: async () => {}, saveManifest: async () => {}, enrich: async () => { enriched += 1; } });
  assert.equal(acquired, 0);
  assert.equal(enriched, 1);
});

test('verified 720p is skipped when only 1080p is missing', async () => {
  const db = dbHarness();
  const plan = { files: [item(102, '720p', true), item(102, '1080p')], failures: [] };
  const acquired = [];
  await drainCloudPlan(plan, async () => {}, { context: db.ctx, pause: async () => {}, saveManifest: async () => {}, prepareOptions: { acquire: async (_ctx, current) => { acquired.push(current.quality); current.bytes = VIDEO_BYTES; } }, enrich: async () => {} });
  assert.deepEqual(acquired, ['1080p']);
});

test('prepareAll bounds 20 independent movie jobs to the configured pool', async () => {
  let active = 0;
  let maximum = 0;
  const seen = [];
  const plan = { files: Array.from({ length: 20 }, (_, index) => item(200 + index, '720p')), failures: [] };
  await prepareAll({ query: async () => [] }, plan, {
    pause: async () => {},
    saveManifest: async () => {},
    acquire: async (_ctx, current) => {
      active += 1;
      maximum = Math.max(maximum, active);
      seen.push(current.id);
      await new Promise(resolve => setTimeout(resolve, 3));
      current.bytes = VIDEO_BYTES;
      active -= 1;
    },
  });
  assert.equal(maximum, MEDIA_CONCURRENCY);
  assert.equal(new Set(seen).size, 20);
});

test('one stalled movie does not stop other batch jobs', async () => {
  const seen = [];
  const plan = { files: [item(300, '720p'), item(301, '720p'), item(302, '720p')], failures: [] };
  await prepareAll({ query: async () => [] }, plan, {
    pause: async () => {},
    saveManifest: async () => {},
    acquire: async (_ctx, current) => {
      seen.push(current.id);
      if (current.id === 300) throw Object.assign(new Error('dead'), { code: 'NO_PEERS' });
      current.bytes = VIDEO_BYTES;
    },
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [300, 301, 302]);
  assert.equal(plan.files[1].bytes, VIDEO_BYTES);
  assert.equal(plan.files[2].bytes, VIDEO_BYTES);
});

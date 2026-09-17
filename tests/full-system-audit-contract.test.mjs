import assert from 'node:assert/strict';
import test from 'node:test';
import { auditMovie } from '../scripts/full-system-audit.mjs';

const VIDEO_BYTES = 10 * 1024 * 1024;

function source(quality, verified = true, key = `videos/movie-${quality}.mp4`) {
  return {
    label: `Test ${quality}`,
    quality,
    resolution: quality,
    size: '10 MB',
    url: `magnet:?xt=urn:btih:${quality}`,
    ...(verified ? { r2StorageKey: key, r2Bytes: VIDEO_BYTES } : {}),
  };
}

function diagnostics() {
  return JSON.stringify({
    type: 'MEDIA_FAILURES',
    qualities: [
      { quality: '720p', failure_code: 'NO_PEERS', failure_stage: 'payload', payload_bytes: 0 },
      { quality: '1080p', failure_code: 'NO_PEERS', failure_stage: 'payload', payload_bytes: 0 },
    ],
  });
}

function row(overrides = {}) {
  const sources = overrides.sources || [source('720p'), source('1080p')];
  return {
    id: 54,
    slug: 'bikini-model-academy-2015',
    title: 'Bikini Model Academy',
    director: 'Test Director',
    cast_json: JSON.stringify([{ name: 'Test Actor', profile_url: 'https://image.tmdb.org/t/p/original/test.jpg' }]),
    poster: '/poster.jpg',
    backdrop: '/backdrop.jpg',
    official_watch_url: 'https://youtu.be/test',
    publication_status: 'draft',
    rights_status: 'pending',
    ingest_status: 'ready',
    transfer_token: null,
    transfer_lease_until: null,
    transfer_error: null,
    download_sources_json: JSON.stringify({ sources }),
    streaming_sources_json: '[]',
    ...overrides,
    ...(overrides.sources ? { download_sources_json: JSON.stringify({ sources }) } : {}),
  };
}

function checks(overrides = {}) {
  return {
    headR2Object: async () => ({ exists: true, contentLength: VIDEO_BYTES, contentType: 'video/mp4' }),
    auditImage: async () => ({ ok: true, status: 200, type: 'image/jpeg', bytes: 64 }),
    auditTrailer: async () => ({ ok: true, status: 200 }),
    auditVideo: async () => ({ ok: true, status: '206', url: 'https://flixlyra.test/signed' }),
    ...overrides,
  };
}

test('READY with 720p and 1080p verified mappings passes', async () => {
  const result = await auditMovie(row(), checks());
  assert.equal(result.Media_State, 'READY');
  assert.equal(result.Final_State, 'PASS');
});

test('READY with one missing mapping fails', async () => {
  const result = await auditMovie(row({ sources: [source('720p'), source('1080p', false)] }), checks());
  assert.equal(result.Final_State, 'FAIL');
  assert.ok(result.reasons.includes('ready_verified_quality_count_1'));
});

test('HALF with only 720p verified passes', async () => {
  const result = await auditMovie(row({ ingest_status: 'half', sources: [source('720p'), source('1080p', false)] }), checks());
  assert.equal(result.Media_State, 'HALF');
  assert.equal(result.Final_State, 'PASS');
});

test('HALF with only 1080p verified passes', async () => {
  const result = await auditMovie(row({ ingest_status: 'half', sources: [source('720p', false), source('1080p')] }), checks());
  assert.equal(result.Media_State, 'HALF');
  assert.equal(result.Final_State, 'PASS');
});

test('HALF with zero verified qualities fails', async () => {
  const result = await auditMovie(row({ ingest_status: 'half', sources: [source('720p', false), source('1080p', false)] }), checks());
  assert.equal(result.Final_State, 'FAIL');
  assert.ok(result.reasons.includes('half_verified_quality_count_0'));
});

test('both NO_PEERS with structured diagnostics is a valid FAILED result', async () => {
  const result = await auditMovie(row({ ingest_status: 'skipped_unplayable', sources: [source('720p', false), source('1080p', false)], transfer_error: diagnostics() }), checks());
  assert.equal(result.Media_State, 'FAILED');
  assert.equal(result.Final_State, 'PASS');
  assert.equal(result.Cast_Profile_Photos, 'NOT_EXPECTED');
  assert.equal(result.Download_Links, 'NOT_EXPECTED');
});

test('FAILED state claiming a verified mapping fails', async () => {
  const result = await auditMovie(row({ ingest_status: 'skipped_unplayable', sources: [source('720p'), source('1080p', false)], transfer_error: diagnostics() }), checks());
  assert.equal(result.Final_State, 'FAIL');
  assert.ok(result.reasons.includes('failed_state_claims_verified_media'));
});

test('Draft and Rights Pending do not require public links', async () => {
  const result = await auditMovie(row({ ingest_status: 'half', sources: [source('720p'), source('1080p', false)] }), checks({
    auditVideo: async () => { throw new Error('public link should not be checked'); },
  }));
  assert.equal(result.Final_State, 'PASS');
  assert.equal(result.Download_Links, 'NOT_EXPECTED');
});

test('published and rights-verified broken public media fails', async () => {
  const result = await auditMovie(row({ ingest_status: 'half', publication_status: 'published', rights_status: 'verified', sources: [source('720p'), source('1080p', false)] }), checks({
    auditVideo: async () => ({ ok: false, reason: '720p_http_404', status: '404', url: 'https://flixlyra.test/missing' }),
  }));
  assert.equal(result.Final_State, 'FAIL');
  assert.ok(result.reasons.includes('720p_http_404'));
});

test('verified mapping with a missing R2 object fails', async () => {
  const result = await auditMovie(row({ ingest_status: 'half', sources: [source('720p'), source('1080p', false)] }), checks({
    headR2Object: async () => ({ exists: false, reason: 'r2_object_missing' }),
  }));
  assert.equal(result.Final_State, 'FAIL');
  assert.ok(result.reasons.includes('720p_r2_object_missing'));
});

test('FAILED state with an active transfer lease fails', async () => {
  const result = await auditMovie(row({ ingest_status: 'skipped_unplayable', sources: [source('720p', false), source('1080p', false)], transfer_error: diagnostics(), transfer_token: 'stuck-token' }), checks());
  assert.equal(result.Final_State, 'FAIL');
  assert.ok(result.reasons.includes('active_transfer_lease_or_token'));
});

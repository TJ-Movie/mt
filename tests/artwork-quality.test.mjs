import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseBestArtworkCandidate, qualityFromDimensions } from '../lib/artwork-quality.mjs';

function candidate(provider, width, height, kind = 'backdrop') {
  return {
    provider,
    url: `https://${provider}.example/${kind}.jpg`,
    identityCorrect: true,
    quality: qualityFromDimensions(kind, width, height, 'image/jpeg', 1000),
  };
}

test('low-resolution YTS backdrop loses to a high-quality TMDB backdrop', () => {
  const selected = chooseBestArtworkCandidate('backdrop', [
    candidate('yts', 896, 375),
    candidate('tmdb', 3840, 2160),
  ]);
  assert.equal(selected.provider, 'tmdb');
});

test('high-quality YTS backdrop is preserved over a worse TMDB candidate', () => {
  const selected = chooseBestArtworkCandidate('backdrop', [
    candidate('yts', 3840, 2160),
    candidate('tmdb', 1920, 1080),
  ]);
  assert.equal(selected.provider, 'yts');
});

test('a good existing backdrop is never downgraded by a worse new candidate', () => {
  const existing = candidate('existing-r2', 3840, 2160);
  const selected = chooseBestArtworkCandidate('backdrop', [candidate('tmdb', 896, 375)], existing);
  assert.equal(selected.provider, 'existing-r2');
});

test('a poor existing backdrop can be replaced by a clearly superior trusted candidate', () => {
  const existing = candidate('existing-r2', 1280, 720);
  const selected = chooseBestArtworkCandidate('backdrop', [candidate('tmdb', 3840, 2160)], existing);
  assert.equal(selected.provider, 'tmdb');
});

test('invalid identity and non-landscape candidates are excluded', () => {
  const selected = chooseBestArtworkCandidate('backdrop', [
    { ...candidate('wrong-title', 3840, 2160), identityCorrect: false },
    candidate('poster-shaped', 1000, 1500),
    candidate('tmdb', 1920, 1080),
  ]);
  assert.equal(selected.provider, 'tmdb');
});
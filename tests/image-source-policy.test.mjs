import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedImageSource } from '../lib/image-source-policy.mjs';

test('accepts exact HTTPS yts.gg artwork host', () => {
  assert.equal(approvedImageSource('https://yts.gg/assets/poster.jpg'), 'https://yts.gg/assets/poster.jpg');
});


test('accepts the exact HTTPS img.yts.gg redirect host', () => {
  assert.equal(approvedImageSource('https://img.yts.gg/assets/poster.jpg'), 'https://img.yts.gg/assets/poster.jpg');
});
test('rejects unsafe yts.gg variants and transport details', () => {
  for (const value of [
    'http://yts.gg/poster.jpg',
    'https://evil-yts.gg/poster.jpg',
    'https://yts.gg.evil.example/poster.jpg',
    'https://user:pass@yts.gg/poster.jpg',
    'https://yts.gg:8443/poster.jpg',
    'https://127.0.0.1/poster.jpg',
  ]) assert.equal(approvedImageSource(value), null, value);
});

test('preserves existing approved artwork hosts and strict yts.gg scope', () => {
  assert.equal(approvedImageSource('https://image.tmdb.org/t/p/original/poster.jpg'), 'https://image.tmdb.org/t/p/original/poster.jpg');
  assert.equal(approvedImageSource('https://cdn.yts.mx/poster.jpg', { allowYtsSubdomains: true }), 'https://cdn.yts.mx/poster.jpg');
  assert.equal(approvedImageSource('https://cdn.yts.gg/poster.jpg', { allowYtsSubdomains: true }), null);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { approvedImageSource } from '../lib/image-source-policy.mjs';
import { auditMovie } from '../scripts/full-system-audit.mjs';
import { downloadArtwork, drainCloudPlan, syncArtworkForMovie } from '../scripts/prepare-cloud-media.mjs';

// Minimal JPEG header fixtures; artwork validation reads the encoded dimensions.
const IMAGE_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
const POSTER_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xee, 0x01, 0xf4, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
const VIDEO_BYTES = 10 * 1024 * 1024;

function imageResponse(type = 'image/jpeg', kind = 'backdrop') {
  const bytes = kind === 'poster' ? POSTER_BYTES : IMAGE_BYTES;
  return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.byteLength) } });
}
function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetch(handler, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => handler(new URL(typeof input === 'string' ? input : input.url), init);
  try {
    return await callback();
  } finally {
    globalThis.fetch = previous;
  }
}

async function withEnv(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function artworkContext(existing = false) {
  const objects = new Map();
  const uploads = [];
  const ctx = {
    bucket: 'test-media',
    s3: {
      destroy() {},
      async send(command) {
        const input = command.input;
        const body = input.Body instanceof Uint8Array ? input.Body : new Uint8Array(input.Body);
        objects.set(input.Key, { ContentLength: body.byteLength, ContentType: input.ContentType });
        uploads.push({ key: input.Key, bytes: body.byteLength, contentType: input.ContentType });
        return {};
      },
    },
    headArtwork: async (key) => existing ? { ContentLength: IMAGE_BYTES.byteLength, ContentType: 'image/jpeg' } : objects.get(key) || null,
    query: async () => [],
  };
  return { ctx, objects, uploads };
}

function artworkRow(overrides = {}) {
  return {
    id: 77,
    revision: 1,
    imdb_id: 'tt1234567',
    title: 'Artwork Fixture',
    description: 'Fixture description',
    release_year: 2020,
    runtime: '2h 0m',
    rating: 7.5,
    genre: 'Drama',
    director: 'Fixture Director',
    cast_json: JSON.stringify([{ actor: 'Fixture Actor', image: 'https://yts.gg/cast.jpg' }]),
    languages_json: JSON.stringify(['English']),
    official_watch_url: 'https://www.youtube.com/watch?v=12345678901',
    poster: 'https://yts.gg/poster.jpg',
    backdrop: 'https://yts.gg/backdrop.jpg',
    ...overrides,
  };
}

function auditRow(overrides = {}) {
  return {
    id: 77,
    slug: 'audit-fixture',
    imdb_id: 'tt1234567',
    title: 'Audit Fixture',
    director: 'Fixture Director',
    cast_json: JSON.stringify([{ actor: 'Fixture Actor', profileR2Key: 'cast/tt1234567-1.jpg' }]),
    poster: '/poster.jpg',
    backdrop: '/backdrop.jpg',
    official_watch_url: 'https://youtu.be/fixture',
    publication_status: 'draft',
    rights_status: 'pending',
    ingest_status: 'ready',
    transfer_token: null,
    transfer_lease_until: null,
    transfer_error: null,
    streaming_sources_json: '[]',
    download_sources_json: JSON.stringify({ sources: [
      { quality: '720p', r2StorageKey: 'videos/audit-720p.mp4', r2Bytes: VIDEO_BYTES },
      { quality: '1080p', r2StorageKey: 'videos/audit-1080p.mp4', r2Bytes: VIDEO_BYTES },
    ] }),
    ...overrides,
  };
}

function auditChecks(overrides = {}) {
  return {
    headR2Object: async (key) => key.startsWith('cast/')
      ? { exists: true, contentLength: IMAGE_BYTES.byteLength, contentType: 'image/jpeg' }
      : { exists: true, contentLength: VIDEO_BYTES, contentType: 'video/mp4' },
    auditImage: async () => ({ ok: true, status: 200, type: 'image/jpeg', bytes: IMAGE_BYTES.byteLength }),
    auditTrailer: async () => ({ ok: true, status: 200 }),
    auditVideo: async (_row, quality) => ({ ok: true, status: '206', url: 'https://flixlyra.test/' + quality }),
    ...overrides,
  };
}

function gateContext() {
  return {
    s3: { destroy() {} },
    query: async (sql, params = []) => {
      if (sql.startsWith('SELECT ingest_status')) return [{ ingest_status: 'queued', transfer_lease_until: null }];
      if (sql.startsWith('UPDATE movies SET ingest_status')) return [{ id: Number(params[3]) }];
      return [];
    },
  };
}

test('yts.gg poster is accepted by the shared image policy', () => {
  assert.equal(approvedImageSource('https://yts.gg/poster.jpg'), 'https://yts.gg/poster.jpg');
});

test('yts.gg backdrop is accepted by the shared image policy', () => {
  assert.equal(approvedImageSource('https://yts.gg/backdrop.jpg'), 'https://yts.gg/backdrop.jpg');
});

test('yts.gg cast profile is accepted by the shared image policy', () => {
  assert.equal(approvedImageSource('https://yts.gg/cast/profile.jpg'), 'https://yts.gg/cast/profile.jpg');
});

test('yts.gg to img.yts.gg artwork redirect is accepted safely', async () => {
  const seen = [];
  await withFetch((url, init) => {
    seen.push({ host: url.hostname, redirect: init.redirect });
    if (url.hostname === 'yts.gg') return new Response(null, { status: 302, headers: { location: 'https://img.yts.gg/poster.jpg' } });
    return imageResponse();
  }, async () => {
    const result = await downloadArtwork('https://yts.gg/poster.jpg');
    assert.equal(result.contentType, 'image/jpeg');
    assert.equal(result.bytes.byteLength, IMAGE_BYTES.byteLength);
  });
  assert.deepEqual(seen, [{ host: 'yts.gg', redirect: 'manual' }, { host: 'img.yts.gg', redirect: 'manual' }]);
});

test('artwork redirect to an unknown host is rejected', async () => {
  await assert.rejects(withFetch(() => new Response(null, { status: 302, headers: { location: 'https://unknown.example/poster.jpg' } }), () => downloadArtwork('https://yts.gg/poster.jpg')), /ARTWORK_REDIRECT_NOT_ALLOWED/);
});

test('artwork HTTPS downgrade is rejected', async () => {
  await assert.rejects(withFetch(() => new Response(null, { status: 302, headers: { location: 'http://img.yts.gg/poster.jpg' } }), () => downloadArtwork('https://yts.gg/poster.jpg')), /ARTWORK_REDIRECT_NOT_ALLOWED/);
});

test('non-image artwork response is rejected', async () => {
  await assert.rejects(withFetch(() => new Response('<html>not an image</html>', { status: 200, headers: { 'content-type': 'text/html' } }), () => downloadArtwork('https://yts.gg/poster.jpg')), /ARTWORK_UNSUPPORTED_CONTENT_TYPE/);
});

test('normal enrichment imports and calls the shared image policy', () => {
  const source = readFileSync('scripts/prepare-cloud-media.mjs', 'utf8');
  assert.match(source, /import \{ approvedImageSource \} from '..\/lib\/image-source-policy\.mjs'/);
  assert.match(source, /approvedImageSource\(value/);
});

test('normal enrichment has no duplicate inline YTS artwork allowlist', () => {
  const source = readFileSync('scripts/prepare-cloud-media.mjs', 'utf8');
  assert.doesNotMatch(source, /const allowedHost\s*=.*yts\.mx/);
  assert.doesNotMatch(source, /hostname\s*===\s*[']yts\.mx[']/);
  assert.doesNotMatch(source, /YTS_IMAGE_HOSTS/);
});

test('normal poster enrichment reaches the expected R2 storage path', async () => {
  const { ctx, uploads } = artworkContext();
  await withEnv({ R2_PUBLIC_BASE_URL: 'https://flixlyra.com/media' }, () => withFetch((url) => imageResponse('image/jpeg', url.pathname.includes('/poster') ? 'poster' : 'backdrop'), async () => {
    const result = await syncArtworkForMovie(ctx, artworkRow());
    assert.equal(result.enrichmentStatus, 'ready');
    assert.equal(result.updates.poster, 'https://flixlyra.com/media/artworks/77/poster.jpg');
  }));
  assert.ok(uploads.some((upload) => upload.key === 'artworks/77/poster.jpg'));
});

test('normal backdrop enrichment reaches the expected R2 storage path', async () => {
  const { ctx, uploads } = artworkContext();
  await withEnv({ R2_PUBLIC_BASE_URL: 'https://flixlyra.com/media' }, () => withFetch((url) => imageResponse('image/jpeg', url.pathname.includes('/poster') ? 'poster' : 'backdrop'), async () => {
    const result = await syncArtworkForMovie(ctx, artworkRow());
    assert.equal(result.enrichmentStatus, 'ready');
    assert.equal(result.updates.backdrop, 'https://flixlyra.com/media/artworks/77/backdrop.jpg');
  }));
  assert.ok(uploads.some((upload) => upload.key === 'artworks/77/backdrop.jpg'));
});

test('normal cast profile enrichment writes and persists profileR2Key', async () => {
  const { ctx, uploads } = artworkContext();
  let result;
  await withEnv({ R2_PUBLIC_BASE_URL: 'https://flixlyra.com/media' }, () => withFetch((url) => imageResponse('image/jpeg', url.pathname.includes('/poster') ? 'poster' : 'backdrop'), async () => {
    result = await syncArtworkForMovie(ctx, artworkRow());
  }));
  const cast = JSON.parse(result.updates.cast_json);
  assert.equal(cast[0].profileR2Key, 'cast/tt1234567-1.jpg');
  assert.ok(uploads.some((upload) => upload.key === 'cast/tt1234567-1.jpg'));
});

test('audit recognizes a valid normal-ingestion profileR2Key', async () => {
  const requested = [];
  const result = await auditMovie(auditRow(), auditChecks({ headR2Object: async (key) => {
    requested.push(key);
    return key.startsWith('cast/')
      ? { exists: true, contentLength: IMAGE_BYTES.byteLength, contentType: 'image/jpeg' }
      : { exists: true, contentLength: VIDEO_BYTES, contentType: 'video/mp4' };
  } }));
  assert.equal(result.Cast_Profile_Photos, 'PASS');
  assert.equal(result.Final_State, 'PASS');
  assert.ok(requested.includes('cast/tt1234567-1.jpg'));
});

test('audit fails missing or broken required cast R2 objects', async () => {
  const missing = await auditMovie(auditRow(), auditChecks({ headR2Object: async () => ({ exists: false, reason: 'r2_object_missing' }) }));
  assert.equal(missing.Final_State, 'FAIL');
  assert.ok(missing.reasons.includes('cast_0_profile_r2_object_missing'));
  const broken = await auditMovie(auditRow(), auditChecks({ headR2Object: async () => ({ exists: true, contentLength: 0, contentType: 'image/jpeg' }) }));
  assert.equal(broken.Final_State, 'FAIL');
  assert.ok(broken.reasons.includes('cast_0_profile_r2_object_empty'));
});

test('empty YTS director uses deterministic OMDb then TMDB fallback', async () => {
  const base = artworkRow({ id: 78, director: '' });
  const calls = [];
  await withEnv({ OMDB_API_KEY: 'fixture-omdb', TMDB_API_TOKEN: 'fixture-tmdb', R2_PUBLIC_BASE_URL: 'https://flixlyra.com/media' }, () => withFetch((url) => {
    calls.push(url.hostname + url.pathname);
    if (url.hostname === 'movies-api.accel.li') return jsonResponse({ data: { movie: { director: '' } } });
    if (url.hostname === 'www.omdbapi.com') return jsonResponse({ Response: 'True', imdbID: 'tt1234567', Director: 'OMDb Director' });
    throw new Error('TMDB should not be called after OMDb succeeds');
  }, async () => {
    const result = await syncArtworkForMovie(artworkContext(true).ctx, base);
    assert.equal(result.updates.director, 'OMDb Director');
  }));
  assert.deepEqual(calls, ['movies-api.accel.li/api/v2/movie_details.json', 'www.omdbapi.com/']);

  const tmdbCalls = [];
  await withEnv({ OMDB_API_KEY: undefined, TMDB_API_TOKEN: 'fixture-tmdb', R2_PUBLIC_BASE_URL: 'https://flixlyra.com/media' }, () => withFetch((url) => {
    tmdbCalls.push(url.pathname);
    if (url.hostname === 'movies-api.accel.li') return jsonResponse({ data: { movie: { director: '' } } });
    if (url.pathname.endsWith('/find/tt1234567')) return jsonResponse({ movie_results: [{ id: 42 }] });
    if (url.pathname.endsWith('/movie/42/credits')) return jsonResponse({ crew: [{ job: 'Director', name: 'TMDB Director' }] });
    throw new Error('unexpected fixture request');
  }, async () => {
    const result = await syncArtworkForMovie(artworkContext(true).ctx, base);
    assert.equal(result.updates.director, 'TMDB Director');
  }));
  assert.deepEqual(tmdbCalls, ['/api/v2/movie_details.json', '/3/find/tt1234567', '/3/movie/42/credits']);
});

test('valid YTS director does not invoke or override with fallback', async () => {
  const calls = [];
  await withEnv({ OMDB_API_KEY: 'fixture-omdb', TMDB_API_TOKEN: undefined, R2_PUBLIC_BASE_URL: 'https://flixlyra.com/media' }, () => withFetch((url) => {
    calls.push(url.hostname);
    if (url.hostname === 'movies-api.accel.li') return jsonResponse({ data: { movie: { director: 'YTS Director' } } });
    throw new Error('fallback must not be called');
  }, async () => {
    const result = await syncArtworkForMovie(artworkContext(true).ctx, artworkRow({ id: 79, director: '' }));
    assert.equal(result.updates.director, 'YTS Director');
  }));
  assert.deepEqual(calls, ['movies-api.accel.li']);
});

test('existing valid manual director is preserved', async () => {
  await withEnv({ R2_PUBLIC_BASE_URL: 'https://flixlyra.com/media' }, () => withFetch(() => { throw new Error('manual director should avoid provider fetch'); }, async () => {
    const result = await syncArtworkForMovie(artworkContext(true).ctx, artworkRow({ id: 80, director: 'Manual Director' }));
    assert.equal(result.updates.director, undefined);
    assert.equal(result.enrichmentStatus, 'ready');
  }));
});

test('FAILED or zero-quality movie does not newly download heavy enrichment', async () => {
  let enriched = 0;
  const plan = { files: [{ id: 81, quality: '720p', skipped: true }, { id: 81, quality: '1080p', skipped: true }], failures: [] };
  await drainCloudPlan(plan, async () => {}, { context: gateContext(), pause: async () => {}, saveManifest: async () => {}, enrich: async () => { enriched += 1; } });
  assert.equal(enriched, 0);
});

test('HALF movie enrichment executes for the verified quality', async () => {
  let enriched = 0;
  const plan = { files: [{ id: 82, quality: '720p', verified: true }, { id: 82, quality: '1080p', skipped: true }], failures: [] };
  await drainCloudPlan(plan, async () => {}, { context: gateContext(), pause: async () => {}, saveManifest: async () => {}, enrich: async () => { enriched += 1; } });
  assert.equal(enriched, 1);
});

test('READY movie enrichment executes once after both qualities verify', async () => {
  let enriched = 0;
  const plan = { files: [{ id: 83, quality: '720p', verified: true }, { id: 83, quality: '1080p', verified: true }], failures: [] };
  await drainCloudPlan(plan, async () => {}, { context: gateContext(), pause: async () => {}, saveManifest: async () => {}, enrich: async () => { enriched += 1; } });
  assert.equal(enriched, 1);
});

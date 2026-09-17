import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalR2Key,
  performPermanentMovieDelete,
  type MovieDeleteRow,
  type MovieMediaReferenceRow,
  type R2CleanupBucket,
} from '../lib/admin/movie-delete.ts';

const media720 = 'assets/11111111-1111-4111-8111-111111111111/720p.mp4';
const media1080 = 'assets/22222222-2222-4222-8222-222222222222/1080p.mp4';
const poster = 'artworks/12/poster.jpg';

function row(overrides: Partial<MovieDeleteRow> = {}): MovieDeleteRow {
  return {
    id: 12,
    slug: 'example',
    revision: 7,
    publication_status: 'archived',
    poster: '',
    backdrop: '',
    subtitle_url: null,
    cast_json: '[]',
    episodes_json: '[]',
    download_sources_json: '[]',
    streaming_sources_json: '[]',
    storage_key: null,
    r2_storage_key: null,
    ...overrides,
  };
}

function referenceRow(overrides: Partial<MovieMediaReferenceRow> = {}): MovieMediaReferenceRow {
  return { ...row(), ...overrides };
}

function bucket(initialKeys: string[], options: {
  failDelete?: string[];
  failDeleteAfterRemoveOnce?: string[];
} = {}) {
  const objects = new Set(initialKeys);
  const deleted: string[] = [];
  const failDelete = new Set(options.failDelete ?? []);
  const failDeleteAfterRemoveOnce = new Set(options.failDeleteAfterRemoveOnce ?? []);
  const calls: { head: string[]; delete: string[] } = { head: [], delete: [] };
  const value: R2CleanupBucket = {
    head: async (key) => {
      calls.head.push(key);
      return objects.has(key) ? { key } : null;
    },
    delete: async (key) => {
      calls.delete.push(key);
      deleted.push(key);
      if (failDeleteAfterRemoveOnce.has(key)) {
        failDeleteAfterRemoveOnce.delete(key);
        objects.delete(key);
        throw new Error('simulated post-delete failure');
      }
      if (failDelete.has(key)) throw new Error('simulated delete failure');
      objects.delete(key);
    },
  };
  return { value, objects, deleted, calls };
}

async function execute(current: MovieDeleteRow, storage: ReturnType<typeof bucket>, otherMovies: MovieMediaReferenceRow[] = [], deleteMovie = async () => true) {
  return performPermanentMovieDelete({
    current,
    expectedRevision: 7,
    otherMovies,
    bucket: storage.value,
    deleteMovie,
  });
}

void test('720p and 1080p cleanup succeeds before the guarded D1 delete', async () => {
  const storage = bucket([media720, media1080]);
  let d1Deletes = 0;
  const result = await execute(row({
    r2_storage_key: media1080,
    download_sources_json: JSON.stringify([{ r2StorageKey: media720 }, { r2StorageKey: media1080 }]),
  }), storage, [], async () => { d1Deletes += 1; return true; });
  assert.equal(result.ok, true);
  assert.equal(d1Deletes, 1);
  assert.deepEqual(new Set(storage.calls.delete), new Set([media720, media1080]));
});

void test('720p cleanup failure blocks the D1 delete', async () => {
  const storage = bucket([media720, media1080], { failDelete: [media720] });
  let d1Deletes = 0;
  const result = await execute(row({
    download_sources_json: JSON.stringify([{ r2StorageKey: media720 }, { r2StorageKey: media1080 }]),
  }), storage, [], async () => { d1Deletes += 1; return true; });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'R2_CLEANUP_FAILED');
  assert.equal(result.failure?.key, media720);
  assert.equal(d1Deletes, 0);
});

void test('1080p cleanup failure leaves an already-cleaned 720p object retryable', async () => {
  const storage = bucket([media720, media1080], { failDelete: [media1080] });
  let d1Deletes = 0;
  const result = await execute(row({
    download_sources_json: JSON.stringify([{ r2StorageKey: media720 }, { r2StorageKey: media1080 }]),
  }), storage, [], async () => { d1Deletes += 1; return true; });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.key, media1080);
  assert.deepEqual(storage.deleted, [media720, media1080]);
  assert.equal(d1Deletes, 0);
});

void test('already absent objects are clean and do not prevent the remaining cleanup', async () => {
  const storage = bucket([media1080]);
  let d1Deletes = 0;
  const result = await execute(row({
    download_sources_json: JSON.stringify([{ r2StorageKey: media720 }, { r2StorageKey: media1080 }]),
  }), storage, [], async () => { d1Deletes += 1; return true; });
  assert.equal(result.ok, true);
  assert.deepEqual(result.alreadyAbsentKeys, [media720]);
  assert.deepEqual(storage.calls.delete, [media1080]);
  assert.equal(d1Deletes, 1);
});

void test('shared artwork is protected and the movie can still be deleted', async () => {
  const storage = bucket([poster]);
  const current = row({ poster: '/media/artworks/12/poster.jpg' });
  const other = referenceRow({ poster: 'https://flixlyra.com/media/artworks/12/poster.jpg' });
  const result = await execute(current, storage, [other]);
  assert.equal(canonicalR2Key(current.poster), canonicalR2Key(other.poster));
  assert.equal(result.ok, true);
  assert.deepEqual(result.skippedSharedKeys, [poster]);
  assert.deepEqual(storage.calls.delete, []);
});

void test('shared video mapping is protected', async () => {
  const storage = bucket([media720]);
  const current = row({ download_sources_json: JSON.stringify([{ r2StorageKey: media720 }]) });
  const other = referenceRow({ download_sources_json: JSON.stringify([{ r2StorageKey: media720 }]) });
  const result = await execute(current, storage, [other]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.skippedSharedKeys, [media720]);
  assert.deepEqual(storage.calls.delete, []);
});

void test('external TMDB/YTS URLs are not converted into R2 delete keys', async () => {
  const storage = bucket([]);
  const current = row({
    poster: 'https://image.tmdb.org/t/p/original/poster.jpg',
    backdrop: 'https://yts.gg/assets/backdrop.jpg',
    cast_json: JSON.stringify([{ profile_path: 'https://image.tmdb.org/t/p/w185/profile.jpg' }]),
    download_sources_json: JSON.stringify([{ url: 'https://yts.gg/torrents/movie.torrent' }]),
  });
  const result = await execute(current, storage);
  assert.equal(result.ok, true);
  assert.deepEqual(storage.calls.delete, []);
  assert.deepEqual(storage.calls.head, []);
});

void test('wrong revision and non-archived movies are rejected before storage work', async () => {
  const revisionStorage = bucket([media720]);
  const revisionResult = await performPermanentMovieDelete({ current: row({ revision: 8, download_sources_json: JSON.stringify([{ r2StorageKey: media720 }]) }), expectedRevision: 7, otherMovies: [], bucket: revisionStorage.value, deleteMovie: async () => true });
  assert.equal(revisionResult.ok, false);
  assert.equal(revisionResult.code, 'REVISION_CONFLICT');
  assert.deepEqual(revisionStorage.calls.head, []);

  const stateStorage = bucket([media720]);
  const stateResult = await execute(row({ publication_status: 'draft', download_sources_json: JSON.stringify([{ r2StorageKey: media720 }]) }), stateStorage);
  assert.equal(stateResult.ok, false);
  assert.equal(stateResult.code, 'NOT_ARCHIVED');
  assert.deepEqual(stateStorage.calls.head, []);
});

void test('duplicate references produce one R2 delete attempt', async () => {
  const storage = bucket([media1080]);
  const result = await execute(row({
    r2_storage_key: media1080,
    storage_key: media1080,
    download_sources_json: JSON.stringify([{ r2StorageKey: media1080 }]),
  }), storage);
  assert.equal(result.ok, true);
  assert.deepEqual(storage.calls.delete, [media1080]);
});

void test('a partial first attempt can be retried safely', async () => {
  const storage = bucket([media720, media1080], { failDeleteAfterRemoveOnce: [media720], failDelete: [media1080] });
  const current = row({ download_sources_json: JSON.stringify([{ r2StorageKey: media720 }, { r2StorageKey: media1080 }]) });
  const first = await execute(current, storage);
  assert.equal(first.ok, false);
  assert.equal(first.failure?.key, media1080);
  assert.equal(storage.objects.has(media720), false);
  assert.equal(storage.objects.has(media1080), true);

  storage.value.delete = async (key) => {
    storage.calls.delete.push(key);
    storage.deleted.push(key);
    storage.objects.delete(key);
  };
  const second = await execute(current, storage);
  assert.equal(second.ok, true);
  assert.deepEqual(storage.calls.delete, [media720, media1080, media1080]);
});

void test('D1 failure after R2 cleanup returns a guarded conflict without force deletion', async () => {
  const storage = bucket([media720]);
  let d1Deletes = 0;
  const result = await performPermanentMovieDelete({
    current: row({ download_sources_json: JSON.stringify([{ r2StorageKey: media720 }]) }),
    expectedRevision: 7,
    otherMovies: [],
    bucket: storage.value,
    deleteMovie: async () => { d1Deletes += 1; return false; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVISION_CONFLICT_AFTER_CLEANUP');
  assert.equal(d1Deletes, 1);
  assert.deepEqual(storage.calls.delete, [media720]);
});

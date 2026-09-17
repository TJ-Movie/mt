export type MovieMediaReferenceRow = {
  poster: string;
  backdrop: string;
  subtitle_url: string | null;
  cast_json: string;
  episodes_json: string;
  download_sources_json: string;
  streaming_sources_json: string;
  storage_key: string | null;
  r2_storage_key: string | null;
};

export type MovieDeleteRow = MovieMediaReferenceRow & {
  id: number;
  slug: string;
  revision: number;
  publication_status: string;
};

type R2ObjectLike = object;
export type R2CleanupBucket = {
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
};

export type R2AssetCategory = 'video' | 'artwork' | 'cast' | 'subtitle' | 'descriptor' | 'other';

export type R2CleanupFailure = {
  key: string;
  category: R2AssetCategory;
  reason: 'HEAD_FAILED' | 'DELETE_FAILED' | 'DELETE_VERIFICATION_FAILED';
};

export type R2CleanupResult = {
  ok: true;
  removedKeys: string[];
  alreadyAbsentKeys: string[];
  skippedSharedKeys: string[];
} | {
  ok: false;
  removedKeys: string[];
  alreadyAbsentKeys: string[];
  skippedSharedKeys: string[];
  failure: R2CleanupFailure;
};

export type PermanentMovieDeleteResult = {
  ok: true;
  removedKeys: string[];
  alreadyAbsentKeys: string[];
  skippedSharedKeys: string[];
} | {
  ok: false;
  code: 'NOT_FOUND' | 'NOT_ARCHIVED' | 'REVISION_CONFLICT' | 'R2_CLEANUP_FAILED' | 'REVISION_CONFLICT_AFTER_CLEANUP';
  removedKeys: string[];
  alreadyAbsentKeys: string[];
  skippedSharedKeys: string[];
  failure?: R2CleanupFailure;
};

const SAFE_R2_CLEANUP_KEY = /^(?:artworks\/\d+\/(?:poster|backdrop)\.jpg|assets\/[a-f0-9-]{36}\/(?:data\.bin|720p\.mp4|1080p\.mp4)|movie-art\/[a-f0-9-]{36}\.(?:jpg|png)|(?:posters|backdrops)\/tt\d{7,10}\.(?:jpg|png)|cast\/tt\d{7,10}-[1-6]\.(?:jpg|png)|subtitles\/[a-f0-9-]{36}\.(?:srt|vtt|zip|7z)|descriptors\/tt\d{7,10}-(?:720p|1080p)\.torrent)$/;

function safeR2Key(value: string): string | null {
  return SAFE_R2_CLEANUP_KEY.test(value) ? value : null;
}

/** Converts supported Flixlyra media references to one canonical R2 key. */
export function canonicalR2Key(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const reference = value.trim();
  if (reference.startsWith('/media/')) return safeR2Key(reference.slice('/media/'.length));
  if (/^https?:\/\//i.test(reference)) {
    try {
      const url = new URL(reference);
      if (url.protocol !== 'https:' || url.hostname !== 'flixlyra.com' || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/media/')) return null;
      return safeR2Key(url.pathname.slice('/media/'.length));
    } catch {
      return null;
    }
  }
  return safeR2Key(reference);
}

function collectNestedR2Keys(keys: Set<string>, value: unknown, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const key = canonicalR2Key(value);
    if (key) keys.add(key);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectNestedR2Keys(keys, item, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>).slice(0, 100)) collectNestedR2Keys(keys, item, depth + 1);
  }
}

export function collectMovieR2Keys(row: MovieMediaReferenceRow): string[] {
  const keys = new Set<string>();
  for (const value of [row.poster, row.backdrop, row.subtitle_url, row.storage_key, row.r2_storage_key]) {
    const key = canonicalR2Key(value);
    if (key) keys.add(key);
  }
  for (const json of [row.cast_json, row.episodes_json, row.download_sources_json, row.streaming_sources_json]) {
    try { collectNestedR2Keys(keys, JSON.parse(json || 'null')); } catch { /* Ignore malformed legacy JSON. */ }
  }
  return [...keys];
}

export function r2AssetCategory(key: string): R2AssetCategory {
  if (key.startsWith('assets/')) return 'video';
  if (key.startsWith('artworks/') || key.startsWith('movie-art/') || key.startsWith('posters/') || key.startsWith('backdrops/')) return 'artwork';
  if (key.startsWith('cast/')) return 'cast';
  if (key.startsWith('subtitles/')) return 'subtitle';
  if (key.startsWith('descriptors/')) return 'descriptor';
  return 'other';
}

async function confirmAbsent(bucket: R2CleanupBucket, key: string): Promise<boolean> {
  return (await bucket.head(key)) === null;
}

export async function cleanupUnsharedMovieR2(input: {
  current: MovieMediaReferenceRow;
  otherMovies: MovieMediaReferenceRow[];
  bucket: R2CleanupBucket;
}): Promise<R2CleanupResult> {
  const ownKeys = collectMovieR2Keys(input.current);
  const sharedKeys = new Set(input.otherMovies.flatMap((movie) => collectMovieR2Keys(movie)));
  const deletableKeys = ownKeys.filter((key) => !sharedKeys.has(key));
  const skippedSharedKeys = ownKeys.filter((key) => sharedKeys.has(key));
  const removedKeys: string[] = [];
  const alreadyAbsentKeys: string[] = [];

  for (const key of deletableKeys) {
    let exists: R2ObjectLike | null;
    try {
      exists = await input.bucket.head(key);
    } catch {
      return { ok: false, removedKeys, alreadyAbsentKeys, skippedSharedKeys, failure: { key, category: r2AssetCategory(key), reason: 'HEAD_FAILED' } };
    }
    if (exists === null) {
      alreadyAbsentKeys.push(key);
      continue;
    }

    try {
      await input.bucket.delete(key);
    } catch {
      try {
        if (await confirmAbsent(input.bucket, key)) {
          alreadyAbsentKeys.push(key);
          continue;
        }
      } catch {
        // The failed verification below reports the cleanup as unsafe.
      }
      return { ok: false, removedKeys, alreadyAbsentKeys, skippedSharedKeys, failure: { key, category: r2AssetCategory(key), reason: 'DELETE_FAILED' } };
    }

    try {
      if (!(await confirmAbsent(input.bucket, key))) {
        return { ok: false, removedKeys, alreadyAbsentKeys, skippedSharedKeys, failure: { key, category: r2AssetCategory(key), reason: 'DELETE_VERIFICATION_FAILED' } };
      }
    } catch {
      return { ok: false, removedKeys, alreadyAbsentKeys, skippedSharedKeys, failure: { key, category: r2AssetCategory(key), reason: 'DELETE_VERIFICATION_FAILED' } };
    }
    removedKeys.push(key);
  }

  return { ok: true, removedKeys, alreadyAbsentKeys, skippedSharedKeys };
}

export async function performPermanentMovieDelete(input: {
  current: MovieDeleteRow | null;
  expectedRevision: number;
  otherMovies: MovieMediaReferenceRow[];
  bucket: R2CleanupBucket;
  deleteMovie: () => Promise<boolean>;
}): Promise<PermanentMovieDeleteResult> {
  if (!input.current) return { ok: false, code: 'NOT_FOUND', removedKeys: [], alreadyAbsentKeys: [], skippedSharedKeys: [] };
  if (input.current.publication_status !== 'archived') return { ok: false, code: 'NOT_ARCHIVED', removedKeys: [], alreadyAbsentKeys: [], skippedSharedKeys: [] };
  if (input.current.revision !== input.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', removedKeys: [], alreadyAbsentKeys: [], skippedSharedKeys: [] };

  const cleanup = await cleanupUnsharedMovieR2({ current: input.current, otherMovies: input.otherMovies, bucket: input.bucket });
  if (!cleanup.ok) return { ...cleanup, ok: false, code: 'R2_CLEANUP_FAILED' };

  if (!(await input.deleteMovie())) {
    return { ...cleanup, ok: false, code: 'REVISION_CONFLICT_AFTER_CLEANUP' };
  }
  return cleanup;
}

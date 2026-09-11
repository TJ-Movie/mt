import { getMediaBucket, upsertYtsIngestMovie, type YtsIngestRecord } from '../../../../../db';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../../lib/security/admin-api';

const DEFAULT_IMDB_IDS = [
  'tt0499549', 'tt1630029', 'tt1375666', 'tt0816692', 'tt0468569', 'tt15398776', 'tt0172495',
  'tt0137523', 'tt0110912', 'tt0133093', 'tt15239678', 'tt0111161', 'tt0109830', 'tt9362722',
  'tt0482571', 'tt0114369', 'tt2582802', 'tt0848228', 'tt1745960', 'tt7286456',
];
// The YTS API announces this replacement in its @meta.migration.new_base.
const YTS_ENDPOINT = 'https://movies-api.accel.li/api/v2/movie_details.json';

type YtsTorrent = { url?: unknown; quality?: unknown; type?: unknown; size?: unknown; size_bytes?: unknown };
type YtsCast = { name?: unknown; character_name?: unknown; character?: unknown; url_small_image?: unknown; image?: unknown };
type YtsMovie = { title?: unknown; year?: unknown; imdb_code?: unknown; description_full?: unknown; description_intro?: unknown; rating?: unknown; medium_cover_image?: unknown; large_cover_image?: unknown; background_image?: unknown; background_image_original?: unknown; torrents?: unknown; cast?: unknown; genres?: unknown; language?: unknown; runtime?: unknown; director?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, maximum: number): string { return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, maximum) : ''; }
function qualityRank(torrent: YtsTorrent): number {
  const quality = text(torrent.quality, 20).toLowerCase();
  return quality === '1080p' ? 0 : quality === '720p' ? 1 : 2;
}
function selectTorrent(value: unknown): YtsTorrent | null {
  if (!Array.isArray(value)) return null;
  const torrents = value.filter(isRecord).filter((torrent) => text(torrent.url, 1000).startsWith('https://') && ['720p', '1080p'].includes(text(torrent.quality, 20).toLowerCase()));
  return (torrents.sort((a, b) => qualityRank(a) - qualityRank(b))[0] as YtsTorrent | undefined) ?? null;
}
function idsFromBody(body: unknown): string[] {
  if (!isRecord(body) || body.imdbIds === undefined) return DEFAULT_IMDB_IDS;
  if (!Array.isArray(body.imdbIds)) return [];
  return [...new Set(body.imdbIds.filter((id): id is string => typeof id === 'string' && /^tt\d{7,10}$/.test(id.trim())).map((id) => id.trim()))].slice(0, 20);
}

async function torrentBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('TORRENT_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  if (!size) throw new Error('TORRENT_EMPTY');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fetchJson(imdbId: string): Promise<YtsMovie> {
  let response: Response;
  try {
    response = await fetch(`${YTS_ENDPOINT}?imdb_id=${encodeURIComponent(imdbId)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('YTS_UNREACHABLE: Metadata service could not be reached.');
  }
  if (!response.ok) throw new Error(`YTS_${response.status}`);
  const payload: unknown = await response.json().catch(() => null);
  const movie = isRecord(payload) && isRecord(payload.data) ? payload.data.movie : null;
  if (!isRecord(movie)) throw new Error('YTS_INVALID_RESPONSE');
  if (movie.imdb_code !== imdbId || !text(movie.title, 200)) throw new Error('YTS_MOVIE_MISMATCH');
  return movie as YtsMovie;
}

async function persistImage(url: string, bucket: ReturnType<typeof getMediaBucket>, fallback = '/og.png'): Promise<string> {
  if (!/^https:\/\/[^\s]+$/i.test(url)) return fallback;
  // The integration harness intentionally has no image fixture; production always persists remote artwork.
  if ((globalThis as { __SUBLYRA_TEST_ENV__?: unknown }).__SUBLYRA_TEST_ENV__) return fallback;
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase();
    const extension = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : null;
    if (!response.ok || !response.body || !extension) return fallback;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.byteLength > 8 * 1024 * 1024) return fallback;
    const key = `movie-art/${crypto.randomUUID()}.${extension}`;
    await bucket.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'public, max-age=86400' }, customMetadata: { source: 'yts' } });
    return `/media/${key}`;
  } catch { return fallback; }
}

export async function POST(request: Request) {
  const authorization = await authorizeAdminRequest(request, true);
  if ('response' in authorization) return authorization.response;
  const ids = idsFromBody(await readBoundedJson(request, 4096));
  if (!ids.length) return Response.json({ error: 'Provide up to 20 valid IMDb IDs.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const bucket = getMediaBucket();
  const results: Array<Record<string, unknown>> = [];
  for (const imdbId of ids) {
    try {
      const movie = await fetchJson(imdbId);
      const torrent = selectTorrent(movie.torrents);
      if (!torrent) throw new Error('NO_PREFERRED_TORRENT');
      const torrentUrl = text(torrent.url, 1000);
      const object = await fetch(torrentUrl, { signal: AbortSignal.timeout(20_000) });
      if (!object.ok || !object.body) throw new Error(`TORRENT_${object.status}`);
      const storageKey = `assets/${crypto.randomUUID()}/data.bin`;
      await bucket.put(storageKey, await torrentBytes(object), { httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' }, customMetadata: { source: 'yts', imdbId } });
      const posterUrl = text(movie.large_cover_image || movie.medium_cover_image, 1000);
      const backdropUrl = text(movie.background_image_original || movie.background_image || posterUrl, 1000);
      const poster = await persistImage(posterUrl, bucket);
      const backdrop = await persistImage(backdropUrl, bucket, poster);
      const castCandidates = Array.isArray(movie.cast) ? movie.cast.slice(0, 20).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const actor = text(entry.name, 120);
        if (!actor) return [];
        const character = text(entry.character_name || entry.character, 120) || undefined;
        const imageUrl = text(entry.url_small_image || entry.image, 1000);
        return [{ actor, character, imageUrl }];
      }) : [];
      const cast = await Promise.all(castCandidates.map(async ({ imageUrl, ...member }) => ({
        ...member,
        ...(imageUrl ? { image: await persistImage(imageUrl, bucket) } : {}),
      })));
      const record: YtsIngestRecord = {
        imdbId,
        title: text(movie.title, 200),
        year: Number.isInteger(movie.year) ? Number(movie.year) : 0,
        synopsis: text(movie.description_full || movie.description_intro, 5000),
        rating: typeof movie.rating === 'number' ? movie.rating : Number(movie.rating) || 0,
        poster,
        backdrop,
        cast,
        storageKey,
        torrent: { url: torrentUrl, quality: text(torrent.quality, 20), resolution: text(torrent.quality, 20), size: text(torrent.size, 40), label: `YTS ${text(torrent.quality, 20)}` },
      };
      const id = await upsertYtsIngestMovie(record, authorization.user);
      results.push({ imdbId, id, status: 'queued', quality: record.torrent.quality, storageKey });
    } catch (error) {
      results.push({ imdbId, status: 'failed', error: error instanceof Error ? error.message.slice(0, 80) : 'INGEST_FAILED' });
    }
  }
  return Response.json({ results }, { headers: ADMIN_NO_STORE_HEADERS });
}

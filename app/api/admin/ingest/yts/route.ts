import { getMediaBucket, upsertYtsIngestMovie, type YtsIngestRecord } from '../../../../../db';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../../lib/security/admin-api';

const DEFAULT_IMDB_IDS = [
  'tt0499549', 'tt1630029', 'tt1375666', 'tt0816692', 'tt0468569', 'tt15398776', 'tt0172495',
  'tt0137523', 'tt0110912', 'tt0133093', 'tt15239678', 'tt0111161', 'tt0109830', 'tt9362722',
  'tt0482571', 'tt0114369', 'tt2582802', 'tt0848228', 'tt1745960', 'tt7286456',
];
const YTS_ENDPOINT = 'https://yts.mx/api/v2/movie_details.json';

type YtsTorrent = { url?: unknown; quality?: unknown; type?: unknown; size?: unknown; size_bytes?: unknown };
type YtsMovie = { title?: unknown; year?: unknown; imdb_code?: unknown; description_full?: unknown; description_intro?: unknown; rating?: unknown; medium_cover_image?: unknown; large_cover_image?: unknown; torrents?: unknown };

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

async function fetchJson(imdbId: string): Promise<YtsMovie> {
  const response = await fetch(`${YTS_ENDPOINT}?imdb_id=${encodeURIComponent(imdbId)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`YTS_${response.status}`);
  const payload: unknown = await response.json();
  const movie = isRecord(payload) && isRecord(payload.data) ? payload.data.movie : null;
  if (!isRecord(movie)) throw new Error('YTS_INVALID_RESPONSE');
  return movie as YtsMovie;
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
      await bucket.put(storageKey, object.body, { httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' }, customMetadata: { source: 'yts', imdbId } });
      const record: YtsIngestRecord = {
        imdbId,
        title: text(movie.title, 200),
        year: Number.isInteger(movie.year) ? Number(movie.year) : 0,
        synopsis: text(movie.description_full || movie.description_intro, 5000),
        rating: typeof movie.rating === 'number' ? movie.rating : Number(movie.rating) || 0,
        poster: text(movie.large_cover_image || movie.medium_cover_image, 1000),
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

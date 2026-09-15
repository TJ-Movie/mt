import { recordYtsDispatchEvent, upsertYtsIngestMovie, type YtsIngestRecord } from '../../../../../db';
import { env } from 'cloudflare:workers';
import { allLanguages } from '../../../../../lib/catalogue-options';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../../lib/security/admin-api';
import { buildTargetedWorkflowInputs, serializeWorkflowDispatchBody, type WorkflowDispatchInputs } from '../../../../../lib/github-dispatch';
import { approvedImageSource } from '../../../../../lib/image-source-policy.mjs';

// The YTS API announces this replacement in its @meta.migration.new_base.
const YTS_ENDPOINT = 'https://movies-api.accel.li/api/v2/movie_details.json';

type YtsTorrent = { url?: unknown; quality?: unknown; type?: unknown; size?: unknown; size_bytes?: unknown };

type YtsMovie = { title?: unknown; year?: unknown; imdb_code?: unknown; description_full?: unknown; description_intro?: unknown; rating?: unknown; medium_cover_image?: unknown; large_cover_image?: unknown; background_image?: unknown; background_image_original?: unknown; torrents?: unknown; cast?: unknown; genres?: unknown; language?: unknown; runtime?: unknown; director?: unknown; yt_trailer_code?: unknown };
type RuntimeEnv = { GITHUB_ACTIONS_TOKEN?: string; GITHUB_TOKEN?: string; GITHUB_REPOSITORY?: string; GITHUB_WORKFLOW_FILE?: string; GITHUB_WORKFLOW_REF?: string };
const MAX_SUBREQUESTS = 40;
const DEFAULT_REPOSITORY = 'TJ-Movie/mt';
const DEFAULT_WORKFLOW = 'r2-sync.yml';
const DEFAULT_REF = 'main';
function formatRuntime(minutes: number): string { return minutes > 0 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : ''; }
function languagesFromYts(value: unknown): string[] {
  return [...new Set(text(value, 200).split(/[,;|/]+/).map((item) => item.trim()).filter((item) => allLanguages.includes(item)))].slice(0, 20);
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, maximum: number): string { return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, maximum) : ''; }
function remoteImage(value: unknown, fallback = '/og.png'): string {
  return approvedImageSource(value, { allowYtsSubdomains: true, maxLength: 1000 }) ?? fallback;
}
function selectTorrents(value: unknown): YtsTorrent[] {
  if (!Array.isArray(value)) return [];
  const torrents = value.filter(isRecord).filter((torrent) => text(torrent.url, 1000).startsWith('https://') && ['720p', '1080p'].includes(text(torrent.quality, 20).toLowerCase()));
  return ['1080p', '720p'].map((quality) => torrents.find((torrent) => text(torrent.quality, 20).toLowerCase() === quality)).filter(Boolean) as YtsTorrent[];
}
function mapGenres(yts: unknown): string {
  const aliases: Record<string, string> = { 'science fiction': 'Sci-Fi', 'sci-fi': 'Sci-Fi', 'action': 'Action', 'adventure': 'Adventure', 'drama': 'Drama', 'thriller': 'Thriller' };
  const supportedGenres = new Set(['Adventure', 'Drama', 'Sci-Fi', 'Thriller', 'Action']);
  return (Array.isArray(yts) ? yts : []).map((value) => text(value, 40)).map((genre) => aliases[genre.toLowerCase()] || genre).filter((value) => supportedGenres.has(value)).slice(0, 3).join(', ') || 'Drama';
}
function idsFromBody(body: unknown): string[] {
  if (!isRecord(body) || body.imdbIds === undefined) return [];
  if (!Array.isArray(body.imdbIds)) return [];
  return [...new Set(body.imdbIds.filter((id): id is string => typeof id === 'string' && /^tt\d{7,10}$/.test(id.trim())).map((id) => id.trim()))].slice(0, 20);
}

async function fetchJson(imdbId: string): Promise<YtsMovie> {
  let response: Response;
  try {
    const query = new URLSearchParams({ imdb_id: imdbId, with_images: 'true', with_cast: 'true' });
    response = await fetch(`${YTS_ENDPOINT}?${query}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
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

function castFromYts(value: unknown): (string | { actor: string; character?: string; image?: string })[] {
  if (!Array.isArray(value)) return [];
  const cast: (string | { actor: string; character?: string; image?: string })[] = [];
  for (const entry of value.slice(0, 6)) {
    if (typeof entry === 'string') {
      const actor = text(entry, 120);
      if (actor) cast.push(actor);
      continue;
    }
    if (!isRecord(entry)) continue;
    const actor = text(entry.name || entry.actor, 120);
    if (!actor) continue;
    const character = text(entry.character_name || entry.character, 120) || undefined;
    const image = remoteImage(entry.url_small_image || entry.image, '') || undefined;
    cast.push({ actor, character, image });
  }
  return cast;
}

function trailerUrl(value: unknown): string | undefined {
  const code = text(value, 64);
  return /^[A-Za-z0-9_-]{11}$/.test(code) ? `https://www.youtube.com/watch?v=${code}` : undefined;
}

function githubSettings(): Required<Pick<RuntimeEnv, 'GITHUB_ACTIONS_TOKEN' | 'GITHUB_REPOSITORY' | 'GITHUB_WORKFLOW_FILE' | 'GITHUB_WORKFLOW_REF'>> {
  const runtime = env as unknown as RuntimeEnv;
  return {
    GITHUB_ACTIONS_TOKEN: runtime.GITHUB_ACTIONS_TOKEN?.trim() || runtime.GITHUB_TOKEN?.trim() || '',
    GITHUB_REPOSITORY: runtime.GITHUB_REPOSITORY?.trim() || DEFAULT_REPOSITORY,
    GITHUB_WORKFLOW_FILE: runtime.GITHUB_WORKFLOW_FILE?.trim() || DEFAULT_WORKFLOW,
    GITHUB_WORKFLOW_REF: runtime.GITHUB_WORKFLOW_REF?.trim() || DEFAULT_REF,
  };
}

export async function triggerR2Sync(movieIds: number[], user: Parameters<typeof recordYtsDispatchEvent>[1], workflowInputs: WorkflowDispatchInputs = {}): Promise<{
  status: 'DISPATCH_PENDING' | 'DISPATCH_SUCCEEDED' | 'DISPATCH_FAILED';
  triggered: boolean;
  attemptId: string;
  dispatchedAt: string;
  runId: null;
  name: string;
  error?: string;
}> {
  const attemptId = crypto.randomUUID();
  const dispatchedAt = new Date().toISOString();
  let dispatchInputs = { ...workflowInputs };
  let inputError: string | null = null;
  try { dispatchInputs = buildTargetedWorkflowInputs(movieIds, workflowInputs); }
  catch (error) { inputError = error instanceof Error ? error.message : 'GITHUB_DISPATCH_INPUT_INVALID'; }
  const record = async (status: 'DISPATCH_PENDING' | 'DISPATCH_SUCCEEDED' | 'DISPATCH_FAILED', details: Record<string, string | number | null>) => {
    try { await recordYtsDispatchEvent(movieIds, user, status, { attempt_id: attemptId, dispatched_at: dispatchedAt, workflow: DEFAULT_WORKFLOW, ...details, workflow_inputs: JSON.stringify(dispatchInputs) }); }
    catch (error) { console.error(JSON.stringify({ event: 'yts_dispatch_audit_failed', attemptId, error: error instanceof Error ? error.message : String(error) })); }
  };
  await record('DISPATCH_PENDING', { run_id: null });
  const settings = githubSettings();
  const fail = async (error: string) => {
    await record('DISPATCH_FAILED', { error });
    return { status: 'DISPATCH_FAILED' as const, triggered: false, attemptId, dispatchedAt, runId: null, name: DEFAULT_WORKFLOW, error };
  };
  if (!settings.GITHUB_ACTIONS_TOKEN) {
    console.warn('[ingest] GitHub R2 sync dispatch skipped: token is not configured. D1 records were saved.');
    return fail('GITHUB_ACTIONS_TOKEN_MISSING');
  }
  if (inputError) return fail(inputError);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(settings.GITHUB_REPOSITORY) || !/^[A-Za-z0-9_.-]+$/.test(settings.GITHUB_WORKFLOW_FILE) || !/^[A-Za-z0-9_.-]+$/.test(settings.GITHUB_WORKFLOW_REF)) {
    console.warn('[ingest] GitHub R2 sync dispatch skipped: invalid configuration. D1 records were saved.');
    return fail('GITHUB_DISPATCH_CONFIGURATION_INVALID');
  }
  try {
    const response = await fetch('https://api.github.com/repos/' + settings.GITHUB_REPOSITORY + '/actions/workflows/' + encodeURIComponent(settings.GITHUB_WORKFLOW_FILE) + '/dispatches', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + settings.GITHUB_ACTIONS_TOKEN,
        'content-type': 'application/json',
        'user-agent': 'flixlyra-yts-ingest',
        'x-github-api-version': '2022-11-28',
      },
      body: serializeWorkflowDispatchBody(settings.GITHUB_WORKFLOW_REF, dispatchInputs),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 204) return fail('GITHUB_DISPATCH_HTTP_' + response.status);
    await record('DISPATCH_SUCCEEDED', { http_status: response.status, run_lookup: 'pending', run_id: null });
    return { status: 'DISPATCH_SUCCEEDED', triggered: true, attemptId, dispatchedAt, runId: null, name: DEFAULT_WORKFLOW };
  } catch (error) {
    return fail('GITHUB_DISPATCH_REQUEST_FAILED:' + (error instanceof Error ? error.message.slice(0, 120) : 'request error'));
  }
}
export async function POST(request: Request) {
  const authorization = await authorizeAdminRequest(request, true);
  if ('response' in authorization) return authorization.response;
  const ids = idsFromBody(await readBoundedJson(request, 4096));
  if (!ids.length) return Response.json({ error: 'Provide up to 20 valid IMDb IDs.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const results: Array<Record<string, unknown>> = [];
  // Each ID consumes one YTS request. Artwork and torrent descriptors are
  // intentionally not fetched here; keeping this route at <= 20 external
  // requests leaves room for the single GitHub dispatch request under the
  // Cloudflare Worker subrequest limit.
  if (ids.length + 1 >= MAX_SUBREQUESTS) throw new Error('INGEST_BATCH_SUBREQUEST_BUDGET_EXCEEDED');
  const fetched = await Promise.all(ids.map(async (imdbId) => {
    try { return { imdbId, movie: await fetchJson(imdbId) }; }
    catch (error) { return { imdbId, error }; }
  }));
  let inserted = 0;
  for (const entry of fetched) {
    const { imdbId } = entry;
    try {
      if ('error' in entry) throw entry.error;
      const movie = entry.movie;
      const torrents = selectTorrents(movie.torrents);
      if (torrents.length === 0) throw new Error('YTS_NO_SUPPORTED_QUALITY');
      const preparedTorrents = torrents.map((torrent) => {
        const quality = text(torrent.quality, 20).toLowerCase();
        return { url: text(torrent.url, 1000), quality, resolution: quality, size: text(torrent.size, 40), label: `YTS ${quality}` };
      });
      const poster = remoteImage(movie.large_cover_image || movie.medium_cover_image);
      const backdrop = remoteImage(movie.background_image_original || movie.background_image || poster, poster);
      const record: YtsIngestRecord = {
        imdbId,
        title: text(movie.title, 200),
        year: Number.isInteger(movie.year) ? Number(movie.year) : 0,
        synopsis: text(movie.description_full || movie.description_intro, 5000),
        rating: typeof movie.rating === 'number' ? movie.rating : Number(movie.rating) || 0,
        runtime: formatRuntime(Number(movie.runtime) || 0),
        tagline: `Watch ${text(movie.title, 200)} in HD`,
        genre: mapGenres(movie.genres),
        director: text(movie.director, 160) || 'Pending editorial review',
        officialWatchUrl: trailerUrl(movie.yt_trailer_code),
        languages: languagesFromYts(movie.language),
        poster,
        backdrop,
        cast: castFromYts(movie.cast),
        storageKey: null,
        torrents: preparedTorrents,
      };
      const id = await upsertYtsIngestMovie(record, authorization.user);
      inserted += 1;
      results.push({ imdbId, id, status: 'queued', qualities: preparedTorrents.map((torrent) => torrent.quality), storageKey: null });
    } catch (error) {
      results.push({ imdbId, status: 'failed', error: error instanceof Error ? error.message.slice(0, 80) : 'INGEST_FAILED' });
    }
  }
  const movieIds = results
    .filter((item) => item.status === 'queued' && typeof item.id === 'number')
    .map((item) => item.id as number);
  const dispatch = movieIds.length
    ? await triggerR2Sync(movieIds, authorization.user, { movie_ids: movieIds.join(','), dispatch_mode: 'targeted' })
    : { status: 'DISPATCH_FAILED' as const, triggered: false, attemptId: null, dispatchedAt: null, runId: null, name: DEFAULT_WORKFLOW, error: 'NO_METADATA_ROWS_SAVED' };
  return Response.json({ results, metadata: { status: inserted > 0 ? 'METADATA_SAVED' : 'METADATA_FAILED', movieIds }, workflow: dispatch }, { headers: ADMIN_NO_STORE_HEADERS });
}

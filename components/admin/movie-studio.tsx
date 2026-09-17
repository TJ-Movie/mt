'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  ImagePlus,
  Loader2,
  Plus,
  Save,

  ShieldAlert,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import type { AdminMovie, AuditEvent } from '../../db';
function mediaLabel(movie: Pick<AdminMovie, 'availableQualities' | 'ingestStatus' | 'ingest_status'>): string {
  const count = qualityAssetCount(movie);
  if (count === 2 || movie.ingestStatus === 'ready') return 'READY';
  if (count === 1 || movie.ingestStatus?.toLowerCase() === 'half' || movie.ingest_status === 'half') return 'HALF';
  if (movie.ingest_status === 'flagged_for_review' || movie.ingest_status === 'skipped_unplayable') return 'FAILED';
  return 'QUEUED';
}

import type { RuntimeControls } from '../../lib/security/runtime-controls';
import {
  allLanguages,
  contentTypes,
  genres,
} from '../../lib/catalogue-options';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { NativeSelect, NativeSelectOption } from '../ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';

function qualityAssetCount(movie: Pick<AdminMovie, 'availableQualities'>): number {
  return new Set(movie.availableQualities ?? []).size;
}

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';
import { EpisodeBuilder } from './episode-builder';
import { CastBuilder } from './cast-builder';
import {
  applyRightsStatusChange,
  initializeRightsForm,
  RIGHTS_DEFAULT_REFERENCE,
  RIGHTS_DEFAULT_REVIEWER,
} from '../../lib/admin/rights-dates';
import {
  filterAndSortStudioMovies,
  isNewStudioMovie,
  studioMediaState,
  studioQualityState,
  studioSummary,
  type StudioFilters,
  type StudioSort,
} from '../../lib/admin/studio-view';

type EditorContext = {
  contentType: 'movie' | 'series';
  episodes: NonNullable<AdminMovie['episodes']>;
  setEpisodes: (episodes: NonNullable<AdminMovie['episodes']>) => void;
  cast: AdminMovie['cast'];
  setCast: (cast: AdminMovie['cast']) => void;
  uploadCastImage: (file: File, index: number) => Promise<void>;
  downloadStatus: 'available' | 'pending';
  setDownloadStatus: (status: 'available' | 'pending') => void;
};
const ContentTypeContext = createContext<EditorContext>({
  contentType: 'movie',
  episodes: [],
  setEpisodes: () => undefined,
  cast: [],
  setCast: () => undefined,
  uploadCastImage: async () => undefined,
  downloadStatus: 'pending',
  setDownloadStatus: () => undefined,
});

type DraftMovie = Omit<AdminMovie, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: number;
};
type FieldErrors = Record<string, string>;

function DownloadReadiness({ id, slug }: { id?: number; slug: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ transfer: string; blockers: string[]; eligible: boolean; note: string } | null>(null);
  const [error, setError] = useState('');
  async function check() {
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch(`/api/admin/movies/${id}/download-status`, { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json() as { error?: string; transfer?: unknown; blockers?: unknown; eligible?: unknown; note?: unknown };
      if (!response.ok) throw new Error(data.error || 'Check failed. Refresh your admin session and retry.');
      if (typeof data.transfer !== 'string' || !Array.isArray(data.blockers) || !data.blockers.every(x => typeof x === 'string') || typeof data.eligible !== 'boolean' || typeof data.note !== 'string') throw new Error('Invalid status response. Refresh and retry.');
      setResult({ transfer: data.transfer, blockers: data.blockers, eligible: data.eligible, note: data.note });
    } catch (err) { setError(err instanceof Error ? err.message : 'Check failed.'); }
    finally { setBusy(false); }
  }
  return <section className="rounded-xl border border-white/15 p-4 md:col-span-2" aria-label="Direct download readiness">
    <h3 className="font-medium">Direct download readiness</h3>
    <p className="mt-2 text-sm text-white/60">Save your changes first. This checks the saved rights, transfer, R2 video and Worker signing configuration.</p>
    <Button type="button" variant="outline" className="mt-3" disabled={!id || busy} onClick={check}>{busy ? 'Checking...' : 'Check saved download status'}</Button>
    <div aria-live="polite" className="mt-3 text-sm">
      {error && <p className="text-red-300">{error}</p>}
      {result && <><p>Transfer: {result.transfer}</p>
        <ul className="mt-2 list-disc pl-5 text-amber-200">{result.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
        <p className="mt-2 text-white/60">{result.note}</p>

        {result.eligible && <a className="mt-3 inline-block underline" href={`/api/download/resolve?slug=${encodeURIComponent(slug)}`} target="_blank" rel="noreferrer">Test direct download</a>}
      </>}
    </div>
  </section>;
}

function IngestionPanel({
  onMoviesRefreshed,
}: {
  onMoviesRefreshed: (movies: AdminMovie[]) => void;
}) {
  const [running, setRunning] = useState(false);
  const [imdbInput, setImdbInput] = useState('');
  const [failures, setFailures] = useState<Array<{ imdbId: string; error: string }>>([]);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function triggerIngestion() {
    const imdbIds = [...new Set(imdbInput.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
    if (imdbIds.some((id) => !/^tt\d{7,10}$/.test(id)) || imdbIds.length > 20) {
      setNotice({ tone: 'error', text: 'Enter up to 20 valid IMDb IDs, separated by commas or new lines.' });
      return;
    }
    setRunning(true);
    setFailures([]);
    setNotice({ tone: 'success', text: 'Ingestion in progress â€” fetching the YTS batch and securing torrent assetsâ€¦' });
    try {
      const response = await fetch('/api/admin/ingest/yts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-sublyra-action': 'admin-write',
        },
        body: JSON.stringify({ imdbIds }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : 'The ingestion request was rejected.';
        throw new Error(error);
      }
      const results = payload && typeof payload === 'object' && 'results' in payload && Array.isArray(payload.results)
        ? payload.results as Array<{ status?: unknown; imdbId?: unknown; error?: unknown }>
        : [];
      const queued = results.filter((result) => result.status === 'queued').length;
      const failed = results.length - queued;
      setFailures(results.filter((result) => result.status !== 'queued').map((result) => ({
        imdbId: typeof result.imdbId === 'string' ? result.imdbId : 'Unknown film',
        error: typeof result.error === 'string' ? result.error : 'No error details returned.',
      })));
      setNotice({
        tone: failed ? 'error' : 'success',
        text: failed
          ? `Ingestion finished: ${queued} queued, ${failed} failed. See the details below.`
          : `Ingestion complete: ${queued} movies queued for rights review.`,
      });
      const refreshed = await fetch('/api/admin/movies', { credentials: 'same-origin' });
      const refreshedPayload: unknown = await refreshed.json().catch(() => null);
      if (refreshed.ok && refreshedPayload && typeof refreshedPayload === 'object' && 'movies' in refreshedPayload && Array.isArray(refreshedPayload.movies)) {
        onMoviesRefreshed(refreshedPayload.movies as AdminMovie[]);
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The ingestion request failed.' });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-[#171916] p-6 sm:p-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-[#ef796d]">YTS batch</p>
          <h2 className="mt-2 font-serif text-2xl">Ingest movie metadata and torrents</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">
            Enter up to 20 IMDb IDs. The system resolves sources, acquires each quality independently, verifies R2/D1, and enriches only after media succeeds.
          </p>
        </div>
        <div className="flex w-full max-w-md flex-col gap-3">
          <label htmlFor="custom-imdb-ids" className="text-xs font-medium uppercase tracking-[.12em] text-white/55">IMDb / supported IDs</label>
          <Textarea id="custom-imdb-ids" value={imdbInput} onChange={(event) => setImdbInput(event.target.value)} placeholder="tt0111161, tt0068646" rows={2} disabled={running} />
          <p className="text-xs text-white/45">Optional Â· comma, space, or newline separated Â· maximum 20</p>
          <Button onClick={triggerIngestion} disabled={running} className="h-11 rounded-xl bg-[#ef796d] px-5 text-white disabled:opacity-60">
            {running ? <Loader2 className="animate-spin" /> : <UploadCloud />}
            {running ? 'Ingestingâ€¦' : 'Ingest Movies'}
          </Button>
        </div>
      </div>
      {running && (
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-white/10">
          <progress className="h-full w-full opacity-0" aria-label="YTS ingestion progress" />
          <div className="-mt-2 h-full w-1/3 animate-pulse rounded-full bg-[#ef796d]" />
        </div>
      )}
      {notice && (
        <output className={`mt-5 block rounded-xl border px-4 py-3 text-sm ${notice.tone === 'success' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/25 bg-rose-400/10 text-rose-200'}`}>
          {notice.text}
        </output>
      )}
      {failures.length > 0 && (
        <ul className="mt-4 space-y-2 text-sm text-rose-200" aria-label="Ingestion errors">
          {failures.map((failure, index) => (
            <li key={`${failure.imdbId}-${index}`} className="break-words">
              <span className="font-mono">{failure.imdbId}</span>: {failure.error}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const emptyMovie: DraftMovie = {
  streamingSources: [],
  downloadSources: [],
  episodes: [],
  revision: 1,
  slug: '',
  title: '',
  contentType: 'movie',
  tagline: '',
  description: '',
  year: new Date().getUTCFullYear(),
  runtime: '1h 30m',
  rating: 0,
  genre: 'Drama',
  director: '',
  cast: [],
  languages: ['English'],
  poster: '/og.png',
  backdrop: '/og.png',
  featured: false,
  publicationStatus: 'draft',
  rightsStatus: 'pending',
  rightsVerifiedAt: undefined,
  rightsExpiresAt: undefined,
  rightsReviewer: RIGHTS_DEFAULT_REVIEWER,
  rightsReference: RIGHTS_DEFAULT_REFERENCE,
  officialWatchUrl: undefined,
  telegramUrl: undefined,
  telegramChannel: undefined,
  subtitleUrl: undefined,
  downloadStatus: 'pending',
};
function draftFor(source: DraftMovie): DraftMovie {
  const initialized = initializeRightsForm(source);
  return {
    ...initialized,
    cast: [...initialized.cast],
    languages: [...initialized.languages],
  };
}

function localDate(value?: string): string {
  return value ? value.slice(0, 10) : '';
}
function isoDate(value: string): string | undefined {
  return value ? `${value}T12:00:00.000Z` : undefined;
}
function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

const DEFAULT_STUDIO_FILTERS: StudioFilters = { publication: 'all', media: 'all', rights: 'all', review: 'all' };

function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const tones = {
    neutral: 'border-white/12 bg-white/[.06] text-white/70',
    success: 'border-emerald-300/20 bg-emerald-400/10 text-emerald-200',
    warning: 'border-amber-300/20 bg-amber-400/10 text-amber-200',
    danger: 'border-red-300/20 bg-red-400/10 text-red-200',
  };
  return <span className={'rounded-full border px-2 py-1 text-[11px] font-medium tracking-wide ' + tones[tone]}>{label}</span>;
}
export function MovieStudio({
  initialMovies,
  initialAuditEvents,
  controls,
}: {
  initialMovies: AdminMovie[];
  initialAuditEvents: AuditEvent[];
  controls: RuntimeControls;
}) {
  const [movies, setMovies] = useState(initialMovies);
  const [selectedId, setSelectedId] = useState<number | 'new'>(
    initialMovies[0]?.id ?? 'new',
  );
  const selected = useMemo(
    () =>
      selectedId === 'new'
        ? emptyMovie
        : (movies.find((movie) => movie.id === selectedId) ?? emptyMovie),
    [movies, selectedId],
  );
  const [draft, setDraft] = useState<DraftMovie>(() => draftFor(selected));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<StudioFilters>(DEFAULT_STUDIO_FILTERS);
  const [sort, setSort] = useState<StudioSort>('newest');
  const snapshot = useMemo(() => draftFor(selected), [selected]);
  const visibleMovies = useMemo(
    () => filterAndSortStudioMovies(movies, search, filters, sort),
    [movies, search, filters, sort],
  );
  const summary = useMemo(() => studioSummary(movies), [movies]);
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(snapshot);

  function choose(movie: AdminMovie | null) {
    setSelectedId(movie?.id ?? 'new');
    const source = movie ?? emptyMovie;
    setDraft(draftFor(source));
    setMessage(null);
    setErrors({});
  }

  function update<K extends keyof DraftMovie>(key: K, value: DraftMovie[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    setErrors({});
    const payload = {
      ...draft,
      rightsVerifiedAt: nullable(draft.rightsVerifiedAt ?? ''),
      rightsExpiresAt: nullable(draft.rightsExpiresAt ?? ''),
      rightsReviewer: nullable(draft.rightsReviewer ?? ''),
      rightsReference: nullable(draft.rightsReference ?? ''),
      officialWatchUrl: nullable(draft.officialWatchUrl ?? ''),
      telegramUrl: nullable(draft.telegramUrl ?? ''),
      telegramChannel: nullable(draft.telegramChannel ?? ''),
      subtitleUrl: nullable(draft.subtitleUrl ?? ''),
    };
    const creating = selectedId === 'new';
    const response = await fetch(
      creating ? '/api/admin/movies' : `/api/admin/movies/${selectedId}`,
      {
        method: creating ? 'POST' : 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Sublyra-Action': 'admin-write',
        },
        body: JSON.stringify(
          creating ? payload : { revision: draft.revision, movie: payload },
        ),
      },
    ).catch(() => null);
    const result = response
      ? ((await response.json().catch(() => ({}))) as { error?: string })
      : {};
    if (!response?.ok) {
      setErrors((result as { fields?: FieldErrors }).fields ?? {});
      setMessage({
        tone: 'error',
        text: result.error ?? 'Save failed. Please try again.',
      });
      setBusy(false);
      return;
    }
    setMessage({
      tone: 'success',
      text: creating ? 'Movie created safely.' : 'Changes saved.',
    });
    window.location.reload();
  }

  async function archive() {
    if (selectedId === 'new') return;
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/admin/movies/${selectedId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Sublyra-Action': 'admin-write',
      },
      body: JSON.stringify({ revision: draft.revision }),
    }).catch(() => null);
    if (!response?.ok) {
      const result = response
        ? ((await response.json().catch(() => ({}))) as { error?: string })
        : {};
      setMessage({ tone: 'error', text: result.error ?? 'Archive failed.' });
      setBusy(false);
      return;
    }
    setMovies((items) => items.filter((movie) => movie.id !== selectedId));
    choose(null);
    setBusy(false);
    setMessage({
      tone: 'success',
      text: 'Movie archived and removed from the public catalogue.',
    });
  }

  async function permanentlyDelete() {
    if (selectedId === 'new' || draft.publicationStatus !== 'archived') return;
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/admin/movies/${selectedId}`, {
      method: 'DELETE', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Sublyra-Action': 'admin-write' },
      body: JSON.stringify({ action: 'delete', revision: draft.revision }),
    }).catch(() => null);
    if (!response?.ok) {
      const result = response ? ((await response.json().catch(() => ({}))) as { error?: string }) : {};
      setMessage({ tone: 'error', text: result.error ?? 'Delete failed.' }); setBusy(false); return;
    }
    setMovies((items) => items.filter((movie) => movie.id !== selectedId));
    choose(null); setBusy(false);
    setMessage({ tone: 'success', text: 'Archived movie permanently deleted.' });
  }

  async function upload(
    file: File | undefined,
    field: 'poster' | 'backdrop' | 'subtitleUrl' | 'castImage',
  ): Promise<string | undefined> {
    if (!file) return undefined;
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.set('file', file);
    if (field === 'subtitleUrl') form.set('kind', 'subtitle');
    const response = await fetch('/api/admin/assets', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Sublyra-Action': 'admin-write' },
      body: form,
    }).catch(() => null);
    const result = response
      ? ((await response.json().catch(() => ({}))) as {
          error?: string;
          path?: string;
        })
      : {};
    if (!response?.ok || !result.path)
      setMessage({ tone: 'error', text: result.error ?? 'Upload failed.' });
    else {
      if (field !== 'castImage') update(field, result.path);
      setMessage({
        tone: 'success',
        text: `${field === 'poster' ? 'Poster' : field === 'backdrop' ? 'Backdrop' : field === 'castImage' ? 'Profile image' : 'Subtitle file'} uploaded.`,
      });
    }
    setBusy(false);
    return response?.ok ? result.path : undefined;
  }

  async function uploadCastImage(file: File, index: number) {
    const path = await upload(file, 'castImage');
    if (!path) return;
    setDraft((current) => ({
      ...current,
      cast: current.cast.map((member, itemIndex) =>
        itemIndex === index
          ? {
              ...(typeof member === 'string' ? { actor: member } : member),
              image: path,
            }
          : member,
      ),
    }));
  }

  return (
    <ContentTypeContext.Provider
      value={{
        contentType: draft.contentType ?? 'movie',
        episodes: draft.episodes ?? [],
        setEpisodes: (episodes) => update('episodes', episodes),
        cast: draft.cast,
        setCast: (cast) => update('cast', cast),
        uploadCastImage,
        downloadStatus:
          draft.downloadStatus ??
          ((draft.downloadSources?.length ?? 0) > 0 ? 'available' : 'pending'),
        setDownloadStatus: (status) => update('downloadStatus', status),
      }}
    >
      <div className="mx-auto max-w-[1500px] px-4 py-8 sm:px-8 lg:px-12">
        <div className="mb-7 grid gap-3 sm:grid-cols-3">
          <StatusCard
            label="External links"
            active={controls.externalLinksEnabled}
          />
          <StatusCard label="Advertisements" active={controls.adsEnabled} />
          <div className="rounded-2xl border border-white/10 bg-white/[.035] p-4">
            <p className="text-xs uppercase tracking-[.18em] text-white/35">
              Records
            </p>
            <p className="mt-2 font-serif text-2xl">{movies.length} movies</p>
          </div>
        </div>
        <Tabs defaultValue="catalogue">
          <TabsList className="bg-white/[.06] text-white/50">
            <TabsTrigger
              value="catalogue"
              className="px-4 text-white/55 data-active:bg-white/10 data-active:text-white"
            >
              Catalogue
            </TabsTrigger>
            <TabsTrigger
              value="audit"
              className="px-4 text-white/55 data-active:bg-white/10 data-active:text-white"
            >
              Audit trail
            </TabsTrigger>
            <TabsTrigger
              value="ingestion"
              className="px-4 text-white/55 data-active:bg-white/10 data-active:text-white"
            >
              Ingestion
            </TabsTrigger>
          </TabsList>
          <TabsContent value="catalogue" className="mt-6">
            <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
              <aside className="rounded-2xl border border-white/10 bg-white/[.035] p-4">
                <Button
                  onClick={() => choose(null)}
                  className="h-11 w-full rounded-xl bg-[#ef796d] text-white"
                >
                  <Plus /> Add movie
                </Button>
                <label htmlFor="studio-movie-search" className="mt-3 block">
                  <span className="sr-only">Search movies</span>
                  <Input id="studio-movie-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, slug, IMDb ID or D1 ID" aria-label="Search movies" />
                </label>                <div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
                  <NativeSelect aria-label="Publication filter" value={filters.publication} onChange={(event) => setFilters((current) => ({ ...current, publication: event.target.value as StudioFilters['publication'] }))} className="w-full">
                    <NativeSelectOption value="all">All publication</NativeSelectOption>
                    <NativeSelectOption value="draft">Draft</NativeSelectOption>
                    <NativeSelectOption value="published">Published</NativeSelectOption>
                    <NativeSelectOption value="archived">Archived</NativeSelectOption>
                  </NativeSelect>
                  <NativeSelect aria-label="Media filter" value={filters.media} onChange={(event) => setFilters((current) => ({ ...current, media: event.target.value as StudioFilters['media'] }))} className="w-full">
                    <NativeSelectOption value="all">All media</NativeSelectOption>
                    <NativeSelectOption value="ready">Ready</NativeSelectOption>
                    <NativeSelectOption value="half">Half</NativeSelectOption>
                    <NativeSelectOption value="queued">Queued</NativeSelectOption>
                    <NativeSelectOption value="failed">Failed / unavailable</NativeSelectOption>
                  </NativeSelect>
                  <NativeSelect aria-label="Rights filter" value={filters.rights} onChange={(event) => setFilters((current) => ({ ...current, rights: event.target.value as StudioFilters['rights'] }))} className="w-full">
                    <NativeSelectOption value="all">All rights</NativeSelectOption>
                    <NativeSelectOption value="pending">Rights pending</NativeSelectOption>
                    <NativeSelectOption value="verified">Rights verified</NativeSelectOption>
                  </NativeSelect>
                  <NativeSelect aria-label="Review filter" value={filters.review} onChange={(event) => setFilters((current) => ({ ...current, review: event.target.value as StudioFilters['review'] }))} className="w-full">
                    <NativeSelectOption value="all">All review</NativeSelectOption>
                    <NativeSelectOption value="ready">Ready for review</NativeSelectOption>
                    <NativeSelectOption value="needs-review">Needs review / incomplete</NativeSelectOption>
                  </NativeSelect>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <NativeSelect aria-label="Movie sort" value={sort} onChange={(event) => setSort(event.target.value as StudioSort)} className="min-w-0 flex-1">
                    <NativeSelectOption value="newest">Newest first</NativeSelectOption>
                    <NativeSelectOption value="oldest">Oldest first</NativeSelectOption>
                    <NativeSelectOption value="title-asc">Title A-Z</NativeSelectOption>
                    <NativeSelectOption value="title-desc">Title Z-A</NativeSelectOption>
                    <NativeSelectOption value="updated">Recently updated</NativeSelectOption>
                  </NativeSelect>
                  <Button type="button" variant="ghost" className="shrink-0 px-2 text-xs text-white/60" onClick={() => { setSearch(''); setFilters(DEFAULT_STUDIO_FILTERS); setSort('newest'); }}>
                    Reset
                  </Button>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5 text-xs text-white/55" aria-label="Catalogue counts">
                  <span>{summary.total} Movies</span>
                  <span>·</span><span>{summary.published} Published</span>
                  <span>·</span><span>{summary.draft} Draft</span>
                  <span>·</span><span>{summary.ready} Ready</span>
                  <span>·</span><span>{summary.half} Half</span>
                  <span>·</span><span>{summary.failed} Failed</span>
                </div>
                <p className="mt-2 text-xs text-white/40" aria-live="polite">
                  {visibleMovies.length === movies.length ? 'Showing all movies' : ('Showing ' + visibleMovies.length + ' of ' + movies.length + ' movies')}
                </p>
                <div className="mt-3 max-h-[calc(100vh-20rem)] space-y-2 overflow-y-auto pr-1">
                  {visibleMovies.map((movie) => (
                    <button
                      type="button"
                      key={movie.id}
                      onClick={() => choose(movie)}
                      className={'w-full rounded-xl border p-4 text-left transition ' + (selectedId === movie.id ? 'border-[#ef796d]/70 bg-[#ef796d]/10' : 'border-white/8 bg-black/10 hover:border-white/20')}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-serif text-lg">{movie.title}</p>
                          <p className="mt-1 truncate text-xs text-white/40">
                            {movie.year || '—'} · ID {movie.id} · {movie.imdbId ?? 'IMDb unavailable'}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                          {isNewStudioMovie(movie) && <StatusChip label="NEW" tone="success" />}
                          <StatusChip label={movie.publicationStatus.toUpperCase()} tone={movie.publicationStatus === 'published' ? 'success' : movie.publicationStatus === 'archived' ? 'danger' : 'neutral'} />
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <StatusChip label={mediaLabel(movie)} tone={studioMediaState(movie) === 'ready' ? 'success' : studioMediaState(movie) === 'half' ? 'warning' : studioMediaState(movie) === 'failed' ? 'danger' : 'neutral'} />
                        <StatusChip label={movie.rightsStatus === 'verified' ? 'RIGHTS VERIFIED' : 'RIGHTS PENDING'} tone={movie.rightsStatus === 'verified' ? 'success' : 'warning'} />
                        <StatusChip label={'720 ' + (studioQualityState(movie, '720p') === 'verified' ? '✓' : '✕')} tone={studioQualityState(movie, '720p') === 'verified' ? 'success' : 'neutral'} />
                        <StatusChip label={'1080 ' + (studioQualityState(movie, '1080p') === 'verified' ? '✓' : '✕')} tone={studioQualityState(movie, '1080p') === 'verified' ? 'success' : 'neutral'} />
                      </div>
                      <p className="mt-3 truncate text-xs text-white/35">{movie.slug}</p>
                    </button>
                  ))}
                  {visibleMovies.length === 0 && <p className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-white/45">No movies match these filters.</p>}
                </div>
              </aside>
              <section className="rounded-2xl border border-white/10 bg-[#171916] p-5 sm:p-7 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto">
                <div className="sticky top-0 z-20 -mx-5 -mt-5 flex flex-col gap-4 border-b border-white/10 bg-[#171916]/95 px-5 pb-5 pt-5 backdrop-blur sm:-mx-7 sm:-mt-7 sm:flex-row sm:items-center sm:justify-between sm:px-7 sm:pt-7">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[.2em] text-[#ef796d]">
                      {selectedId === 'new' ? 'New record' : 'Editing record'}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <h1 className="truncate font-serif text-3xl">
                        {draft.title || 'Untitled film'}
                      </h1>
                      <StatusChip label={mediaLabel(draft)} tone={studioMediaState(draft) === 'ready' ? 'success' : studioMediaState(draft) === 'half' ? 'warning' : studioMediaState(draft) === 'failed' ? 'danger' : 'neutral'} />
                      <StatusChip label={draft.rightsStatus === 'verified' ? 'RIGHTS VERIFIED' : 'RIGHTS PENDING'} tone={draft.rightsStatus === 'verified' ? 'success' : 'warning'} />
                      {hasUnsavedChanges && <StatusChip label="UNSAVED CHANGES" tone="warning" />}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={save}
                      className="h-10 rounded-full bg-[#ef796d] px-5 text-white"
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <Save />}{' '}
                      Save
                    </Button>
                    {selectedId !== 'new' && draft.publicationStatus !== 'archived' && (
                      <AlertDialog>
                        <AlertDialogTrigger
                          render={
                            <Button
                              disabled={busy}
                              variant="destructive"
                              className="h-10 rounded-full px-4"
                            />
                          }
                        >
                          <Archive /> Archive
                        </AlertDialogTrigger>
                        <AlertDialogContent className="border border-white/10 bg-[#f2efe9] text-[#181916]">
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              Archive this movie?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              It will immediately disappear from the public
                              catalogue. The audit record remains.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={archive}
                              className="bg-[#b43a2e] text-white"
                            >
                              Archive
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    {selectedId !== 'new' && draft.publicationStatus === 'archived' && (
                      <AlertDialog>
                        <AlertDialogTrigger render={<Button disabled={busy} variant="destructive" className="h-10 rounded-full px-4" />}><Trash2 /> Delete</AlertDialogTrigger>
                        <AlertDialogContent className="border border-white/10 bg-[#f2efe9] text-[#181916]">
                          <AlertDialogHeader><AlertDialogTitle>Delete archived movie permanently?</AlertDialogTitle><AlertDialogDescription>This cannot be undone. Archived records are the only records eligible for deletion.</AlertDialogDescription></AlertDialogHeader>
                          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={permanentlyDelete} className="bg-[#b43a2e] text-white">Delete permanently</AlertDialogAction></AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
                {message && (
                  <div
                    className={`mt-5 rounded-xl border px-4 py-3 text-sm ${message.tone === 'success' ? 'border-emerald-400/20 bg-emerald-400/8 text-emerald-200' : 'border-red-400/20 bg-red-400/8 text-red-200'}`}
                  >
                    <div className="flex items-center gap-2">
                      {message.tone === 'success' ? (
                        <CheckCircle2 />
                      ) : (
                        <ShieldAlert />
                      )}
                      {message.text}
                    </div>
                    {Object.keys(errors).length > 0 && (
                      <ul className="mt-3 list-disc space-y-1 pl-6 text-red-200/80">
                        {Object.entries(errors).map(([field, error]) => (
                          <li key={field}>
                            <span className="font-semibold">
                              {fieldLabel(field)}:
                            </span>{' '}
                            {error}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <nav className="sticky top-[5.5rem] z-10 -mx-1 mb-4 flex gap-1 overflow-x-auto rounded-xl border border-white/8 bg-[#171916]/90 p-1 backdrop-blur" aria-label="Editor sections">
                  <a href="#studio-overview" className="whitespace-nowrap rounded-lg px-3 py-2 text-xs text-white/65 hover:bg-white/8 hover:text-white">Overview</a>
                  <a href="#studio-rights-artwork" className="whitespace-nowrap rounded-lg px-3 py-2 text-xs text-white/65 hover:bg-white/8 hover:text-white">Rights & artwork</a>
                  <a href="#studio-technical" className="whitespace-nowrap rounded-lg px-3 py-2 text-xs text-white/65 hover:bg-white/8 hover:text-white">Advanced / technical</a>
                </nav>
                <section id="studio-overview" className="scroll-mt-28">
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-[.16em] text-white/45">Overview & cast</h2>
                <div className="mt-6 grid gap-5 md:grid-cols-2">
                  <Field label="Title">
                    <Input
                      maxLength={160}
                      value={draft.title}
                      onChange={(e) => update('title', e.target.value)}
                    />
                  </Field>
                  <Field label="Slug">
                    <Input
                      maxLength={80}
                      value={draft.slug}
                      onChange={(e) =>
                        update('slug', e.target.value.toLowerCase())
                      }
                    />
                  </Field>
                  <Field label="Tagline" wide>
                    <Input
                      maxLength={200}
                      value={draft.tagline}
                      onChange={(e) => update('tagline', e.target.value)}
                    />
                  </Field>
                  <Field label="Description" wide>
                    <Textarea
                      maxLength={2000}
                      value={draft.description}
                      onChange={(e) => update('description', e.target.value)}
                      className="min-h-28"
                    />
                  </Field>
                  <Field label="Release year">
                    <Input
                      type="number"
                      min={1888}
                      max={new Date().getUTCFullYear() + 5}
                      value={draft.year}
                      onChange={(e) => update('year', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Rating (0-10)">
                    <Input
                      type="number"
                      min={0}
                      max={10}
                      step="0.1"
                      value={draft.rating}
                      onChange={(e) => update('rating', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Runtime">
                    <Input
                      maxLength={30}
                      value={draft.runtime}
                      onChange={(e) => update('runtime', e.target.value)}
                    />
                  </Field>
                  <Field label="Genre">
                    <NativeSelect
                      value={draft.genre}
                      onChange={(e) => update('genre', e.target.value)}
                      className="w-full"
                    >
                      {genres
                        .filter((genre) => genre !== 'All')
                        .map((genre) => (
                          <NativeSelectOption key={genre} value={genre}>
                            {genre}
                          </NativeSelectOption>
                        ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Director">
                    <Input
                      maxLength={160}
                      value={draft.director}
                      onChange={(e) => update('director', e.target.value)}
                    />
                  </Field>
                  <Field label="Cast (comma separated)">
                    <Input
                      value={draft.cast
                        .map((member) =>
                          typeof member === 'string' ? member : member.actor,
                        )
                        .join(', ')}
                      onChange={(e) =>
                        update(
                          'cast',
                          e.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                  </Field>
                  <div id="studio-rights-artwork" className="md:col-span-2 border-t border-white/10 pt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[.16em] text-white/45">Rights & publishing</h3>
                  </div>
                  <Field label="Publication">
                    <NativeSelect
                      value={draft.publicationStatus}
                      onChange={(e) =>
                        update(
                          'publicationStatus',
                          e.target.value as DraftMovie['publicationStatus'],
                        )
                      }
                      className="w-full"
                    >
                      <NativeSelectOption value="draft">
                        Draft
                      </NativeSelectOption>
                      <NativeSelectOption value="published">
                        Published
                      </NativeSelectOption>
                      <NativeSelectOption value="archived">
                        Archived
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <Field label="Rights status">
                    <NativeSelect
                      aria-label="Rights status"
                      value={draft.rightsStatus}
                      onChange={e => {
                        const nextStatus = e.target.value as DraftMovie['rightsStatus'];
                        setDraft(current => applyRightsStatusChange(current, nextStatus));
                      }}
                      className="w-full"
                    >
                      <NativeSelectOption value="pending">Pending review</NativeSelectOption>
                      <NativeSelectOption value="verified">Verified</NativeSelectOption>
                      <NativeSelectOption value="blocked">Blocked</NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <Field label="Rights reviewer">
                    <Input aria-label="Rights reviewer" maxLength={120} value={draft.rightsReviewer ?? ''} onChange={e => update('rightsReviewer', e.target.value)} placeholder="Name or email of the person approving distribution" />
                  </Field>
                  <Field label="Rights evidence reference" wide>
                    <Input aria-label="Rights evidence reference" maxLength={160} value={draft.rightsReference ?? ''} onChange={e => update('rightsReference', e.target.value)} placeholder="Your license, agreement or ownership evidence reference" />
                  </Field>
                  <Field label="Rights verified at (UTC)">
                    <Input aria-label="Rights verified at (UTC)" type="datetime-local" step="1" value={draft.rightsVerifiedAt?.slice(0, 19) ?? ''} onChange={e => update('rightsVerifiedAt', e.target.value ? new Date(e.target.value + 'Z').toISOString() : undefined)} />
                    <Button type="button" variant="outline" className="mt-2" onClick={() => update('rightsVerifiedAt', new Date().toISOString())}>Set verification time to now</Button>
                  </Field>
                  <Field label="Rights expires at (12:00 UTC)">
                    <Input
                      type="date"
                      value={localDate(draft.rightsExpiresAt)}
                      onChange={(e) =>
                        update('rightsExpiresAt', isoDate(e.target.value))
                      }
                    />
                  </Field>
                  <p className="text-sm text-white/60 md:col-span-2">Only select Verified after reviewing distribution rights. Reviewer, evidence, verification time and future expiry are required. Changing an approved delivery source or evidence requires saving Pending first, then reviewing and verifying again.</p>
                  <DownloadReadiness key={`${selectedId}-${draft.revision}`} id={draft.id} slug={selected.slug} />
                  <Field label="Official YouTube URL" wide>
                    <Input
                      maxLength={500}
                      value={draft.officialWatchUrl ?? ''}
                      onChange={(e) =>
                        update('officialWatchUrl', e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Telegram URL">
                    <Input
                      maxLength={500}
                      value={draft.telegramUrl ?? ''}
                      onChange={(e) => update('telegramUrl', e.target.value)}
                    />
                  </Field>
                  <Field label="Telegram channel">
                    <Input
                      maxLength={32}
                      value={draft.telegramChannel ?? ''}
                      onChange={(e) =>
                        update('telegramChannel', e.target.value)
                      }
                    />
                  </Field>
                  <div className="md:col-span-2 border-t border-white/10 pt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[.16em] text-white/45">Artwork</h3>
                  </div>
                  <div className="md:col-span-2 border-t border-white/10 pt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[.16em] text-white/45">Artwork</h3>
                  </div>
                  <UploadField
                    label="Poster"
                    value={draft.poster}
                    accept="image/jpeg,image/png"
                    onUpload={(file) => upload(file, 'poster')}
                  />
                  <UploadField
                    label="Backdrop"
                    value={draft.backdrop}
                    accept="image/jpeg,image/png"
                    onUpload={(file) => upload(file, 'backdrop')}
                  />
                  <UploadField
                    label="Subtitle ZIP / 7Z / SRT / VTT"
                    value={draft.subtitleUrl ?? ''}
                    accept=".zip,.7z,.srt,.vtt,application/zip,application/x-7z-compressed,text/plain,text/vtt"
                    onUpload={(file) => upload(file, 'subtitleUrl')}
                  />
                  <label className="flex items-center gap-3 text-sm text-white/65">
                    <input
                      type="checkbox"
                      checked={draft.featured}
                      onChange={(e) => update('featured', e.target.checked)}
                      className="size-4 accent-[#ef796d]"
                    />{' '}
                    Featured content
                  </label>
                  <Field label="Subtitle languages" wide>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {allLanguages.map((language) => (
                        <label
                          key={language}
                          className="flex items-center gap-2 rounded-lg border border-white/8 px-3 py-2 text-sm text-white/60"
                        >
                          <input
                            type="checkbox"
                            checked={draft.languages.includes(language)}
                            onChange={(e) =>
                              update(
                                'languages',
                                e.target.checked
                                  ? [...draft.languages, language]
                                  : draft.languages.filter(
                                      (item) => item !== language,
                                    ),
                              )
                            }
                            className="accent-[#ef796d]"
                          />
                          {language}
                        </label>
                      ))}
                    </div>
                  </Field>
                </div>
                </section>
                <section id="studio-technical" className="scroll-mt-28">
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-[.16em] text-white/45">Content & technical</h2>
                <div className="mt-5 grid gap-5 border-t border-white/10 pt-5 md:grid-cols-2">
                  <Field label="Content type">
                    <NativeSelect
                      value={draft.contentType ?? 'movie'}
                      onChange={(e) =>
                        update(
                          'contentType',
                          e.target.value as DraftMovie['contentType'],
                        )
                      }
                      className="w-full"
                    >
                      {contentTypes.map((type) => (
                        <NativeSelectOption key={type} value={type}>
                          {type === 'series' ? 'TV Series' : 'Movie'}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Multiple categories">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {genres
                        .filter((genre) => genre !== 'All')
                        .map((genre) => {
                          const selectedGenres = draft.genre
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean);
                          return (
                            <label
                              key={genre}
                              className="flex items-center gap-2 rounded-lg border border-white/8 px-3 py-2 text-sm text-white/60"
                            >
                              <input
                                type="checkbox"
                                checked={selectedGenres.includes(genre)}
                                onChange={(e) =>
                                  update(
                                    'genre',
                                    e.target.checked
                                      ? [
                                          ...new Set([
                                            ...selectedGenres,
                                            genre,
                                          ]),
                                        ].join(', ')
                                      : selectedGenres
                                          .filter((item) => item !== genre)
                                          .join(', '),
                                  )
                                }
                                className="accent-[#ef796d]"
                              />
                              {genre}
                            </label>
                          );
                        })}
                    </div>
                  </Field>
                </div>
                </section>
                <section id="studio-sources" className="scroll-mt-28">
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-[.16em] text-white/45">Sources & diagnostics</h2>
                <div className="mt-5 space-y-5 border-t border-white/10 pt-5">
                  <Field
                    label="Series episodes (one per line: S01E01 | Episode title | optional URL)"
                    wide
                  >
                    <Textarea
                      value={(draft.episodes ?? [])
                        .map(
                          (episode) =>
                            `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')} | ${episode.title} | ${episode.url ?? ''}`,
                        )
                        .join('\n')}
                      onChange={(e) =>
                        update(
                          'episodes',
                          e.target.value
                            .split('\n')
                            .map((line) => {
                              const [code, title, url] = line
                                .split('|')
                                .map((item) => item.trim());
                              const match = /^S(\d+)E(\d+)$/i.exec(code ?? '');
                              return match && title
                                ? {
                                    season: Number(match[1]),
                                    episode: Number(match[2]),
                                    title,
                                    url: url || undefined,
                                  }
                                : null;
                            })
                            .filter(Boolean) as DraftMovie['episodes'],
                        )
                      }
                      placeholder={
                        'S01E01 | Pilot | https://source.example/episode-1\nS01E02 | The second signal | https://source.example/episode-2'
                      }
                      className="min-h-32"
                    />
                  </Field>
                  <Field
                    label="Streaming servers (one per line: Label | Embed URL)"
                    wide
                  >
                    <Textarea
                      value={(draft.streamingSources ?? [])
                        .map((source) => `${source.label} | ${source.url}`)
                        .join('\n')}
                      onChange={(e) =>
                        update(
                          'streamingSources',
                          e.target.value
                            .split('\n')
                            .map((line) => {
                              const [label, ...url] = line.split('|');
                              return {
                                label: (label ?? '').trim(),
                                url: url.join('|').trim(),
                              };
                            })
                            .filter((source) => source.label || source.url),
                        )
                      }
                      placeholder="Server 1 | https://player.example.com/embed/123"
                      className="min-h-24"
                    />
                  </Field>
                  <Field
                    label="Download options (URL alone, or Label | Quality | Resolution | Size | URL)"
                    wide
                  >
                    <Textarea
                      value={(draft.downloadSources ?? [])
                        .map(
                          (source) =>
                            `${source.label} | ${source.quality} | ${source.resolution} | ${source.size} | ${source.url}`,
                        )
                        .join('\n')}
                      onChange={(e) =>
                        update(
                          'downloadSources',
                          e.target.value
                            .split('\n')
                            .map((line, index) => {
                              const parts = line
                                .split('|')
                                .map((item) => item.trim());
                              if (
                                parts.length === 1 &&
                                /^https:\/\//i.test(parts[0] ?? '')
                              )
                                return {
                                  label: `Download ${index + 1}`,
                                  quality: 'Standard',
                                  resolution: 'Auto',
                                  size: 'Unknown',
                                  url: parts[0],
                                };
                              const [label, quality, resolution, size, ...url] =
                                parts;
                              return {
                                label: label ?? '',
                                quality: quality ?? '',
                                resolution: resolution ?? '',
                                size: size ?? '',
                                url: url.join('|'),
                              };
                            })
                            .filter((source) => source.url),
                        )
                      }
                      placeholder={
                        'https://pixeldrain.com/u/example\nDirect 2 | WEB-DL | 1080p | 2.4 GB | https://doodstream.com/d/example'
                      }
                      className="min-h-28"
                    />
                  </Field>
                </div>
                  </section>

              </section>
            </div>
          </TabsContent>
          <TabsContent value="ingestion" className="mt-6">
            <IngestionPanel onMoviesRefreshed={(nextMovies) => {
              setMovies(nextMovies);
              if (selectedId !== 'new' && !nextMovies.some((movie) => movie.id === selectedId)) choose(null);
            }} />
          </TabsContent>
          <TabsContent
            value="audit"
            className="mt-6 rounded-2xl border border-white/10 bg-white/[.035] p-4 sm:p-6"
          >
            <Table>
              <TableHeader>
                <TableRow className="border-white/10">
                  <TableHead className="text-white/45">Time</TableHead>
                  <TableHead className="text-white/45">Action</TableHead>
                  <TableHead className="text-white/45">Movie</TableHead>
                  <TableHead className="text-white/45">Editor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {initialAuditEvents.map((event) => (
                  <TableRow
                    key={event.id}
                    className="border-white/8 hover:bg-white/[.03]"
                  >
                    <TableCell className="text-white/45">
                      {new Date(event.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{event.action}</TableCell>
                    <TableCell>{event.movieSlug ?? 'â€”'}</TableCell>
                    <TableCell className="text-white/45">
                      {event.actorEmail}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
        <div className="mx-auto mt-6 max-w-md">
          <DownloadStatusField />
        </div>
      </div>
    </ContentTypeContext.Provider>
  );
}

function StatusCard({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[.035] p-4">
      <p className="text-xs uppercase tracking-[.18em] text-white/35">
        {label}
      </p>
      <p
        className={`mt-2 flex items-center gap-2 font-serif text-2xl ${active ? 'text-amber-200' : 'text-emerald-300'}`}
      >
        <span
          className={`size-2 rounded-full ${active ? 'bg-amber-300' : 'bg-emerald-300'}`}
        />
        {active ? 'Enabled' : 'Safe-disabled'}
      </p>
    </div>
  );
}
function DownloadStatusField() {
  const context = useContext(ContentTypeContext);
  const available = context.downloadStatus === 'available';
  return (
    <section className="mb-6 rounded-2xl border border-[#ef796d]/30 bg-[#ef796d]/[.08] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.2em] text-[#ef796d]">
            Download controls
          </p>
          <h2 className="mt-1 text-xl font-semibold text-white">
            {available ? 'Downloads available' : 'Downloads pending'}
          </h2>
          <p className="mt-1 text-sm text-white/55">
            Choose whether the public Download button opens the gateway or stays
            disabled.
          </p>
        </div>
        <NativeSelect
          aria-label="Download status"
          value={context.downloadStatus}
          onChange={(event) =>
            context.setDownloadStatus(
              event.target.value as 'available' | 'pending',
            )
          }
          className="h-11 w-full border-white/20 bg-black/30 text-white sm:w-72"
        >
          <NativeSelectOption value="available">Available</NativeSelectOption>
          <NativeSelectOption value="pending">
            Download Pending / Coming Soon
          </NativeSelectOption>
        </NativeSelect>
      </div>
    </section>
  );
}
function fieldLabel(field: string): string {
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (value) => value.toUpperCase());
}
function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const context = useContext(ContentTypeContext);
  const isEpisode = label.startsWith('Series episodes');
  const isCast = label.startsWith('Cast');
  const isMovieOnly =
    label.startsWith('Streaming servers') ||
    label.startsWith('Download options');
  if (
    (isEpisode && context.contentType !== 'series') ||
    (isMovieOnly && context.contentType === 'series')
  )
    return null;
  const content = isEpisode ? (
    <EpisodeBuilder
      episodes={context.episodes}
      onChange={context.setEpisodes}
    />
  ) : isCast ? (
    <CastBuilder
      cast={context.cast}
      onChange={context.setCast}
      onUpload={context.uploadCastImage}
    />
  ) : (
    children
  );
  return (
    <label className={wide ? 'md:col-span-2' : ''}>
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[.14em] text-white/40">
        {label}
      </span>
      <div className="[&_input]:h-10 [&_input]:border-white/12 [&_input]:bg-black/15 [&_input]:text-white [&_textarea]:border-white/12 [&_textarea]:bg-black/15 [&_textarea]:text-white [&_select]:h-10 [&_select]:border-white/12 [&_select]:bg-black/15 [&_select]:text-white">
        {content}
      </div>
    </label>
  );
}
function UploadField({
  label,
  value,
  accept,
  onUpload,
}: {
  label: string;
  value: string;
  accept: string;
  onUpload: (file?: File) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input readOnly value={value} />
        <Button
          type="button"
          variant="outline"
          className="relative h-10 shrink-0 overflow-hidden border-white/15 bg-transparent text-white"
        >
          <ImagePlus /> Upload
          <input
            type="file"
            accept={accept}
            onChange={(event) => {
              onUpload(event.target.files?.[0]);
              event.target.value = '';
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label={`Upload ${label.toLowerCase()}`}
          />
        </Button>
      </div>
    </Field>
  );
}

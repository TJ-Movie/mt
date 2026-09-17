import type { AdminMovie } from '../../db';

export type StudioPublicationFilter = 'all' | 'draft' | 'published' | 'archived';
export type StudioMediaFilter = 'all' | 'ready' | 'half' | 'queued' | 'failed';
export type StudioRightsFilter = 'all' | 'pending' | 'verified';
export type StudioReviewFilter = 'all' | 'ready' | 'needs-review';
export type StudioSort = 'newest' | 'oldest' | 'title-asc' | 'title-desc' | 'updated';

export type StudioFilters = {
  publication: StudioPublicationFilter;
  media: StudioMediaFilter;
  rights: StudioRightsFilter;
  review: StudioReviewFilter;
};

export type StudioMediaState = 'ready' | 'half' | 'failed' | 'queued';

function qualityCount(movie: Pick<AdminMovie, 'availableQualities'>): number {
  return new Set(movie.availableQualities ?? []).size;
}

export function studioMediaState(
  movie: Pick<AdminMovie, 'availableQualities' | 'ingestStatus' | 'ingest_status'>,
): StudioMediaState {
  const count = qualityCount(movie);
  const status = String(movie.ingestStatus ?? movie.ingest_status ?? '').toLowerCase();
  if (count >= 2 || status === 'ready') return 'ready';
  if (count === 1 || status === 'half') return 'half';
  if (['failed', 'flagged_for_review', 'skipped_unplayable'].includes(status)) return 'failed';
  return 'queued';
}

export function studioQualityDiagnostic(
  movie: Pick<AdminMovie, 'downloadSources' | 'transferError'>,
  quality: '720p' | '1080p',
): string | undefined {
  let parsed: unknown;
  try {
    parsed = movie.transferError ? JSON.parse(movie.transferError) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const qualities = (parsed as { qualities?: unknown }).qualities;
    if (Array.isArray(qualities)) {
      const item = qualities.find((candidate) => candidate && typeof candidate === 'object' && (candidate as { quality?: unknown }).quality === quality);
      const code = item && typeof item === 'object' ? (item as { failure_code?: unknown; failureCode?: unknown }).failure_code ?? (item as { failureCode?: unknown }).failureCode : undefined;
      if (typeof code === 'string' && code.trim()) return code.trim().replaceAll('_', ' ').toUpperCase();
    }
  }
  const source = (movie.downloadSources ?? []).find((item) => String(item.quality ?? item.resolution).toLowerCase() === quality);
  const label = source?.label;
  return typeof label === 'string' && /no_peers|download_stalled|source_invalid|failed|unavailable/i.test(label)
    ? label.replaceAll('_', ' ').toUpperCase()
    : undefined;
}
export function studioQualityState(
  movie: Pick<AdminMovie, 'availableQualities' | 'ingestStatus' | 'ingest_status'>,
  quality: '720p' | '1080p',
): 'verified' | 'failed' | 'queued' {
  if (movie.availableQualities?.includes(quality)) return 'verified';
  return studioMediaState(movie) === 'failed' ? 'failed' : 'queued';
}

export function studioReviewState(movie: Pick<AdminMovie, 'enrichmentStatus'>): 'ready' | 'needs-review' {
  return String(movie.enrichmentStatus ?? '').toLowerCase() === 'ready' ? 'ready' : 'needs-review';
}

export function isNewStudioMovie(movie: Pick<AdminMovie, 'createdAt'>, now = Date.now(), days = 7): boolean {
  const created = Date.parse(movie.createdAt);
  if (!Number.isFinite(created) || created > now) return false;
  return now - created <= days * 24 * 60 * 60 * 1000;
}

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function matchesSearch(movie: AdminMovie, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [movie.title, movie.slug, movie.imdbId, String(movie.id)]
    .some((value) => String(value ?? '').toLowerCase().includes(needle));
}

export function filterAndSortStudioMovies(
  movies: AdminMovie[],
  search: string,
  filters: StudioFilters,
  sort: StudioSort = 'newest',
): AdminMovie[] {
  const result = movies.filter((movie) => {
    if (!matchesSearch(movie, search)) return false;
    if (filters.publication !== 'all' && movie.publicationStatus !== filters.publication) return false;
    if (filters.media !== 'all' && studioMediaState(movie) !== filters.media) return false;
    if (filters.rights !== 'all' && String(movie.rightsStatus ?? '').toLowerCase() !== filters.rights) return false;
    if (filters.review !== 'all' && studioReviewState(movie) !== filters.review) return false;
    return true;
  });

  return result.sort((a, b) => {
    if (sort === 'title-asc') return a.title.localeCompare(b.title);
    if (sort === 'title-desc') return b.title.localeCompare(a.title);
    if (sort === 'oldest') return timestamp(a.createdAt) - timestamp(b.createdAt) || a.id - b.id;
    if (sort === 'updated') return timestamp(b.updatedAt) - timestamp(a.updatedAt) || b.id - a.id;
    return timestamp(b.createdAt) - timestamp(a.createdAt) || b.id - a.id;
  });
}

export function studioSummary(movies: AdminMovie[]) {
  return {
    total: movies.length,
    published: movies.filter((movie) => movie.publicationStatus === 'published').length,
    draft: movies.filter((movie) => movie.publicationStatus === 'draft').length,
    archived: movies.filter((movie) => movie.publicationStatus === 'archived').length,
    ready: movies.filter((movie) => studioMediaState(movie) === 'ready').length,
    half: movies.filter((movie) => studioMediaState(movie) === 'half').length,
    failed: movies.filter((movie) => studioMediaState(movie) === 'failed').length,
    queued: movies.filter((movie) => studioMediaState(movie) === 'queued').length,
    rightsPending: movies.filter((movie) => movie.rightsStatus === 'pending').length,
    rightsVerified: movies.filter((movie) => movie.rightsStatus === 'verified').length,
    reviewReady: movies.filter((movie) => studioReviewState(movie) === 'ready').length,
    needsReview: movies.filter((movie) => studioReviewState(movie) === 'needs-review').length,
  };
}

import type { Movie } from './movies.ts';
import { parseCastJson, type CastMember } from './cast.ts';

export type QualityReadiness = {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  r2Verified: boolean;
  keyPresent: boolean;
  bytes: number | null;
};

export type MovieReadiness = {
  metadata: { ready: boolean; blockers: string[] };
  cast: { ready: boolean; blockers: string[]; warnings: string[]; parseError: boolean };
  artwork: { ready: boolean; blockers: string[]; warnings: string[] };
  qualities: Record<'720p' | '1080p', QualityReadiness>;
  rights: { ready: boolean; blockers: string[] };
  publication: { ready: boolean; blockers: string[] };
  publishable: boolean;
  blockers: string[];
};

export function rightsBlockers(movie: Pick<Movie, 'publicationStatus' | 'rightsStatus' | 'rightsVerifiedAt' | 'rightsExpiresAt' | 'rightsReviewer' | 'rightsReference'>, now = Date.now()): string[] {
  const reasons: string[] = [];
  if (movie.publicationStatus !== 'published') reasons.push('Publication must be Published.');
  if (movie.rightsStatus !== 'verified') reasons.push('Rights status must be Verified after your review.');
  if (!movie.rightsReviewer?.trim()) reasons.push('Rights reviewer is missing.');
  if (!movie.rightsReference?.trim()) reasons.push('Rights evidence reference is missing.');
  if (!movie.rightsVerifiedAt || !(Date.parse(movie.rightsVerifiedAt) <= now)) reasons.push('A valid verification time, not in the future, is required.');
  if (!movie.rightsExpiresAt || !(Date.parse(movie.rightsExpiresAt) > now)) reasons.push('Rights expiry must be in the future.');
  return reasons;
}

export function validVideoRecord(key: unknown, bytes: unknown): boolean {
  return typeof key === 'string' && (/^assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/data\.bin$/.test(key) ||
    /^assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:720p|1080p)\.mp4$/.test(key)) &&
    (typeof bytes === 'number' || (typeof bytes === 'string' && /^\d+$/.test(bytes))) && Number.isSafeInteger(Number(bytes)) && Number(bytes) > 0;
}

function sourceForQuality(movie: Movie, quality: '720p' | '1080p'): Record<string, unknown> | undefined {
  const source = (movie.downloadSources ?? []).find((item) => String(item.quality ?? item.resolution).toLowerCase() === quality);
  return source as Record<string, unknown> | undefined;
}

export function qualityReadiness(movie: Movie, quality: '720p' | '1080p'): QualityReadiness {
  const source = sourceForQuality(movie, quality);
  const key = source?.r2StorageKey;
  const bytes = source?.r2Bytes;
  const keyPresent = typeof key === 'string' && key.length > 0;
  const valid = validVideoRecord(key, bytes);
  const blockers: string[] = [];
  if (!source) blockers.push(`MEDIA_${quality.toUpperCase().replace('P', '')}_MISSING`);
  else if (!keyPresent) blockers.push('R2_OBJECT_MISSING');
  else if (!valid) blockers.push('SIZE_MISMATCH');
  return { ready: valid, blockers, warnings: [], r2Verified: valid, keyPresent, bytes: typeof bytes === 'number' ? bytes : null };
}

export function evaluateMovieReadiness(movie: Movie, now = Date.now()): MovieReadiness {
  const metadataBlockers: string[] = [];
  if (!movie.title.trim()) metadataBlockers.push('METADATA_TITLE_MISSING');
  if (!movie.description.trim()) metadataBlockers.push('METADATA_DESCRIPTION_MISSING');
  if (!Number.isInteger(movie.year) || movie.year < 1888) metadataBlockers.push('METADATA_YEAR_MISSING');
  if (!movie.runtime.trim()) metadataBlockers.push('METADATA_RUNTIME_MISSING');
  if (!movie.genre.trim()) metadataBlockers.push('METADATA_GENRE_MISSING');
  if (!movie.director.trim()) metadataBlockers.push('METADATA_DIRECTOR_MISSING');
  const castJson = JSON.stringify(movie.cast ?? []);
  const castParsed = parseCastJson(castJson);
  const castWarnings: string[] = [];
  if (castParsed.parseError) castWarnings.push('CAST_PARSE_ERROR');
  const missingImages = castParsed.members.filter((member: CastMember) => !member.image && !member.profileUrl && !member.profileR2Key).length;
  if (missingImages) castWarnings.push(`CAST_IMAGE_MISSING:${missingImages}`);
  const castBlockers = castParsed.parseError ? [] : [];
  const artworkBlockers: string[] = [];
  const artworkWarnings: string[] = [];
  if (!movie.poster?.trim()) artworkBlockers.push('POSTER_MISSING');
  if (!movie.backdrop?.trim()) artworkBlockers.push('BACKDROP_MISSING');
  if (movie.poster === '/og.png') artworkWarnings.push('POSTER_PLACEHOLDER');
  if (movie.backdrop === '/og.png') artworkWarnings.push('BACKDROP_PLACEHOLDER');
  const rights = rightsBlockers(movie, now);
  const qualities = { '720p': qualityReadiness(movie, '720p'), '1080p': qualityReadiness(movie, '1080p') };
  const publicationBlockers = movie.publicationStatus === 'published' ? [] : ['PUBLICATION_NOT_PUBLISHED'];
  const blockers = [...metadataBlockers, ...artworkBlockers, ...rights, ...publicationBlockers];
  if (!qualities['720p'].ready && !qualities['1080p'].ready) blockers.push('MEDIA_NO_VERIFIED_QUALITY');
  return {
    metadata: { ready: metadataBlockers.length === 0, blockers: metadataBlockers },
    cast: { ready: castBlockers.length === 0, blockers: castBlockers, warnings: castWarnings, parseError: castParsed.parseError },
    artwork: { ready: artworkBlockers.length === 0, blockers: artworkBlockers, warnings: artworkWarnings },
    qualities,
    rights: { ready: rights.length === 0, blockers: rights },
    publication: { ready: publicationBlockers.length === 0, blockers: publicationBlockers },
    publishable: blockers.length === 0,
    blockers,
  };
}

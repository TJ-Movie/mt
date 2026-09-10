import type { Movie } from './movies.ts';

/** Shared by the private Studio diagnostics and the public gateway. */
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
  return typeof key === 'string' && /^assets\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/data\.bin$/.test(key) &&
    typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0;
}

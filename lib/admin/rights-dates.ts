export const RIGHTS_DEFAULT_EXPIRES_AT = '2034-08-31T12:00:00.000Z';
export const RIGHTS_DEFAULT_REVIEWER = 'Tj@gmail.com';
export const RIGHTS_DEFAULT_REFERENCE = 'Good';

type RightsDateFields = {
  rightsVerifiedAt?: string | null;
  rightsExpiresAt?: string | null;
};

type RightsFormFields = RightsDateFields & {
  rightsReviewer?: string | null;
  rightsReference?: string | null;
};

type RightsStatusDraft = RightsDateFields & {
  rightsStatus: string;
};

function epochMs(now: number | Date): number {
  const value = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(value)) throw new Error('A finite current time is required.');
  return value;
}

function parsedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultText(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function rightsDatesForVerification(
  current: RightsDateFields,
  now: number | Date = Date.now(),
): { rightsVerifiedAt: string; rightsExpiresAt: string } {
  const nowMs = epochMs(now);
  const safeNowMs = Math.max(0, nowMs - 1000);
  const existingVerifiedMs = parsedTime(current.rightsVerifiedAt);
  const verifiedMs = existingVerifiedMs !== null && existingVerifiedMs <= nowMs
    ? existingVerifiedMs
    : safeNowMs;
  const verifiedAt = existingVerifiedMs !== null && existingVerifiedMs <= nowMs
    ? current.rightsVerifiedAt!
    : new Date(verifiedMs).toISOString();

  const expiresAt = RIGHTS_DEFAULT_EXPIRES_AT;

  return { rightsVerifiedAt: verifiedAt, rightsExpiresAt: expiresAt };
}

export function initializeRightsForm<T extends RightsFormFields>(
  current: T,
  now: number | Date = Date.now(),
): Omit<T, 'rightsVerifiedAt' | 'rightsExpiresAt' | 'rightsReviewer' | 'rightsReference'> & {
  rightsVerifiedAt: string;
  rightsExpiresAt: string;
  rightsReviewer: string;
  rightsReference: string;
} {
  return {
    ...current,
    ...rightsDatesForVerification(current, now),
    rightsReviewer: defaultText(current.rightsReviewer, RIGHTS_DEFAULT_REVIEWER),
    rightsReference: defaultText(current.rightsReference, RIGHTS_DEFAULT_REFERENCE),
  };
}
export function applyRightsStatusChange<T extends RightsStatusDraft>(
  current: T,
  nextStatus: T['rightsStatus'],
  now: number | Date = Date.now(),
): T {
  const next = { ...current, rightsStatus: nextStatus };
  return nextStatus === 'verified'
    ? { ...next, ...rightsDatesForVerification(current, now) }
    : next;
}
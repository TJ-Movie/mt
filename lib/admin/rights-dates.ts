export const RIGHTS_DEFAULT_EXPIRES_AT = '2034-08-31T12:00:00.000Z';

type RightsDateFields = {
  rightsVerifiedAt?: string | null;
  rightsExpiresAt?: string | null;
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

export function initializeRightsForm<T extends RightsDateFields>(
  current: T,
  now: number | Date = Date.now(),
): Omit<T, 'rightsVerifiedAt' | 'rightsExpiresAt'> & {
  rightsVerifiedAt: string;
  rightsExpiresAt: string;
} {
  return { ...current, ...rightsDatesForVerification(current, now) };
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
const DAY_MS = 24 * 60 * 60 * 1000;

export const RIGHTS_EXPIRY_WINDOW_DAYS = 365;

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

  const existingExpiresMs = parsedTime(current.rightsExpiresAt);
  const expiresAt = existingExpiresMs !== null && existingExpiresMs > nowMs && existingExpiresMs > verifiedMs
    ? current.rightsExpiresAt!
    : new Date(Math.max(nowMs, verifiedMs) + RIGHTS_EXPIRY_WINDOW_DAYS * DAY_MS).toISOString();

  return { rightsVerifiedAt: verifiedAt, rightsExpiresAt: expiresAt };
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
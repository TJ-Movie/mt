export const INGEST_STATUSES = Object.freeze([
  'none', 'queued', 'processing', 'transferring', 'ready',
  'retry_pending', 'half', 'flagged_for_review', 'skipped_unplayable',
]);

const LEGAL_TRANSITIONS = Object.freeze({
  none: ['queued', 'processing', 'flagged_for_review'],
  queued: ['processing', 'transferring', 'ready', 'retry_pending', 'half', 'flagged_for_review', 'skipped_unplayable'],
  processing: ['transferring', 'ready', 'retry_pending', 'half', 'flagged_for_review', 'skipped_unplayable'],
  transferring: ['processing', 'ready', 'retry_pending', 'half', 'flagged_for_review', 'skipped_unplayable'],
  ready: ['processing', 'transferring', 'retry_pending', 'half', 'flagged_for_review'],
  retry_pending: ['queued', 'processing', 'transferring', 'ready', 'half', 'flagged_for_review', 'skipped_unplayable'],
  half: ['processing', 'transferring', 'ready', 'retry_pending', 'flagged_for_review', 'skipped_unplayable'],
  flagged_for_review: ['queued', 'processing', 'transferring', 'ready', 'retry_pending', 'half', 'skipped_unplayable'],
  skipped_unplayable: ['queued', 'processing', 'retry_pending', 'transferring', 'half', 'flagged_for_review'],
});

export function isKnownIngestStatus(value) {
  return typeof value === 'string' && INGEST_STATUSES.includes(value);
}

export function assertLegalTransition(from, to) {
  if (!isKnownIngestStatus(from) || !isKnownIngestStatus(to)) throw new Error('Unknown ingest state transition: ' + String(from) + ' -> ' + String(to));
  if (from === to) return true;
  if (!LEGAL_TRANSITIONS[from].includes(to)) throw new Error('Illegal ingest state transition: ' + from + ' -> ' + to);
  return true;
}

export function isLeaseActive(leaseUntil, now = Math.floor(Date.now() / 1000)) {
  return Number.isSafeInteger(Number(leaseUntil)) && Number(leaseUntil) > now;
}

export function classifyTransferOwnership(row, now = Math.floor(Date.now() / 1000)) {
  if (row?.ingest_status !== 'transferring') return 'not-transferring';
  if (row.transfer_token && isLeaseActive(row.transfer_lease_until, now)) return 'active';
  if (!row.transfer_token && row.transfer_lease_until == null) return 'missing-owner-and-lease';
  if (Number.isSafeInteger(Number(row.transfer_lease_until)) && Number(row.transfer_lease_until) <= now) return 'expired-lease';
  if (!row.transfer_token) return 'missing-owner';
  return 'missing-lease';
}

export async function claimTransfer(ctx, { id, token, quality, leaseSeconds = 3600, now = Math.floor(Date.now() / 1000) }) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('Invalid movie id for transfer claim');
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) throw new Error('Invalid transfer owner token');
  if (!/^(720p|1080p)$/.test(String(quality || ''))) throw new Error('Invalid transfer quality');
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 86400) throw new Error('Invalid transfer lease duration');
  const leaseUntil = now + leaseSeconds;
  const rows = await ctx.query(
    "UPDATE movies SET ingest_status = 'transferring', transfer_token = ?, transfer_lease_until = ?, transfer_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (ingest_status IN ('queued','processing','retry_pending','half','flagged_for_review','ready') OR (ingest_status = 'transferring' AND (transfer_lease_until IS NULL OR transfer_lease_until <= ?))) AND (transfer_token IS NULL OR transfer_lease_until IS NULL OR transfer_lease_until <= ?) RETURNING id",
    [token, leaseUntil, id, now, now],
  );
  return { claimed: Boolean(rows?.length), id: Number(id), quality, token, leaseUntil, attemptId: token.split(':').slice(-1)[0] };
}

export async function releaseTransfer(ctx, { id, token, nextState = 'retry_pending', error = null }) {
  assertLegalTransition('transferring', nextState);
  if (typeof token !== 'string' || !token) throw new Error('Transfer owner token is required for release');
  const rows = await ctx.query(
    "UPDATE movies SET ingest_status = ?, transfer_error = ?, transfer_token = NULL, transfer_lease_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ingest_status = 'transferring' AND transfer_token = ? RETURNING id",
    [nextState, error ? String(error).slice(0, 1000) : null, id, token],
  );
  return Boolean(rows?.length);
}

export async function diagnoseStaleTransfers(ctx, { now = Math.floor(Date.now() / 1000) } = {}) {
  const rows = await ctx.query("SELECT id, slug, ingest_status, transfer_token, transfer_lease_until, transfer_error FROM movies WHERE ingest_status = 'transferring' ORDER BY id");
  return (rows || []).map((row) => {
    const classification = classifyTransferOwnership(row, now);
    return {
      movie_id: Number(row.id), slug: row.slug || null, ingest_status: row.ingest_status,
      transfer_owner: row.transfer_token || null,
      lease_expiry: row.transfer_lease_until == null ? null : Number(row.transfer_lease_until),
      classification, recommended_transition: classification === 'active' ? 'none' : 'retry_pending',
      transfer_error: row.transfer_error || null,
    };
  });
}
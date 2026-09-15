import { getDatabase } from '../../../../../../db';
import { triggerR2Sync } from '../../../../../../app/api/admin/ingest/yts/route';
import { assertLegalTransition } from '../../../../../../scripts/ingest-state.mjs';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../../../lib/security/admin-api';

function validId(value: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
function qualitySource(json: string, quality: string): { r2StorageKey?: unknown; r2Bytes?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(json || '[]');
    const sources = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sources?: unknown }).sources) ? (parsed as { sources: unknown[] }).sources : [];
    const source = sources.find((item) => item && typeof item === 'object' && String((item as { quality?: unknown; resolution?: unknown }).quality ?? (item as { resolution?: unknown }).resolution).toLowerCase() === quality);
    return source && typeof source === 'object' ? source as { r2StorageKey?: unknown; r2Bytes?: unknown } : null;
  } catch { return null; }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeAdminRequest(request, true);
  if ('response' in authorization) return authorization.response;
  const id = validId((await context.params).id);
  const body = await readBoundedJson(request, 2048);
  const quality = body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { quality?: unknown }).quality === 'string' ? (body as { quality: string }).quality.toLowerCase() : '';
  if (!id || !/^(720p|1080p)$/.test(quality)) return Response.json({ error: 'Choose a valid movie and quality.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const database = getDatabase();
  const row = await database.prepare('SELECT id, revision, ingest_status, publication_status, download_sources_json FROM movies WHERE id = ? LIMIT 1').bind(id).first<{ id: number; revision: number; ingest_status: string; publication_status: string; download_sources_json: string }>();
  if (!row) return Response.json({ error: 'Movie not found.' }, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
  if (row.publication_status === 'archived') return Response.json({ error: 'Archived movies cannot be retried.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
  const source = qualitySource(row.download_sources_json, quality);
  if (!source) return Response.json({ error: 'That quality has no saved source descriptor.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
  if (typeof source.r2StorageKey === 'string' && Number(source.r2Bytes) > 0) return Response.json({ error: 'That quality is already mapped to verified media; use an explicit replacement workflow.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
  try { assertLegalTransition(row.ingest_status, 'processing'); } catch { return Response.json({ error: 'This movie is in a state that cannot be retried safely.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS }); }
  const updated = await database.prepare("UPDATE movies SET ingest_status = 'processing', transfer_error = NULL, transfer_token = NULL, transfer_lease_until = NULL, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ? AND publication_status <> 'archived' AND ingest_status = ? AND (transfer_token IS NULL OR transfer_lease_until IS NULL OR transfer_lease_until <= strftime('%s','now')) RETURNING id").bind(authorization.user.userId, new Date().toISOString(), id, row.revision, row.ingest_status).all();
  if (!updated.results?.length) return Response.json({ error: 'The record changed or has an active transfer lease. Refresh and retry.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
  const workflow = await triggerR2Sync([id], authorization.user, { movie_ids: String(id), quality });
  if (workflow.status === 'DISPATCH_FAILED') {
    await database.prepare("UPDATE movies SET ingest_status = 'retry_pending', transfer_error = ?, transfer_token = NULL, transfer_lease_until = NULL, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ? AND ingest_status = 'processing'").bind('DISPATCH_FAILED: ' + (workflow.error ?? 'unknown'), authorization.user.userId, new Date().toISOString(), id).run();
  }
  return Response.json({ retry: { movieId: id, quality, status: workflow.status === 'DISPATCH_FAILED' ? 'DISPATCH_FAILED' : 'DISPATCH_ACCEPTED' }, workflow }, { status: workflow.status === 'DISPATCH_FAILED' ? 503 : 202, headers: ADMIN_NO_STORE_HEADERS });
}

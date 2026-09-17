import { archiveAdminMovie, assertApprovedSourceDomains, deleteArchivedAdminMovie, updateAdminMovie } from '../../../../../db';
import { validateAdminMovieInput } from '../../../../../lib/admin/movie-input';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../../lib/security/admin-api';
import { logSecurityEvent } from '../../../../../lib/security/security-events';

function validIdentifier(value: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function validRevision(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000 ? Number(value) : null;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeAdminRequest(request, true);
  if ('response' in authorization) return authorization.response;
  const id = validIdentifier((await context.params).id);
  const body = await readBoundedJson(request);
  if (!id || !body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid update.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const record = body as Record<string, unknown>;
  const revision = validRevision(record.revision);
  const validation = validateAdminMovieInput(record.movie);
  if (!revision || !validation.ok) {
    logSecurityEvent('admin_request_rejected', 'warn', { action: 'update', reason: 'validation' });
    return Response.json({ error: 'Please correct the highlighted fields.', fields: validation.ok ? {} : validation.errors }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    await assertApprovedSourceDomains(validation.value);
    const updated = await updateAdminMovie(id, revision, validation.value, authorization.user);
    if (!updated) return Response.json({ error: 'This record changed in another session. Refresh and try again.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
    return Response.json({ updated: true }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('UNAPPROVED_DOMAIN:')) return Response.json({ error: `Add ${error.message.slice(18)} to Approved Domains before saving.` }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    if (error instanceof Error && error.message === 'RIGHTS_REVERIFICATION_REQUIRED') {
      logSecurityEvent('admin_request_rejected', 'warn', { action: 'update', reason: 'rights_reverification_required' });
      return Response.json({ error: 'Set rights to pending, save the delivery change, then complete a fresh verification.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
    }
    return Response.json({ error: 'The slug may already exist, or the database is unavailable.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeAdminRequest(request, true);
  if ('response' in authorization) return authorization.response;
  const id = validIdentifier((await context.params).id);
  const body = await readBoundedJson(request, 1_024);
  const action = body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>).action === 'delete' ? 'delete' : 'archive';
  const revision = body && typeof body === 'object' && !Array.isArray(body) ? validRevision((body as Record<string, unknown>).revision) : null;
  if (!id || !revision) return Response.json({ error: 'Invalid archive/delete request.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  try {
    if (action === 'delete') {
      const outcome = await deleteArchivedAdminMovie(id, revision, authorization.user);
      if (outcome.ok) return Response.json({ deleted: true }, { headers: ADMIN_NO_STORE_HEADERS });
      if (outcome.code === 'R2_CLEANUP_FAILED') {
        return Response.json({ error: 'Delete failed: storage cleanup could not be completed. Movie was not removed. You can retry.', code: outcome.code, asset: outcome.failure?.category ?? 'storage' }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
      }
      if (outcome.code === 'REVISION_CONFLICT_AFTER_CLEANUP') {
        return Response.json({ error: 'Storage cleanup completed, but the movie changed before removal. Refresh and retry Delete.', code: outcome.code }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
      }
      if (outcome.code === 'REVISION_CONFLICT') {
        return Response.json({ error: 'This record changed in another session. Refresh and try again.', code: outcome.code }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
      }
      return Response.json({ error: 'Only archived movies can be permanently deleted.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
    }
    const changed = await archiveAdminMovie(id, revision, authorization.user);
    if (!changed) return Response.json({ error: 'This record changed in another session. Refresh and try again.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
    return Response.json({ archived: true }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch {
    return Response.json({ error: action === 'delete' ? 'Delete failed: storage cleanup could not be completed. Movie was not removed. You can retry.' : 'The database is temporarily unavailable.' }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

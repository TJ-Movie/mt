import { assertApprovedSourceDomains, createAdminMovie, initializeStarterCatalogue, listAdminMovies, listAuditEvents } from '../../../../db';
import { validateAdminMovieInput } from '../../../../lib/admin/movie-input';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest, readBoundedJson } from '../../../../lib/security/admin-api';
import { logSecurityEvent } from '../../../../lib/security/security-events';

export async function GET(request: Request) {
  const authorization = await authorizeAdminRequest(request);
  if ('response' in authorization) return authorization.response;
  try {
    await initializeStarterCatalogue(authorization.user);
    const [movies, auditEvents] = await Promise.all([listAdminMovies(), listAuditEvents()]);
    return Response.json({ movies, auditEvents }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch {
    return Response.json({ error: 'The studio database is temporarily unavailable.' }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeAdminRequest(request, true);
  if ('response' in authorization) return authorization.response;
  const body = await readBoundedJson(request);
  const validation = validateAdminMovieInput(body);
  if (!validation.ok) {
    logSecurityEvent('admin_request_rejected', 'warn', { action: 'create', reason: 'validation' });
    return Response.json({ error: 'Please correct the highlighted fields.', fields: validation.errors }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    await assertApprovedSourceDomains(validation.value);
    const id = await createAdminMovie(validation.value, authorization.user);
    return Response.json({ id }, { status: 201, headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('UNAPPROVED_DOMAIN:')) return Response.json({ error: `Add ${error.message.slice(18)} to Approved Domains before saving.` }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    return Response.json({ error: 'The slug may already exist, or the database is unavailable.' }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
  }
}

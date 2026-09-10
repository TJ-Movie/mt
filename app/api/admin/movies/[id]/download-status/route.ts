import { getDatabase, getMediaBucket, listAdminMovies } from '../../../../../../db';
import { rightsBlockers, validVideoRecord } from '../../../../../../lib/download-readiness';
import { r2SigningConfigured } from '../../../../../../lib/r2-download';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest } from '../../../../../../lib/security/admin-api';
import { getRuntimeControls } from '../../../../../../lib/security/runtime-controls';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeAdminRequest(request, false);
  if ('response' in authorization) return authorization.response;
  const { id } = await context.params;
  if (!/^[1-9]\d{0,9}$/.test(id)) return Response.json({ error: 'Invalid movie.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  try {
    const movie = (await listAdminMovies()).find(item => item.id === Number(id));
    if (!movie) return Response.json({ error: 'Movie not found.' }, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    const blockers = rightsBlockers(movie);
    if (!getRuntimeControls().externalLinksEnabled) blockers.push('The global download kill switch is enabled.');
    if (!r2SigningConfigured()) blockers.push('Worker R2 signing credentials are missing or invalid. GitHub secrets do not configure the live Worker.');
    const row = await getDatabase().prepare('SELECT ingest_status, r2_storage_key, r2_video_bytes FROM movies WHERE id = ?').bind(Number(id))
      .first<{ ingest_status: string; r2_storage_key: string | null; r2_video_bytes: number | null }>();
    const transfer = row?.ingest_status ?? 'not queued';
    let objectVerified = false;
    if (transfer !== 'ready') blockers.push(`Video transfer is ${transfer}; it must finish before direct download is available.`);
    else if (!row || !validVideoRecord(row.r2_storage_key, row.r2_video_bytes)) blockers.push('Ready record has no valid R2 video key or size.');
    else {
      const object = await getMediaBucket().head(row.r2_storage_key!);
      objectVerified = Boolean(object && object.size === row.r2_video_bytes && object.httpMetadata?.contentType === 'video/mp4');
      if (!objectVerified) blockers.push('The R2 video is missing, has the wrong size, or is not video/mp4.');
    }
    return Response.json({ transfer, objectVerified, blockers, eligible: blockers.length === 0,
      note: 'Saved record checked. Signing configuration presence is checked; use Test direct download to verify credential validity.' }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch {
    return Response.json({ error: 'Could not check the saved movie or R2 object. Retry shortly.' }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

import { getDatabase, getMediaBucket, listAdminMovies } from '../../../../../../db';
import { evaluateMovieReadiness } from '../../../../../../lib/download-readiness';
import { parseCastJson } from '../../../../../../lib/cast';
import { r2SigningConfigured } from '../../../../../../lib/r2-download';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest } from '../../../../../../lib/security/admin-api';
import { getRuntimeControls } from '../../../../../../lib/security/runtime-controls';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeAdminRequest(request, false);
  if ('response' in authorization) return authorization.response;
  const { id } = await context.params;
  if (!/^[1-9]\d{0,9}$/.test(id)) return Response.json({ error: 'Invalid movie.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  try {
    const movie = (await listAdminMovies()).find((item) => item.id === Number(id));
    if (!movie) return Response.json({ error: 'Movie not found.' }, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    const row = await getDatabase().prepare('SELECT cast_json, ingest_status, r2_storage_key, r2_video_bytes FROM movies WHERE id = ?').bind(Number(id))
      .first<{ cast_json: string; ingest_status: string; r2_storage_key: string | null; r2_video_bytes: number | null }>();
    const readiness = evaluateMovieReadiness(movie);
    const castDiagnostic = parseCastJson(row?.cast_json ?? '[]');
    if (castDiagnostic.parseError) readiness.cast.warnings = [...new Set([...readiness.cast.warnings, 'CAST_PARSE_ERROR'])];
    const blockers = [...readiness.rights.blockers, ...readiness.publication.blockers];
    if (!getRuntimeControls().externalLinksEnabled) blockers.push('DOWNLOAD_KILL_SWITCH_ENABLED');
    if (!r2SigningConfigured()) blockers.push('R2_SIGNING_CONFIGURATION_MISSING');
    const qualities = { ...readiness.qualities };
    let verifiedQualityCount = 0;
    for (const quality of ['720p', '1080p'] as const) {
      const state = qualities[quality];
      const source = movie.downloadSources?.find((item) => String(item.quality ?? item.resolution).toLowerCase() === quality);
      const key = source?.r2StorageKey;
      if (state.ready && key) {
        const object = await getMediaBucket().head(key);
        const live = Boolean(object && object.size === source.r2Bytes && object.httpMetadata?.contentType === 'video/mp4');
        if (!live) {
          state.ready = false;
          state.r2Verified = false;
          state.blockers = [...new Set([...state.blockers, 'R2_OBJECT_MISSING_OR_INVALID'])];
        } else verifiedQualityCount += 1;
      }
    }
    if (!verifiedQualityCount && row?.r2_storage_key && typeof row.r2_video_bytes === 'number' && row.r2_video_bytes > 0) {
      const primary = await getMediaBucket().head(row.r2_storage_key);
      if (primary && primary.size === row.r2_video_bytes && primary.httpMetadata?.contentType === 'video/mp4') verifiedQualityCount = 1;
    }
    if (!verifiedQualityCount) blockers.push('MEDIA_NO_LIVE_VERIFIED_QUALITY');
    if (row?.ingest_status && ['queued', 'processing', 'transferring', 'retry_pending', 'flagged_for_review', 'skipped_unplayable'].includes(row.ingest_status) && !verifiedQualityCount) {
      blockers.push('MEDIA_TRANSFER_' + row.ingest_status.toUpperCase());
    }
    const uniqueBlockers = [...new Set(blockers)];
    return Response.json({
      transfer: row?.ingest_status ?? 'not queued',
      objectVerified: verifiedQualityCount > 0,
      blockers: uniqueBlockers,
      eligible: uniqueBlockers.length === 0,
      readiness: { ...readiness, qualities },
      note: 'Saved record checked. Quality availability is independent; warnings do not block a verified quality.',
    }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    console.error(JSON.stringify({ event: 'admin_readiness_check_failed', error: error instanceof Error ? error.message : String(error) }));
    return Response.json({ error: 'Could not check the saved movie or R2 object. Retry shortly.' }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

import { getMediaBucket } from '../../../../db';
import { sanitizeUploadedImage } from '../../../../lib/admin/image-sanitizer';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest } from '../../../../lib/security/admin-api';
import { logSecurityEvent } from '../../../../lib/security/security-events';

const MAX_MULTIPART_BYTES = 5 * 1024 * 1024 + 64 * 1024;

export async function POST(request: Request) {
  const authorization = await authorizeAdminRequest(request, true);
  if ('response' in authorization) return authorization.response;
  const contentType = request.headers.get('content-type') ?? '';
  const contentLength = Number(request.headers.get('content-length'));
  if (!contentType.toLowerCase().startsWith('multipart/form-data;') || !Number.isFinite(contentLength) || contentLength < 1 || contentLength > MAX_MULTIPART_BYTES) {
    return Response.json({ error: 'Upload must be a JPG or PNG no larger than 5 MB.' }, { status: 413, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return Response.json({ error: 'Choose an image file.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    const sanitized = await sanitizeUploadedImage(file);
    if (!sanitized) return Response.json({ error: 'The image is invalid or exceeds the safe size/dimension limits.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    const key = `movie-art/${crypto.randomUUID()}.${sanitized.extension}`;
    await getMediaBucket().put(key, sanitized.bytes, {
      httpMetadata: { contentType: sanitized.contentType, cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { sanitized: 'true' },
    });
    logSecurityEvent('admin_asset_uploaded', 'info', { contentType: sanitized.contentType, bytes: sanitized.bytes.byteLength });
    return Response.json({ path: `/media/${key}` }, { status: 201, headers: ADMIN_NO_STORE_HEADERS });
  } catch {
    return Response.json({ error: 'The image could not be stored.' }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}

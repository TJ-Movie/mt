import { getMediaBucket } from '../../../../db';
import { sanitizeUploadedImage } from '../../../../lib/admin/image-sanitizer';
import { ADMIN_NO_STORE_HEADERS, authorizeAdminRequest } from '../../../../lib/security/admin-api';
import { logSecurityEvent } from '../../../../lib/security/security-events';

const MAX_MULTIPART_BYTES = 25 * 1024 * 1024 + 64 * 1024;

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
    if (form.get('kind') === 'subtitle') {
      if (file.size > 25 * 1024 * 1024) return Response.json({ error: 'Subtitle bundles must be no larger than 25 MB.' }, { status: 413, headers: ADMIN_NO_STORE_HEADERS });
      const lowerName = file.name.toLowerCase();
      const extension = lowerName.endsWith('.vtt') ? 'vtt' : lowerName.endsWith('.srt') ? 'srt' : lowerName.endsWith('.zip') ? 'zip' : lowerName.endsWith('.7z') ? '7z' : '';
      if (!extension) return Response.json({ error: 'Upload an SRT, VTT, ZIP, or 7Z subtitle file.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isArchive = extension === 'zip' || extension === '7z';
      const validArchive = extension === 'zip' ? bytes[0] === 0x50 && bytes[1] === 0x4b : bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf;
      if (!bytes.length || (!isArchive && bytes.includes(0)) || (isArchive && !validArchive)) return Response.json({ error: 'The subtitle file is invalid.' }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
      const key = `subtitles/${crypto.randomUUID()}.${extension}`;
      await getMediaBucket().put(key, bytes, { httpMetadata: { contentType: extension === 'vtt' ? 'text/vtt; charset=utf-8' : extension === 'srt' ? 'application/x-subrip; charset=utf-8' : extension === '7z' ? 'application/x-7z-compressed' : 'application/zip', contentDisposition: `attachment; filename="subtitles.${extension}"` }, customMetadata: { sanitized: 'true', kind: 'subtitle' } });
      logSecurityEvent('admin_asset_uploaded', 'info', { contentType: extension, bytes: bytes.byteLength });
      return Response.json({ path: `/media/${key}` }, { status: 201, headers: ADMIN_NO_STORE_HEADERS });
    }
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

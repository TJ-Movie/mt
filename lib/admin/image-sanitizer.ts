export type SanitizedImage = { bytes: Uint8Array; contentType: 'image/jpeg' | 'image/png'; extension: 'jpg' | 'png' };

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 8_000;
const MAX_PIXELS = 24_000_000;

function validDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS;
}

function join(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function sanitizePng(bytes: Uint8Array): Uint8Array | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.slice(0, 8)];
  let position = 8;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position, false);
    if (length > MAX_FILE_BYTES || position + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(...bytes.slice(position + 4, position + 8));
    const end = position + 12 + length;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return null;
      const width = view.getUint32(position + 8, false);
      const height = view.getUint32(position + 12, false);
      if (!validDimensions(width, height)) return null;
      sawHeader = true;
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawData || end !== bytes.length) return null;
      sawEnd = true;
    }
    if (type === 'IHDR' || type === 'PLTE' || type === 'IDAT' || type === 'IEND') parts.push(bytes.slice(position, end));
    else if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) return null;
    position = end;
    if (sawEnd) break;
  }
  return sawHeader && sawData && sawEnd ? join(parts) : null;
}

const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sanitizeJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  const parts = [bytes.slice(0, 2)];
  let position = 2;
  let sawFrame = false;
  while (position + 4 <= bytes.length) {
    const start = position;
    if (bytes[position] !== 0xff) return null;
    while (position < bytes.length && bytes[position] === 0xff) position += 1;
    const marker = bytes[position++];
    if (marker === 0xda) {
      if (!sawFrame || position + 2 > bytes.length) return null;
      const scanLength = (bytes[position] << 8) | bytes[position + 1];
      if (scanLength < 2 || position + scanLength > bytes.length) return null;
      parts.push(bytes.slice(start));
      return join(parts);
    }
    if (marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    const length = (bytes[position] << 8) | bytes[position + 1];
    if (length < 2 || position + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 8) return null;
      const height = (bytes[position + 3] << 8) | bytes[position + 4];
      const width = (bytes[position + 5] << 8) | bytes[position + 6];
      if (!validDimensions(width, height)) return null;
      sawFrame = true;
    }
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) parts.push(bytes.slice(start, position + length));
    position += length;
  }
  return null;
}

export async function sanitizeUploadedImage(file: File): Promise<SanitizedImage | null> {
  if (file.size < 1 || file.size > MAX_FILE_BYTES) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'image/png') {
    const sanitized = sanitizePng(bytes);
    return sanitized ? { bytes: sanitized, contentType: 'image/png', extension: 'png' } : null;
  }
  if (file.type === 'image/jpeg') {
    const sanitized = sanitizeJpeg(bytes);
    return sanitized ? { bytes: sanitized, contentType: 'image/jpeg', extension: 'jpg' } : null;
  }
  return null;
}

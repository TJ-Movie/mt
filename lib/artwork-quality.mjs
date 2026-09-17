const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      return {
        width: bytes[offset + 5] * 256 + bytes[offset + 6],
        height: bytes[offset + 3] * 256 + bytes[offset + 4],
        format: 'jpeg',
      };
    }
    offset += length;
  }
  return null;
}

export function parseImageDimensions(bytes, contentType) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (contentType === 'image/png' && value.length >= 24 &&
      value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47 &&
      value[4] === 0x0d && value[5] === 0x0a && value[6] === 0x1a && value[7] === 0x0a) {
    return { width: new DataView(value.buffer, value.byteOffset).getUint32(16), height: new DataView(value.buffer, value.byteOffset).getUint32(20), format: 'png' };
  }
  if (contentType === 'image/gif' && value.length >= 10 &&
      (String.fromCharCode(...value.slice(0, 6)) === 'GIF87a' || String.fromCharCode(...value.slice(0, 6)) === 'GIF89a')) {
    return { width: value[6] + value[7] * 256, height: value[8] + value[9] * 256, format: 'gif' };
  }
  if (contentType === 'image/webp' && value.length >= 30 &&
      String.fromCharCode(...value.slice(0, 4)) === 'RIFF' && String.fromCharCode(...value.slice(8, 12)) === 'WEBP' &&
      String.fromCharCode(...value.slice(12, 16)) === 'VP8X') {
    return {
      width: 1 + value[24] + (value[25] << 8) + (value[26] << 16),
      height: 1 + value[27] + (value[28] << 8) + (value[29] << 16),
      format: 'webp',
    };
  }
  return jpegDimensions(value);
}

export function qualityFromDimensions(kind, width, height, contentType = 'image/jpeg', bytes = 1) {
  const numericWidth = Number(width || 0);
  const numericHeight = Number(height || 0);
  const ratio = numericWidth > 0 && numericHeight > 0 ? numericWidth / numericHeight : 0;
  const landscape = numericWidth > numericHeight;
  const portrait = numericHeight > numericWidth;
  const validShape = kind === 'backdrop'
    ? landscape && ratio >= 1.45 && ratio <= 2.5 && numericWidth >= 1280 && numericHeight >= 720
    : portrait && ratio >= 0.5 && ratio <= 0.85 && numericWidth >= 300 && numericHeight >= 450;
  const valid = Number(bytes) > 0 && IMAGE_TYPES.has(String(contentType).toLowerCase()) && validShape;
  const targetRatio = kind === 'backdrop' ? 16 / 9 : 2 / 3;
  const ratioPenalty = Math.min(1, Math.abs(ratio - targetRatio) / (kind === 'backdrop' ? 0.5 : 0.2));
  const tier = numericWidth >= 3840 ? 4 : numericWidth >= 2560 ? 3 : numericWidth >= 1920 ? 2 : numericWidth >= 1280 ? 1 : 0;
  const score = valid ? tier * 100 + (1 - ratioPenalty) * 10 + Math.min(numericWidth, 4096) / 4096 : -Infinity;
  return {
    valid,
    decodable: validShape,
    contentType: String(contentType).toLowerCase(),
    bytes: Number(bytes) || 0,
    width: numericWidth,
    height: numericHeight,
    ratio: Number(ratio.toFixed(4)),
    orientation: landscape ? 'landscape' : portrait ? 'portrait' : 'square',
    format: String(contentType).includes('png') ? 'png' : String(contentType).includes('webp') ? 'webp' : 'jpeg',
    score,
  };
}

export function inspectArtworkBytes(bytes, contentType, kind) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const normalizedType = String(contentType || '').toLowerCase().split(';')[0];
  const dimensions = IMAGE_TYPES.has(normalizedType) ? parseImageDimensions(value, normalizedType) : null;
  const width = dimensions?.width ?? 0;
  const height = dimensions?.height ?? 0;
  const ratio = width > 0 && height > 0 ? width / height : 0;
  const landscape = width > height;
  const portrait = height > width;
  const validShape = kind === 'backdrop'
    ? landscape && ratio >= 1.45 && ratio <= 2.5 && width >= 1280 && height >= 720
    : portrait && ratio >= 0.5 && ratio <= 0.85 && width >= 300 && height >= 450;
  const valid = value.length > 0 && IMAGE_TYPES.has(normalizedType) && Boolean(dimensions) && validShape;
  const tier = width >= 3840 ? 4 : width >= 2560 ? 3 : width >= 1920 ? 2 : width >= 1280 ? 1 : 0;
  const targetRatio = kind === 'backdrop' ? 16 / 9 : 2 / 3;
  const ratioPenalty = Math.min(1, Math.abs(ratio - targetRatio) / (kind === 'backdrop' ? 0.5 : 0.2));
  const score = valid ? tier * 100 + (1 - ratioPenalty) * 10 + Math.min(width, 4096) / 4096 : -Infinity;
  return {
    valid,
    decodable: Boolean(dimensions),
    contentType: normalizedType,
    bytes: value.length,
    width,
    height,
    ratio: Number(ratio.toFixed(4)),
    orientation: landscape ? 'landscape' : portrait ? 'portrait' : 'square',
    format: dimensions?.format || 'unknown',
    score,
  };
}

export function chooseBestArtworkCandidate(kind, candidates, existing = null) {
  const all = [existing, ...(Array.isArray(candidates) ? candidates : [])]
    .filter(Boolean)
    .filter((candidate) => candidate.identityCorrect !== false && candidate.quality?.valid);
  if (!all.length) return null;
  all.sort((left, right) => right.quality.score - left.quality.score);
  const best = all[0];
  if (existing?.quality?.valid && best !== existing && best.quality.score <= existing.quality.score) return existing;
  return best;
}

export function candidateFromDimensions(provider, url, kind, dimensions, options = {}) {
  const width = Number(dimensions?.width || 0);
  const height = Number(dimensions?.height || 0);
  const contentType = options.contentType || 'image/jpeg';
  const quality = inspectArtworkBytes(new Uint8Array(Math.max(1, Number(options.bytes || 1))), contentType, kind);
  const adjustedQuality = { ...quality, width, height, ratio: width > 0 && height > 0 ? Number((width / height).toFixed(4)) : 0 };
  return { provider, url, identityCorrect: options.identityCorrect !== false, quality: { ...adjustedQuality, valid: Boolean(options.valid ?? (width > 0 && height > 0)), score: options.score ?? adjustedQuality.score } };
}
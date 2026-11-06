// Browser image pipeline: sniff -> decode -> canvas -> WebP (JPEG fallback), stepping quality and
// then dimensions down until the result fits. The canvas re-encode strips EXIF/GPS metadata.
// SVG and anything that is not a decodable raster image is rejected. Animated GIF/WebP may be kept
// byte-for-byte (allowAnimated) when it already fits the size and dimension caps.

const RASTER_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
export const STORED_MIMES = ['image/webp', 'image/jpeg', 'image/png', 'image/gif'];

export const isRasterMime = (mime) => RASTER_MIMES.includes(String(mime || '').toLowerCase());

/** Standard base64 (usable in data: URLs) of a Uint8Array. */
export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** data: URL for stored image data, or null when the mime is not one we render. */
export function dataUrl(mime, base64) {
  if (!STORED_MIMES.includes(mime) || typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  return `data:${mime};base64,${base64}`;
}

/** Detects the real type from magic bytes (never trust File.type). */
export function sniffMime(bytes) {
  const b = bytes;
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'image/bmp';
  if (b.length >= 12 && ascii(4, 4) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 4))) return 'image/avif';
  return null;
}

function isAnimated(bytes, mime) {
  if (mime === 'image/gif') {
    // Count image descriptors (0x2C after a graphic control block 0x21 0xF9); >1 frame = animated.
    let frames = 0;
    for (let i = 0; i < bytes.length - 2 && frames < 2; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) frames++;
    }
    return frames > 1;
  }
  if (mime === 'image/webp') {
    // VP8X chunk with the animation flag (bit 1 of the flags byte).
    const s = String.fromCharCode(...bytes.subarray(12, 16));
    return s === 'VP8X' && (bytes[20] & 0x02) !== 0;
  }
  return false;
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close?.() };
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty');
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
  } catch {
    throw new Error('That file is not a readable image');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas, mime, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
}

function fit(w, h, maxDim) {
  const s = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

let webpOk; // whether canvas can encode WebP in this browser (Safari historically cannot)

async function encode(img, w, h, maxBytes) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  for (const mime of ['image/webp', 'image/jpeg']) {
    if (mime === 'image/webp' && webpOk === false) continue;
    ctx.clearRect(0, 0, w, h);
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'; // JPEG has no alpha; flatten onto white
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img.source, 0, 0, w, h);
    for (let q = 0.9; q >= 0.35; q -= 0.1) {
      const blob = await toBlob(canvas, mime, q);
      if (!blob) break;
      if (mime === 'image/webp') {
        webpOk = blob.type === 'image/webp';
        if (!webpOk) break;
      }
      if (blob.size <= maxBytes) return { blob, mime };
    }
  }
  return null;
}

/**
 * @param {File|Blob} file
 * @param {{ maxDim?: number, maxBytes?: number, allowAnimated?: boolean }} opts
 * @returns {Promise<{ blob: Blob, mime: string, w: number, h: number, base64: string }>}
 */
export async function processImage(file, { maxDim = 1600, maxBytes = 500 * 1024, allowAnimated = false } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('No image selected');
  if (/svg/i.test(file.type || '')) throw new Error('SVG images are not supported');
  if (file.size > 25 * 1024 * 1024) throw new Error('That image is too large (25 MB max before compression)');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime || !isRasterMime(mime)) throw new Error('Only PNG, JPEG, WebP, GIF, BMP or AVIF images are supported');

  const img = await decode(new Blob([bytes], { type: mime }));
  try {
    if (allowAnimated && (mime === 'image/gif' || mime === 'image/webp') && bytes.length <= maxBytes
      && img.w <= maxDim && img.h <= maxDim && isAnimated(bytes, mime)) {
      return { blob: new Blob([bytes], { type: mime }), mime, w: img.w, h: img.h, base64: bytesToBase64(bytes) };
    }
    let { w, h } = fit(img.w, img.h, maxDim);
    for (;;) {
      const out = await encode(img, w, h, maxBytes);
      if (out) {
        const outBytes = new Uint8Array(await out.blob.arrayBuffer());
        return { blob: out.blob, mime: out.mime, w, h, base64: bytesToBase64(outBytes) };
      }
      if (Math.max(w, h) <= 32) throw new Error('Could not compress that image small enough');
      w = Math.max(1, Math.round(w * 0.8));
      h = Math.max(1, Math.round(h * 0.8));
    }
  } finally {
    img.close();
  }
}

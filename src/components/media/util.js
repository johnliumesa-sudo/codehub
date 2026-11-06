// Normalizers that keep the media UI tolerant of the exact shapes returned by src/lib/media/*.
// Images are only ever shown as data:/blob: URLs (CSP img-src allows data: blob: plus the GIPHY host check below).

const SAFE_MIMES = ['image/webp', 'image/jpeg', 'image/png', 'image/gif'];

/** Turn a lib value (string | {src|url} | {data,mime}) into a safe <img src>, or null. */
export function toSrc(v) {
  if (!v) return null;
  if (typeof v === 'string') return /^(data:image\/|blob:)/.test(v) ? v : null;
  if (v.src || v.url) return toSrc(v.src || v.url);
  if (v.data && v.mime && SAFE_MIMES.includes(v.mime)) return `data:${v.mime};base64,${v.data}`;
  return null;
}

/** Normalize useEmotes() output (array or {eid: emote} map) into [{ id, name, src }] sorted by name. */
export function normalizeEmotes(raw) {
  if (!raw) return [];
  const entries = Array.isArray(raw) ? raw.map((e, i) => [e?.id ?? e?.eid ?? i, e]) : Object.entries(raw);
  const out = [];
  for (const [key, e] of entries) {
    if (!e || typeof e.name !== 'string') continue;
    const src = toSrc(e);
    if (!src) continue;
    out.push({ id: String(e.id ?? e.eid ?? key), name: e.name, src });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const EMOTE_NAME_RE = /^[a-z0-9_]{2,32}$/;
export const EMOTE_MAX_PER_SERVER = 50;
export const ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp,image/gif';
export const MAX_ATTACHMENTS = 4;

export function isRasterImage(file) {
  return !!file && /^image\/(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.type || '');
}

/** Flatten a GIPHY result (raw API object or already-flat) into { id, url, w, h, preview }. */
export function normalizeGif(g) {
  if (!g) return null;
  if (g.url && g.w) return { id: String(g.id || g.url), url: g.url, w: +g.w, h: +g.h, preview: g.preview || g.url };
  const im = g.images || {};
  const main = im.fixed_width || im.downsized || im.original;
  if (!main?.url) return null;
  return {
    id: String(g.id),
    url: main.url,
    w: +main.width || 200,
    h: +main.height || 200,
    preview: (im.fixed_width_small || im.fixed_width || main).url,
  };
}

export function errMsg(e) {
  return (e && (e.message || e.code)) || 'Something went wrong';
}

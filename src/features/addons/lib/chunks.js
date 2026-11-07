// Long strings in the generic rules blocks: udata/sconf leaves are capped at 20000 characters, so a
// pinned add-on copy (up to 64 KB) or a sealed storage blob is stored as numbered fields
// { n, c0, c1, ... } of at most CHUNK characters each (pure, no Firebase).

export const CHUNK = 16000;
export const MAX_CHUNKS = 8;

/** Split a string into pieces of at most `size` UTF-16 units without cutting a surrogate pair. */
export function splitChunks(str, size = CHUNK) {
  const s = String(str ?? '');
  if (!s) return [];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + size);
    const last = s.charCodeAt(end - 1);
    if (end < s.length && last >= 0xd800 && last <= 0xdbff) end -= 1; // keep the pair together
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/** { n, c0..c(n-1), ...extra } for a string (throws if it needs more than MAX_CHUNKS fields). */
export function packChunks(str, extra = {}) {
  const parts = splitChunks(str);
  if (parts.length > MAX_CHUNKS) throw new Error('Too large to store');
  const out = { ...extra, n: parts.length };
  parts.forEach((p, i) => {
    out[`c${i}`] = p;
  });
  return out;
}

/** The string stored by packChunks, or null if the record is malformed or incomplete. */
export function unpackChunks(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const n = rec.n;
  if (!Number.isInteger(n) || n < 0 || n > MAX_CHUNKS) return null;
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = rec[`c${i}`];
    if (typeof c !== 'string' || c.length > CHUNK) return null;
    s += c;
  }
  return s;
}

/** Field paths a packed record may use (so an update can null the ones a shorter value leaves behind). */
export const chunkFields = () => Array.from({ length: MAX_CHUNKS }, (_, i) => `c${i}`);

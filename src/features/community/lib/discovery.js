// Server discovery: pure helpers for the public listing pub/servers/{sid} (PLAINTEXT by design).
//
// pub/servers/{sid} = { name, desc, tags: "a,b,c", glyph, color, members, iid, k, by, ts }
//   iid + k = a dedicated invite (no expiry, no use limit) and the server key, i.e. a public invite:
//   anyone signed in can join and read every message. Only the server's owner can write it (rules).
// sconf/{sid}/discovery/listing = { iid }  so managers can see which invite the listing uses.

export const LISTING_LIMITS = Object.freeze({ name: 64, desc: 300, tags: 5, tag: 20, glyph: 4 });
export const LISTING_COLORS = Object.freeze(['#5b8cff', '#a66bff', '#ff6b9a', '#ff8f4d', '#f5c542', '#3ccf91', '#2bc4d9', '#8892a6']);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_\-+/=%]{16,200}$/;
const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** "Rust, Game Dev ,rust" -> ['rust', 'game-dev'] (lower-case, dashes, unique, at most 5). */
export function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const out = [];
  for (const t of list) {
    const tag = String(t ?? '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, LISTING_LIMITS.tag);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= LISTING_LIMITS.tags) break;
  }
  return out;
}

/** First grapheme-ish of a glyph (emoji or up to 2 letters). */
export function cleanGlyph(g) {
  const s = oneLine(g, 16);
  if (!s) return '';
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment) : [...s];
  const first = seg[0] || '';
  if (/^\p{L}$/u.test(first) && seg[1] && /^\p{L}$/u.test(seg[1])) return (first + seg[1]).toUpperCase();
  return first.length <= 16 ? first : '';
}

/** Owner's form input -> the fields written to pub/servers/{sid} (besides iid/k/by/ts). Throws on bad input. */
export function cleanListing(input) {
  const name = oneLine(input?.name, LISTING_LIMITS.name);
  if (!name) throw new Error('The listing needs a name');
  const desc = oneLine(input?.desc, LISTING_LIMITS.desc);
  if (!desc) throw new Error('Add a short description so people know what the server is about');
  const tags = parseTags(input?.tags);
  const glyph = cleanGlyph(input?.glyph) || name.slice(0, 1).toUpperCase();
  const color = HEX_RE.test(input?.color || '') ? input.color.toLowerCase() : LISTING_COLORS[0];
  const members = Number.isInteger(input?.members) && input.members >= 0 ? Math.min(input.members, 1e6) : 0;
  return { name, desc, tags: tags.join(','), glyph, color, members };
}

/** A listing read from pub/servers (untrusted) -> { sid, name, desc, tags[], glyph, color, members, iid, k, by, ts } or null. */
export function sanitizeListing(sid, raw) {
  if (!ID_RE.test(sid || '') || !raw || typeof raw !== 'object') return null;
  const name = oneLine(raw.name, LISTING_LIMITS.name);
  if (!name || !ID_RE.test(raw.iid || '') || !KEY_RE.test(raw.k || '') || typeof raw.by !== 'string') return null;
  return {
    sid,
    name,
    desc: oneLine(raw.desc, LISTING_LIMITS.desc),
    tags: parseTags(typeof raw.tags === 'string' ? raw.tags : ''),
    glyph: cleanGlyph(raw.glyph) || name.slice(0, 1).toUpperCase(),
    color: HEX_RE.test(raw.color || '') ? raw.color.toLowerCase() : LISTING_COLORS[0],
    members: Number.isInteger(raw.members) && raw.members >= 0 ? raw.members : 0,
    iid: raw.iid,
    k: raw.k,
    by: raw.by,
    ts: typeof raw.ts === 'number' ? raw.ts : 0,
  };
}

/** The app's own invite hash for a listing (handled by the existing invite flow). */
export const listingJoinHash = (l) => `/join/${l.sid}/${l.iid}/${l.k}`;

/** Search (name, description, tags) + tag filter + sort ('members' | 'new'). */
export function filterListings(list, { q = '', tag = '', sort = 'members' } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const out = list.filter((l) => {
    if (tag && !l.tags.includes(tag)) return false;
    if (!words.length) return true;
    const hay = `${l.name} ${l.desc} ${l.tags.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return out.sort(sort === 'new' ? (a, b) => b.ts - a.ts : (a, b) => b.members - a.members || b.ts - a.ts);
}

/** Most used tags first: [{ tag, n }]. */
export function topTags(list, max = 12) {
  const counts = new Map();
  list.forEach((l) => l.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([tag, n]) => ({ tag, n }));
}

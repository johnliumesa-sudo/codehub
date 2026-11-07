// Message links (pure): in-app deep links to one message, as a hash route on the app's own URL.
//   channel  #/m/ch/{sid}/{cid}/{mid}
//   DM       #/m/dm/{dmId}/{mid}
//   group    #/m/grp/{gid}/{mid}
// A link only names ids; opening it still needs membership (and the key) of that conversation.

const ID = '[A-Za-z0-9_-]{1,64}';
const HASH_RE = new RegExp(`^#/m/(?:(ch)/(${ID})/(${ID})|(dm)/(${ID})|(grp)/(${ID}))/(${ID})$`);
const ID_RE = new RegExp(`^${ID}$`);
const URL_RE = /https?:\/\/[^\s<>()"'`]+#\/m\/[A-Za-z0-9_/-]+/g;

const okId = (v) => typeof v === 'string' && ID_RE.test(v);

/** Conversation descriptor (ChatContext conv or a parsed link) -> stable key, or null. */
export function convKey(c) {
  if (!c) return null;
  if (c.kind === 'channel' && okId(c.sid) && okId(c.cid)) return `ch:${c.sid}/${c.cid}`;
  if (c.kind === 'dm' && okId(c.dmId)) return `dm:${c.dmId}`;
  if (c.kind === 'group' && okId(c.gid)) return `grp:${c.gid}`;
  return null;
}

export const sameConv = (a, b) => !!convKey(a) && convKey(a) === convKey(b);

/** Only the ids of a conversation descriptor (what a link or a reminder stores). */
export function convRef(c) {
  if (c?.kind === 'channel') return { kind: 'channel', sid: c.sid, cid: c.cid };
  if (c?.kind === 'dm') return { kind: 'dm', dmId: c.dmId };
  if (c?.kind === 'group') return { kind: 'group', gid: c.gid };
  return null;
}

/** The hash route for a message ("#/m/…"), or null for an invalid descriptor. */
export function messageHash(conv, mid) {
  if (!okId(mid) || !convKey(conv)) return null;
  if (conv.kind === 'channel') return `#/m/ch/${conv.sid}/${conv.cid}/${mid}`;
  if (conv.kind === 'dm') return `#/m/dm/${conv.dmId}/${mid}`;
  return `#/m/grp/${conv.gid}/${mid}`;
}

/** The app's base URL (origin + path, no hash or query). */
export function appBase(loc = typeof location !== 'undefined' ? location : null) {
  return loc ? `${loc.origin}${loc.pathname}` : '';
}

/** Full shareable link for a message. */
export function buildMessageLink(conv, mid, base = appBase()) {
  const h = messageHash(conv, mid);
  return h ? `${base}${h}` : null;
}

/** Parse a hash ("#/m/…") -> { kind, sid?, cid?, dmId?, gid?, mid } or null. */
export function parseMessageHash(hash) {
  const m = HASH_RE.exec(String(hash || ''));
  if (!m) return null;
  if (m[1]) return { kind: 'channel', sid: m[2], cid: m[3], mid: m[8] };
  if (m[4]) return { kind: 'dm', dmId: m[5], mid: m[8] };
  return { kind: 'group', gid: m[7], mid: m[8] };
}

/**
 * Parse a full link. Only links to this app (same origin and path as `base`) count; anything else
 * (another site using the same hash shape) returns null.
 */
export function parseMessageLink(href, base = appBase()) {
  const s = String(href || '');
  const i = s.indexOf('#');
  if (i < 0 || !base || s.slice(0, i) !== base) return null;
  return parseMessageHash(s.slice(i));
}

/** Distinct message links to this app found in message text (at most `max`). */
export function findMessageLinks(text, base = appBase(), max = 3) {
  const out = [];
  const seen = new Set();
  if (typeof text !== 'string' || !text.includes('#/m/')) return out;
  for (const raw of text.match(URL_RE) || []) {
    const t = parseMessageLink(raw.replace(/[.,;:!?)\]]+$/, ''), base);
    if (!t) continue;
    const k = `${convKey(t)}#${t.mid}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** dmId = sorted uids joined by '_' (uids never contain '_'). */
export function dmPeerOf(dmId, myUid) {
  const parts = String(dmId || '').split('_');
  if (parts.length !== 2 || !parts.includes(myUid)) return null;
  return parts[0] === myUid ? parts[1] : parts[0];
}

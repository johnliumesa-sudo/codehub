// Favorites: pure helpers (no Firebase imports; unit-tested in node).
//   udata/{me}/favorites/{key} = { kind: 'channel'|'dm'|'group', sid?, cid?, dmId?, gid?, pos }
//   key = c_{sid}_{cid} | d_{dmId} | g_{gid}. Ids only (no names): names are resolved and decrypted live.

export const FAV_MAX = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DM_RE = /^[A-Za-z0-9-]{1,60}_[A-Za-z0-9-]{1,60}$/; // dmId = two uids joined by '_' (uids never contain '_')

const okId = (v) => typeof v === 'string' && ID_RE.test(v);
const okDm = (v) => typeof v === 'string' && DM_RE.test(v);

/** The favorites key of a conversation ({ kind, sid, cid } | { kind: 'dm', dmId } | { kind: 'group', gid }), or null. */
export function favKey(conv) {
  if (!conv || typeof conv !== 'object') return null;
  if (conv.kind === 'channel' && okId(conv.sid) && okId(conv.cid)) return `c_${conv.sid}_${conv.cid}`;
  if (conv.kind === 'dm' && okDm(conv.dmId)) return `d_${conv.dmId}`;
  if (conv.kind === 'group' && okId(conv.gid)) return `g_${conv.gid}`;
  return null;
}

/** The record stored for a conversation at position `pos` (ids only). */
export function favRecord(conv, pos = 0) {
  const p = Number.isFinite(pos) ? Math.max(0, Math.floor(pos)) : 0;
  if (conv.kind === 'channel') return { kind: 'channel', sid: conv.sid, cid: conv.cid, pos: p };
  if (conv.kind === 'dm') return { kind: 'dm', dmId: conv.dmId, pos: p };
  return { kind: 'group', gid: conv.gid, pos: p };
}

/** The conversation a stored record points to (for openConv), or null when the record is invalid. */
export function favConv(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.kind === 'channel') return { kind: 'channel', sid: rec.sid, cid: rec.cid };
  if (rec.kind === 'dm') return { kind: 'dm', dmId: rec.dmId };
  if (rec.kind === 'group') return { kind: 'group', gid: rec.gid };
  return null;
}

/**
 * udata/{me}/favorites -> ordered list [{ key, kind, sid?, cid?, dmId?, gid?, pos }]. Untrusted input:
 * records whose key doesn't match their own ids are dropped; order is pos, then key.
 */
export function parseFavorites(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  for (const [key, rec] of Object.entries(raw)) {
    const conv = favConv(rec);
    if (!conv || favKey(conv) !== key) continue;
    out.push({ key, ...conv, pos: typeof rec.pos === 'number' && Number.isFinite(rec.pos) ? rec.pos : 0 });
  }
  return out.sort((a, b) => a.pos - b.pos || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Move the item at `from` to index `to` (clamped). Returns a new array. */
export function moveItem(list, from, to) {
  const arr = [...list];
  if (from < 0 || from >= arr.length) return arr;
  const t = Math.max(0, Math.min(arr.length - 1, to));
  const [it] = arr.splice(from, 1);
  arr.splice(t, 0, it);
  return arr;
}

/** Multi-path patch that renumbers positions 0..n-1 in the given key order (only changed ones). */
export function positionsPatch(base, keys, current = {}) {
  const patch = {};
  keys.forEach((k, i) => {
    if (current[k] !== i) patch[`${base}/${k}/pos`] = i;
  });
  return patch;
}

/** Position for a new favorite: after the last one. */
export const nextPos = (list) => list.reduce((m, f) => Math.max(m, f.pos + 1), 0);

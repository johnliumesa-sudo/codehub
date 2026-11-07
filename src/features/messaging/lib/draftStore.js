// Drafts (pure store): per-conversation unsent composer text kept in this browser's localStorage only,
// never in the database. Each draft's text (and the conversation title shown in the sidebar) is
// sealed with the vault key, so a later user of the same browser can't read it after sign-out; the
// conversation ids stay readable so the sidebar can mark conversations with drafts without
// decrypting anything.
//
//   localStorage['codehub.drafts:{uid}'] = { [convKey]: { kind, sid?, cid?, dmId?, gid?, at, iv, ct } }
//   sealed payload (AAD `draft:{uid}/{convKey}`): { text, title }
import { convKey, convRef } from './links.js';

export const STORAGE_PREFIX = 'codehub.drafts:';
export const MAX_DRAFTS = 100;
export const MAX_DRAFT_CHARS = 8000;
export const draftAad = (uid, key) => `draft:${uid}/${key}`;

/**
 * @param {{ storage: Storage-like, seal: (aad, obj) => Promise<{iv, ct}>, open: (aad, box) => Promise<obj>,
 *           now?: () => number }} deps
 */
export function createDraftStore({ storage, seal, open, now = () => Date.now() }) {
  const listeners = new Set();
  const writes = new Map(); // `${uid}|${key}` -> sequence number (last write wins)
  let seq = 0;

  const slot = (uid) => `${STORAGE_PREFIX}${uid}`;

  function readAll(uid) {
    if (!uid) return {};
    try {
      const v = JSON.parse(storage.getItem(slot(uid)) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  function writeAll(uid, map) {
    try {
      if (Object.keys(map).length) storage.setItem(slot(uid), JSON.stringify(map));
      else storage.removeItem(slot(uid));
    } catch {
      /* storage full or unavailable: drafts are best effort */
    }
    emit(uid);
  }

  function emit(uid) {
    for (const fn of [...listeners]) {
      try {
        fn(uid);
      } catch {
        /* ignore */
      }
    }
  }

  /** [{ key, conv, at }] of the user's drafts, newest first (no decryption). */
  function list(uid) {
    return Object.entries(readAll(uid))
      .map(([key, e]) => {
        const conv = convRef(e);
        return conv && convKey(conv) === key ? { key, conv, at: Number(e.at) || 0 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
  }

  function has(uid, conv) {
    const key = convKey(conv);
    return !!key && !!readAll(uid)[key];
  }

  /** Decrypted { text, title } of a conversation's draft, or null. */
  async function get(uid, conv) {
    const key = convKey(conv);
    const e = key ? readAll(uid)[key] : null;
    if (!e || typeof e.iv !== 'string' || typeof e.ct !== 'string') return null;
    try {
      const v = await open(draftAad(uid, key), { iv: e.iv, ct: e.ct });
      return v && typeof v.text === 'string' ? { text: v.text, title: typeof v.title === 'string' ? v.title : '' } : null;
    } catch {
      return null;
    }
  }

  /** Store (or, for blank text, remove) a conversation's draft. Concurrent saves: the last call wins. */
  async function save(uid, conv, text, title = '') {
    const key = convKey(conv);
    if (!uid || !key) return;
    const id = `${uid}|${key}`;
    const mine = ++seq;
    writes.set(id, mine);
    const t = String(text ?? '');
    if (!t.trim()) {
      const map = readAll(uid);
      if (map[key]) {
        delete map[key];
        writeAll(uid, map);
      }
      return;
    }
    const box = await seal(draftAad(uid, key), { text: t.slice(0, MAX_DRAFT_CHARS), title: String(title || '').slice(0, 120) });
    if (writes.get(id) !== mine) return; // a newer save (or clear) happened meanwhile
    const map = readAll(uid);
    map[key] = { ...convRef(conv), at: now(), iv: box.iv, ct: box.ct };
    const keys = Object.keys(map);
    if (keys.length > MAX_DRAFTS) {
      keys.sort((a, b) => (Number(map[a].at) || 0) - (Number(map[b].at) || 0));
      for (const k of keys.slice(0, keys.length - MAX_DRAFTS)) delete map[k];
    }
    writeAll(uid, map);
  }

  function clear(uid, conv) {
    return save(uid, conv, '');
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Call from a window 'storage' event so other tabs' edits show up here. */
  function onStorageEvent(e) {
    if (!e || typeof e.key !== 'string' || !e.key.startsWith(STORAGE_PREFIX)) return;
    emit(e.key.slice(STORAGE_PREFIX.length));
  }

  return { list, has, get, save, clear, subscribe, onStorageEvent };
}

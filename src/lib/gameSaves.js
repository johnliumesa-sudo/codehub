// Saved data of Arcade games (what a game keeps in localStorage), on this device only.
//
// A game runs in an opaque-origin sandbox, so it has no real localStorage. The play runtime gives it
// an in-memory one and, in the Arcade player, sends every change to the parent page (SandboxFrame
// `storage`, token- and source-checked, strings only, ≤ SAVE_MAX_CHARS). This module keeps those
// snapshots per (account, game):
//   - localStorage: IndexedDB database "codehub-game-saves", store "saves", key "<uid>/<gameId>",
//     { key, uid, gameId, data: { k: v }, chars, at }. Never synced, never encrypted (it is the game's
//     own data). Total budget SAVE_TOTAL_CHARS / SAVE_MAX_GAMES; the least recently used are evicted.
//   - sessionStorage: memory only, for this page load (like a browser tab).
// Removed with the account (deleteMyGames -> clearGameSaves) and per game from the player.
import { SAVE_MAX_CHARS, cleanStorageSnapshot, snapshotChars } from './sandboxPlay.js';

export { SAVE_MAX_CHARS } from './sandboxPlay.js';
export const SAVE_TOTAL_CHARS = 8 * 1024 * 1024;
export const SAVE_MAX_GAMES = 200;

const DB_NAME = 'codehub-game-saves';
const STORE = 'saves';
const WRITE_DELAY_MS = 120;

const local = new Map(); // key -> { data, chars, at } (write-through cache)
const session = new Map(); // key -> data
const pending = new Map(); // key -> timer

export const saveKey = (uid, gameId) => `${uid}/${gameId}`;

/**
 * Which saved games to evict so that the total and the count fit the budget. Pure.
 * entries: [{ key, chars, at }]; keep: a key that must stay (the game being played).
 */
export function chooseEvictions(entries, { maxChars = SAVE_TOTAL_CHARS, maxGames = SAVE_MAX_GAMES, keep = null } = {}) {
  let total = entries.reduce((n, e) => n + (Number(e.chars) || 0), 0);
  let count = entries.length;
  const out = [];
  for (const e of [...entries].sort((a, b) => (a.at || 0) - (b.at || 0))) {
    if (total <= maxChars && count <= maxGames) break;
    if (e.key === keep) continue;
    out.push(e.key);
    total -= Number(e.chars) || 0;
    count -= 1;
  }
  return out;
}

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store, (v) => (result = v))).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqValue = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Load a game's saved data into the cache. Resolves { local, session } (never rejects). */
export async function loadGameSave(uid, gameId) {
  if (!uid || !gameId) return { local: {}, session: {} };
  const key = saveKey(uid, gameId);
  if (!local.has(key)) {
    let row = null;
    try {
      const db = await openDb();
      if (db) row = await tx(db, 'readonly', async (store, set) => set(await reqValue(store.get(key))));
    } catch {
      row = null;
    }
    // A write that raced the read wins.
    if (!local.has(key)) {
      const data = cleanStorageSnapshot(row?.data) || {};
      local.set(key, { data, chars: snapshotChars(data), at: Number(row?.at) || 0 });
    }
  }
  return peekGameSave(uid, gameId);
}

/** The cached save (synchronous; after loadGameSave). */
export function peekGameSave(uid, gameId) {
  const key = saveKey(uid, gameId);
  return { local: { ...(local.get(key)?.data || {}) }, session: { ...(session.get(key) || {}) } };
}

async function persist(key) {
  pending.delete(key);
  const entry = local.get(key);
  if (!entry) return;
  try {
    const db = await openDb();
    if (!db) return;
    const [uid, ...rest] = key.split('/');
    const row = { key, uid, gameId: rest.join('/'), data: entry.data, chars: entry.chars, at: entry.at };
    await tx(db, 'readwrite', (store) => {
      if (entry.chars === 0) store.delete(key);
      else store.put(row);
    });
    // Keep the whole store within budget (least recently used first, never the game just saved).
    const all = await tx(db, 'readonly', async (store, set) => set(await reqValue(store.getAll())));
    const evict = chooseEvictions((all || []).map((r) => ({ key: r.key, chars: r.chars, at: r.at })), { keep: key });
    if (evict.length) {
      await tx(db, 'readwrite', (store) => {
        for (const k of evict) store.delete(k);
      });
      for (const k of evict) local.delete(k);
    }
  } catch {
    /* storage full or unavailable: the cache still serves this page load */
  }
}

/** Record a snapshot the game sent (already validated by SandboxFrame). */
export function storeGameSave(uid, gameId, area, data) {
  if (!uid || !gameId) return;
  const clean = cleanStorageSnapshot(data, SAVE_MAX_CHARS);
  if (!clean) return;
  const key = saveKey(uid, gameId);
  if (area === 'session') {
    session.set(key, clean);
    return;
  }
  if (area !== 'local') return;
  local.set(key, { data: clean, chars: snapshotChars(clean), at: Date.now() });
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => persist(key), WRITE_DELAY_MS));
}

/** Forget one game's saved data on this device. */
export async function clearGameSave(uid, gameId) {
  const key = saveKey(uid, gameId);
  clearTimeout(pending.get(key));
  pending.delete(key);
  local.set(key, { data: {}, chars: 0, at: Date.now() });
  session.delete(key);
  try {
    const db = await openDb();
    if (db) await tx(db, 'readwrite', (store) => store.delete(key));
  } catch {
    /* ignore */
  }
}

/** Delete every saved game of `uid` on this device (account deletion). */
export async function clearGameSaves(uid) {
  if (!uid) return;
  const prefix = `${uid}/`;
  for (const k of [...local.keys()]) if (k.startsWith(prefix)) local.delete(k);
  for (const k of [...session.keys()]) if (k.startsWith(prefix)) session.delete(k);
  for (const [k, t] of [...pending]) {
    if (k.startsWith(prefix)) {
      clearTimeout(t);
      pending.delete(k);
    }
  }
  try {
    const db = await openDb();
    if (!db) return;
    const all = await tx(db, 'readonly', async (store, set) => set(await reqValue(store.getAllKeys())));
    const mine = (all || []).filter((k) => String(k).startsWith(prefix));
    if (mine.length) {
      await tx(db, 'readwrite', (store) => {
        for (const k of mine) store.delete(k);
      });
    }
  } catch {
    /* ignore */
  }
}

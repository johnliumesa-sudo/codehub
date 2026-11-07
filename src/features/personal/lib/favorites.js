// Favorites: live store of udata/{me}/favorites (one listener per session, started by the
// FavoritesKeeper app mount) plus the writes. Pure helpers live in favoritesCore.js.
import { useSyncExternalStore } from 'react';
import { onValue, ref, remove, set, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { myUid } from '../../../lib/ext/store.js';
import { FAV_MAX, favKey, favRecord, moveItem, nextPos, parseFavorites, positionsPatch } from './favoritesCore.js';

const EMPTY = Object.freeze({ uid: null, loading: true, list: Object.freeze([]), keys: new Set() });
let snap = EMPTY;
let active = null; // { uid, unsub, refs }
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error('[favorites] listener failed', e);
    }
  });
}

/** Start (or keep) the live subscription for `uid`. Returns a release function. */
export function retainFavorites(uid) {
  if (!uid) return () => {};
  if (active && active.uid !== uid) {
    active.unsub();
    active = null;
  }
  if (!active) {
    snap = { ...EMPTY, uid };
    const unsub = onValue(
      ref(db, `udata/${uid}/favorites`),
      (s) => {
        const list = Object.freeze(parseFavorites(s.val()));
        snap = { uid, loading: false, list, keys: new Set(list.map((f) => f.key)) };
        emit();
      },
      () => {
        snap = { uid, loading: false, list: Object.freeze([]), keys: new Set() };
        emit();
      },
    );
    active = { uid, unsub, refs: 0 };
    emit();
  }
  active.refs += 1;
  const mine = active;
  return () => {
    mine.refs -= 1;
    if (mine.refs <= 0 && active === mine) {
      mine.unsub();
      active = null;
      snap = EMPTY;
      emit();
    }
  };
}

export function subscribeFavorites(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Current favorites snapshot: { uid, loading, list, keys }. */
export const getFavorites = () => snap;
export const isFavorite = (conv) => {
  const k = favKey(conv);
  return !!k && snap.keys.has(k);
};

/** React hook: { loading, list, keys } (live while the keeper runs). */
export function useFavorites() {
  return useSyncExternalStore(subscribeFavorites, getFavorites, getFavorites);
}

const base = () => `udata/${myUid()}/favorites`;

/** Star or unstar a conversation. Resolves to true when it is now a favorite. */
export async function toggleFavorite(conv) {
  const key = favKey(conv);
  if (!key) throw new Error("This conversation can't be added to Favorites");
  if (snap.keys.has(key)) {
    await remove(ref(db, `${base()}/${key}`));
    return false;
  }
  if (snap.list.length >= FAV_MAX) throw new Error(`You can have up to ${FAV_MAX} favorites. Remove one first.`);
  await set(ref(db, `${base()}/${key}`), favRecord(conv, nextPos(snap.list)));
  return true;
}

export function removeFavorite(key) {
  return remove(ref(db, `${base()}/${key}`));
}

/** Move favorite `key` to index `to` and renumber positions in one update. */
export async function moveFavorite(key, to) {
  const list = snap.list;
  const from = list.findIndex((f) => f.key === key);
  if (from < 0) return;
  const order = moveItem(list, from, to).map((f) => f.key);
  const current = Object.fromEntries(list.map((f) => [f.key, f.pos]));
  const patch = positionsPatch(base(), order, current);
  if (Object.keys(patch).length) await update(ref(db), patch);
}

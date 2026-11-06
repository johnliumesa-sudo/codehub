// User blocking (F11).
//
// blocks/{uid}/{otherUid} = true — readable and writable by its owner only. The rules use it to stop a
// blocked user from: sending me DM messages or DM reactions, re-adding our DM to my index, sending me
// friend requests, and adding me to a group or codespace. In servers and groups we already share,
// their messages are hidden client-side only (BlockedGate) — the server still delivers them.
//
// Blocking also removes any friendship / pending request (both halves; either party may delete them)
// and hides our DM from my list, all in one multi-path update.
import { useEffect, useState } from 'react';
import { onValue, ref, update } from 'firebase/database';
import { db } from './firebase.js';
import { dmIdFor } from './crypto.js';

const uidOf = (me) => (typeof me === 'string' ? me : me?.uid) || null;
const EMPTY = new Set();

// ---------- Shared live subscription (one listener per signed-in uid, ref-counted) ----------
// BlockedGate renders once per message, so every consumer shares a single RTDB listener.

const stores = new Map(); // uid -> { set, listeners:Set, unsub, idle }
const IDLE_MS = 30_000;

function subscribe(uid, fn) {
  let s = stores.get(uid);
  if (!s) {
    const entry = { set: null, listeners: new Set(), unsub: null, idle: null };
    s = entry;
    stores.set(uid, entry);
    entry.unsub = onValue(
      ref(db, `blocks/${uid}`),
      (snap) => {
        const v = snap.val() || {};
        entry.set = new Set(Object.keys(v).filter((k) => v[k] === true));
        entry.listeners.forEach((l) => l(entry.set));
      },
      () => {
        // Cancelled (signed out / permission denied): forget it so a later subscriber starts fresh.
        if (stores.get(uid) === entry) stores.delete(uid);
        entry.set = EMPTY;
        entry.listeners.forEach((l) => l(EMPTY));
      },
    );
  }
  const e = s;
  clearTimeout(e.idle);
  e.idle = null;
  e.listeners.add(fn);
  if (e.set) fn(e.set);
  return () => {
    e.listeners.delete(fn);
    if (e.listeners.size === 0 && stores.get(uid) === e) {
      e.idle = setTimeout(() => {
        if (e.listeners.size === 0 && stores.get(uid) === e) {
          stores.delete(uid);
          e.unsub?.();
        }
      }, IDLE_MS);
    }
  };
}

/** Live Set of uids I have blocked (empty while loading). `me` may be a uid or `{ uid }`. */
export function useBlocks(me) {
  const uid = uidOf(me);
  const [set, setSet] = useState(() => (uid && stores.get(uid)?.set) || EMPTY);
  useEffect(() => {
    if (!uid) {
      setSet(EMPTY);
      return undefined;
    }
    return subscribe(uid, setSet);
  }, [uid]);
  return uid ? set : EMPTY;
}

/** Convenience: true when `me` has blocked `other`. */
export function useIsBlocked(me, other) {
  const set = useBlocks(me);
  return !!other && set.has(other);
}

/**
 * Block `other`: blocks/{me}/{other} = true, remove the friendship / requests on both sides and hide
 * our DM from my list — one atomic multi-path update.
 */
export async function block(me, other) {
  const uid = uidOf(me);
  if (!uid) throw new Error('Not signed in');
  if (!other || other === uid) throw new Error("You can't block yourself");
  await update(ref(db), {
    [`blocks/${uid}/${other}`]: true,
    [`friends/${uid}/${other}`]: null,
    [`friends/${other}/${uid}`]: null,
    [`userDms/${uid}/${dmIdFor(uid, other)}`]: null,
  });
}

/** Unblock `other`. Friendship is not restored; either side can send a new request. */
export async function unblock(me, other) {
  const uid = uidOf(me);
  if (!uid) throw new Error('Not signed in');
  if (!other) return;
  await update(ref(db), { [`blocks/${uid}/${other}`]: null });
}

/** Paths deleteAccount() must clear for `uid` (the rules allow deleting the whole node). */
export const blockCleanupPaths = (uid) => [`blocks/${uid}`];

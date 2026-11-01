// Shared, live-updating cache of public user profiles (users/{uid}).
import { useEffect, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from './firebase.js';

const cache = new Map(); // uid -> { value, listeners:Set, unsub, idleTimer }
const IDLE_MS = 30_000; // keep an unused listener briefly so remounts don't refetch

function drop(uid, entry) {
  if (cache.get(uid) === entry) cache.delete(uid);
  clearTimeout(entry.idleTimer);
  entry.unsub?.();
  entry.unsub = null;
}

function subscribe(uid, fn) {
  let entry = cache.get(uid);
  if (!entry) {
    const e = { value: null, listeners: new Set(), unsub: null, idleTimer: null };
    entry = e;
    cache.set(uid, e);
    e.unsub = onValue(
      ref(db, `users/${uid}`),
      (s) => {
        e.value = s.val() ? { uid, ...s.val() } : { uid, name: 'Deleted user', color: '#777', deleted: true };
        e.listeners.forEach((l) => l(e.value));
      },
      // RTDB cancels listeners for good on permission_denied (e.g. sign-out). Forget the entry so
      // the next subscriber (after signing back in) creates a live listener instead of a frozen one.
      () => drop(uid, e),
    );
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.listeners.add(fn);
  if (entry.value) fn(entry.value);
  const e = entry;
  return () => {
    e.listeners.delete(fn);
    if (e.listeners.size === 0 && cache.get(uid) === e) {
      clearTimeout(e.idleTimer);
      e.idleTimer = setTimeout(() => {
        if (e.listeners.size === 0) drop(uid, e);
      }, IDLE_MS);
    }
  };
}

/** Drop every cached profile listener (call on sign-out / lock). */
export function resetProfiles() {
  for (const [uid, e] of [...cache]) drop(uid, e);
}

export function useProfile(uid) {
  const [p, setP] = useState(() => (uid && cache.get(uid)?.value) || null);
  useEffect(() => (uid ? subscribe(uid, setP) : undefined), [uid]);
  return p;
}

export function useProfiles(uids) {
  const key = [...new Set(uids)].sort().join(',');
  const [map, setMap] = useState({});
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    const unsubs = ids.map((uid) => subscribe(uid, (v) => setMap((m) => (m[uid] === v ? m : { ...m, [uid]: v }))));
    return () => unsubs.forEach((u) => u());
  }, [key]);
  return map;
}

export function initials(name = '?') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export const AVATAR_COLORS = ['#5b8cff', '#a66bff', '#ff6b9a', '#ff8f4d', '#f5c542', '#3ccf91', '#2bc4d9', '#8892a6'];

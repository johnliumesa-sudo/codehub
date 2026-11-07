// Shared, reference-counted live subscriptions and a decryption cache for the community features.
// Many components (sidebar, panel, message cards, the reminder scheduler, the send hooks) look at
// the same few paths; they share one RTDB listener per path. Everything is dropped on vault lock.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { get, onValue, ref } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { onLock } from '../../../lib/keystore.js';

const IDLE = Object.freeze({ loading: false, value: null, error: null });
const LOADING = Object.freeze({ loading: true, value: null, error: null });
const subs = new Map(); // path -> { snap, fns:Set, off, timer }

function entryOf(path) {
  let e = subs.get(path);
  if (!e) {
    e = { snap: LOADING, fns: new Set(), off: null, timer: null };
    subs.set(path, e);
  }
  return e;
}

/** Watch a path; fn() runs on every change. Returns unwatch. Listeners linger 2 s for remounts. */
export function watch(path, fn) {
  const e = entryOf(path);
  e.fns.add(fn);
  clearTimeout(e.timer);
  if (!e.off) {
    e.off = onValue(
      ref(db, path),
      (s) => {
        e.snap = { loading: false, value: s.val(), error: null };
        e.fns.forEach((f) => f());
      },
      (error) => {
        e.snap = { loading: false, value: null, error };
        e.off = null; // RTDB cancelled it; the next watcher after a remount retries
        e.fns.forEach((f) => f());
      },
    );
  }
  return () => {
    e.fns.delete(fn);
    if (e.fns.size) return;
    e.timer = setTimeout(() => {
      if (e.fns.size) return;
      e.off?.();
      subs.delete(path);
    }, 2000);
  };
}

/** Current snapshot of a watched path ({ loading, value, error }). */
export const peek = (path) => (path ? subs.get(path)?.snap || LOADING : IDLE);

/** Live value of a path (null path = idle). */
export function useLive(path) {
  const sub = useCallback((fn) => (path ? watch(path, fn) : () => {}), [path]);
  const snap = useCallback(() => peek(path), [path]);
  return useSyncExternalStore(sub, snap, snap);
}

/** One-shot read that reuses a live snapshot when one is loaded. */
export async function readOnce(path) {
  const e = subs.get(path);
  if (e && e.off && !e.snap.loading && !e.snap.error) return e.snap.value;
  return (await get(ref(db, path))).val();
}

// ---------- decryption cache ----------

const plain = new Map(); // `${aad}|${iv}|${ct}` -> value | Error
const inflight = new Map(); // same key -> Promise

/** Decrypt once per (aad, box); resolves to the value or rejects with the cached error. */
export function openCached(aad, box, open) {
  const k = `${aad}|${box?.iv}|${box?.ct}`;
  if (plain.has(k)) {
    const v = plain.get(k);
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  }
  if (inflight.has(k)) return inflight.get(k);
  const p = Promise.resolve()
    .then(open)
    .then(
      (v) => { plain.set(k, v); return v; },
      (e) => { const err = e instanceof Error ? e : new Error(String(e)); plain.set(k, err); throw err; },
    )
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
export const peekCached = (aad, box) => plain.get(`${aad}|${box?.iv}|${box?.ct}`);

/**
 * React hook: decrypt a list of { key, aad, box } items. Returns a stable map
 * { [key]: value | Error | undefined } (undefined while pending). `open(aad, box)` decrypts.
 */
export function useDecrypted(items, open) {
  const [ver, setVer] = useState(0);
  const out = useMemo(() => {
    const o = {};
    for (const it of items) o[it.key] = peekCached(it.aad, it.box);
    return o;
  }, [items, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    let stale = false;
    for (const it of items) {
      const v = peekCached(it.aad, it.box);
      if (v !== undefined) {
        if (out[it.key] !== v) stale = true; // decrypted elsewhere since this render
        continue;
      }
      openCached(it.aad, it.box, () => open(it.aad, it.box)).catch(() => {}).finally(() => alive && setVer((n) => n + 1));
    }
    if (stale) setVer((n) => n + 1);
    return () => { alive = false; };
  }, [items, open, out]);
  return out;
}

onLock(() => {
  plain.clear();
  inflight.clear();
  for (const e of subs.values()) {
    clearTimeout(e.timer);
    e.off?.();
  }
  subs.clear();
});

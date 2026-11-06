// Shared media caches.
//
// 1. createSharedStore(): one RTDB listener per key, shared by every component that renders it,
//    reference-counted with a linger so that remounts (navigation, list virtualisation) never
//    re-download. Values stay cached for the session (cleared on vault lock).
// 2. blobCache: an in-memory LRU of object URLs bounded by total bytes (default 50 MB). Entries that
//    are on screen are pinned and never revoked; unpinned ones are evicted oldest first.
import { useEffect, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from '../firebase.js';
import { onLock } from '../keystore.js';

const LINGER_MS = 5 * 60 * 1000;
const stores = new Set();

/**
 * @param {(key: string) => string} pathOf  RTDB path for a key
 * @param {(raw: any, key: string) => any | Promise<any>} transform  snapshot value -> cached value (null = none)
 */
export function createSharedStore(pathOf, transform) {
  const entries = new Map(); // key -> { value, loaded, subs:Set, unsub, timer, gen }

  function entry(key) {
    let e = entries.get(key);
    if (!e) {
      e = { value: null, loaded: false, subs: new Set(), unsub: null, timer: null, gen: 0 };
      entries.set(key, e);
    }
    return e;
  }

  function emit(e) {
    for (const fn of e.subs) fn(e.value);
  }

  function attach(key, e) {
    if (e.unsub) return;
    e.unsub = onValue(
      ref(db, pathOf(key)),
      (snap) => {
        const gen = ++e.gen;
        Promise.resolve()
          .then(() => (snap.exists() ? transform(snap.val(), key) : null))
          .catch(() => null)
          .then((value) => {
            if (gen !== e.gen) return; // a newer snapshot superseded this one
            e.value = value ?? null;
            e.loaded = true;
            emit(e);
          });
      },
      () => {
        e.value = null;
        e.loaded = true;
        e.unsub = null;
        emit(e);
      },
    );
  }

  function subscribe(key, fn) {
    const e = entry(key);
    clearTimeout(e.timer);
    e.timer = null;
    e.subs.add(fn);
    attach(key, e);
    if (e.loaded) fn(e.value);
    return () => {
      e.subs.delete(fn);
      if (e.subs.size === 0 && e.unsub) {
        e.timer = setTimeout(() => {
          if (e.subs.size === 0 && e.unsub) {
            e.unsub();
            e.unsub = null;
          }
        }, LINGER_MS);
      }
    };
  }

  /** Synchronous peek at the cached value (undefined when never loaded). */
  function peek(key) {
    const e = entries.get(key);
    return e && e.loaded ? e.value : undefined;
  }

  /** Resolves with the current value, waiting for the first snapshot if needed. */
  function read(key) {
    const cur = peek(key);
    if (cur !== undefined) return Promise.resolve(cur);
    return new Promise((resolve) => {
      const off = subscribe(key, (v) => {
        queueMicrotask(() => off());
        resolve(v);
      });
    });
  }

  function clear() {
    for (const e of entries.values()) {
      clearTimeout(e.timer);
      if (e.unsub) e.unsub();
    }
    entries.clear();
  }

  const store = { subscribe, peek, read, clear };
  stores.add(store);
  return store;
}

/** React hook over a shared store. Returns null while loading or when absent. */
export function useShared(store, key) {
  const [value, setValue] = useState(() => (key ? store.peek(key) ?? null : null));
  useEffect(() => {
    if (!key) {
      setValue(null);
      return undefined;
    }
    setValue(store.peek(key) ?? null);
    return store.subscribe(key, setValue);
  }, [store, key]);
  return value;
}

// ---------- Object-URL LRU ----------

export const BLOB_CACHE_MAX_BYTES = 50 * 1024 * 1024;

class BlobCache {
  constructor(maxBytes) {
    this.max = maxBytes;
    this.bytes = 0;
    this.map = new Map(); // key -> { url, size, pins } (Map order = LRU order)
    this.pending = new Map(); // key -> Promise<url>
  }

  /** Returns a cached URL (and marks it most recently used), or null. */
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    this.map.delete(key);
    this.map.set(key, e);
    return e.url;
  }

  /** Loads via `loader() -> Promise<Blob>` once; concurrent callers share the promise. */
  load(key, loader) {
    const hit = this.get(key);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(key);
    if (!p) {
      p = Promise.resolve()
        .then(loader)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          this.map.set(key, { url, size: blob.size, pins: 0 });
          this.bytes += blob.size;
          this.evict();
          return url;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  pin(key) {
    const e = this.map.get(key);
    if (e) e.pins++;
  }

  unpin(key) {
    const e = this.map.get(key);
    if (e && e.pins > 0) e.pins--;
    this.evict();
  }

  drop(key) {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.bytes -= e.size;
    URL.revokeObjectURL(e.url);
  }

  evict() {
    if (this.bytes <= this.max) return;
    for (const [key, e] of this.map) {
      if (this.bytes <= this.max) break;
      if (e.pins > 0) continue;
      this.drop(key);
    }
  }

  clear() {
    for (const e of this.map.values()) URL.revokeObjectURL(e.url);
    this.map.clear();
    this.pending.clear();
    this.bytes = 0;
  }
}

export const blobCache = new BlobCache(BLOB_CACHE_MAX_BYTES);

onLock(() => {
  for (const s of stores) s.clear();
  blobCache.clear();
});

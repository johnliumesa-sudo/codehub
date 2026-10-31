// Presence: presence/{uid} = { state: 'online'|'idle'|'offline', lastChanged }.
// Plaintext by design (documented). Uses .info/connected + onDisconnect so a closed tab
// or dropped connection flips the user to offline server-side.
import { useEffect, useState } from 'react';
import { onDisconnect, onValue, ref, serverTimestamp, set } from 'firebase/database';
import { db } from './firebase.js';

const IDLE_AFTER_MS = 5 * 60 * 1000; // no input for 5 min -> idle
const HIDDEN_IDLE_AFTER_MS = 2 * 60 * 1000; // tab hidden for 2 min -> idle
const CHECK_EVERY_MS = 15 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'];

let current = null; // the single active presence session for this tab

/**
 * Start publishing presence for `uid`. Returns a stop function (async; resolves once the
 * offline marker is written). Calling it again for another uid stops the previous session.
 */
export function startPresence(uid) {
  if (!uid) return () => Promise.resolve();
  if (current) {
    if (current.uid === uid) return current.stop;
    current.stop();
  }

  const myRef = ref(db, `presence/${uid}`);
  const connectedRef = ref(db, '.info/connected');
  let stopped = false;
  let connected = false;
  let state = 'online';
  let lastActivity = Date.now();
  let hiddenSince = typeof document !== 'undefined' && document.hidden ? Date.now() : null;

  const write = (s) =>
    set(myRef, { state: s, lastChanged: serverTimestamp() }).catch((e) => {
      console.warn('[presence] write failed', e);
    });

  const setState = (next) => {
    if (next === state) return;
    state = next;
    if (connected && !stopped) write(state);
  };

  const evaluate = () => {
    if (stopped) return;
    const now = Date.now();
    const idle =
      now - lastActivity > IDLE_AFTER_MS || (hiddenSince !== null && now - hiddenSince > HIDDEN_IDLE_AFTER_MS);
    setState(idle ? 'idle' : 'online');
  };

  let lastActivityHandled = 0;
  const onActivity = () => {
    const now = Date.now();
    lastActivity = now;
    // Throttle: only re-evaluate at most once per second.
    if (state !== 'online' && now - lastActivityHandled > 1000) {
      lastActivityHandled = now;
      evaluate();
    }
  };

  const onVisibility = () => {
    if (document.hidden) hiddenSince = Date.now();
    else {
      hiddenSince = null;
      lastActivity = Date.now();
    }
    evaluate();
  };

  const unsubConnected = onValue(connectedRef, (snap) => {
    connected = snap.val() === true;
    if (!connected || stopped) return;
    // Register the server-side "offline on disconnect" first, then announce ourselves.
    onDisconnect(myRef)
      .set({ state: 'offline', lastChanged: serverTimestamp() })
      .then(() => {
        if (!stopped) return write(state);
      })
      .catch((e) => console.warn('[presence] onDisconnect failed', e));
  });

  ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
  document.addEventListener('visibilitychange', onVisibility);
  const timer = setInterval(evaluate, CHECK_EVERY_MS);

  let stopPromise = null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    unsubConnected();
    clearInterval(timer);
    ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
    document.removeEventListener('visibilitychange', onVisibility);
    if (current && current.stop === stop) current = null;
    stopPromise = Promise.allSettled([
      onDisconnect(myRef).cancel(),
      set(myRef, { state: 'offline', lastChanged: serverTimestamp() }),
    ]).then(() => undefined);
    return stopPromise;
  };

  current = { uid, stop };
  return stop;
}

/** Stop whichever presence session is active in this tab (e.g. right before signOut). */
export function stopPresence() {
  return current ? current.stop() : Promise.resolve();
}

// ---------- Reading presence (shared listener cache) ----------

const cache = new Map(); // uid -> { value, listeners:Set, unsub }

function normalize(v) {
  const s = v && v.state;
  return s === 'online' || s === 'idle' ? s : 'offline';
}

function subscribe(uid, fn) {
  let entry = cache.get(uid);
  if (!entry) {
    entry = { value: 'offline', ready: false, listeners: new Set(), unsub: null };
    cache.set(uid, entry);
    entry.unsub = onValue(
      ref(db, `presence/${uid}`),
      (s) => {
        entry.value = normalize(s.val());
        entry.ready = true;
        entry.listeners.forEach((l) => l(entry.value));
      },
      () => {
        entry.value = 'offline';
        entry.listeners.forEach((l) => l(entry.value));
      },
    );
  }
  entry.listeners.add(fn);
  if (entry.ready) fn(entry.value);
  return () => {
    entry.listeners.delete(fn);
    if (entry.listeners.size === 0) {
      // Keep it briefly in case another component re-subscribes on the next render.
      setTimeout(() => {
        if (entry.listeners.size === 0 && cache.get(uid) === entry) {
          entry.unsub && entry.unsub();
          cache.delete(uid);
        }
      }, 5000);
    }
  };
}

/** Live presence for one user: 'online' | 'idle' | 'offline'. */
export function usePresence(uid) {
  const [s, setS] = useState(() => (uid && cache.get(uid)?.value) || 'offline');
  useEffect(() => {
    if (!uid) {
      setS('offline');
      return undefined;
    }
    return subscribe(uid, setS);
  }, [uid]);
  return s;
}

/** Live presence for many users: { [uid]: 'online'|'idle'|'offline' }. */
export function usePresences(uids) {
  const key = [...new Set((uids || []).filter(Boolean))].sort().join(',');
  const [map, setMap] = useState({});
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    const unsubs = ids.map((uid) => subscribe(uid, (v) => setMap((m) => (m[uid] === v ? m : { ...m, [uid]: v }))));
    return () => unsubs.forEach((u) => u());
  }, [key]);
  return map;
}

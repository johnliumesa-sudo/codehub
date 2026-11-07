// Appearance settings store: localStorage `codehub.appearance` = { ...settings, sync, seen, ts },
// applied to <html> (see appearanceCore.js). Other tabs follow through the storage event.
//
// Sync (optional, per device): while on, this device uploads its settings to
// udata/{me}/appearance/prefs = { ...settings, ts } and adopts a newer copy from another device. A
// fresh browser (nothing stored yet) adopts an existing copy and turns sync on. Turning sync off
// removes the copy; a device that synced before and finds the copy gone turns its own sync off.
// The AppearanceKeeper app mount provides the database adapter (setAppearanceRemote).
import { useSyncExternalStore } from 'react';
import { APPEARANCE_EVENT, APPEARANCE_KEY, applyAppearanceTo, cleanAppearance, sameAppearance } from './appearanceCore.js';

const MQ = '(prefers-reduced-motion: reduce)';
const FRESH = Object.freeze({ prefs: cleanAppearance(null), sync: false, seen: false, ts: 0, stored: false });

function readStored() {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return FRESH;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return FRESH;
    return { prefs: cleanAppearance(v), sync: v.sync === true, seen: v.seen === true, ts: typeof v.ts === 'number' ? v.ts : 0, stored: true };
  } catch {
    return FRESH;
  }
}

let snap = readStored();
const listeners = new Set();
let remote = null; // { push(prefs, ts) -> Promise, remove() -> Promise }

function systemReduce() {
  try {
    return typeof matchMedia === 'function' && matchMedia(MQ).matches;
  } catch {
    return false;
  }
}

function apply() {
  if (typeof document === 'undefined') return;
  applyAppearanceTo(document.documentElement, snap.prefs, systemReduce());
}

function commit(next) {
  snap = next;
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...snap.prefs, sync: snap.sync, seen: snap.seen, ts: snap.ts }));
  } catch {
    /* storage blocked: the settings still apply for this session */
  }
  apply();
  listeners.forEach((fn) => fn());
  try {
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: snap }));
  } catch {
    /* non-browser */
  }
}

function upload() {
  if (!remote || !snap.sync) return;
  const at = snap.ts;
  remote.push(snap.prefs, at).then(
    () => {
      if (snap.sync && !snap.seen) commit({ ...snap, seen: true });
    },
    (e) => console.warn('[appearance] sync failed', e),
  );
}

/** { prefs, sync, seen, ts, stored } (stable object until something changes). */
export const getAppearance = () => snap;

/** Change some settings on this device (and the synced copy when sync is on). */
export function setAppearance(patch) {
  const prefs = cleanAppearance({ ...snap.prefs, ...patch });
  if (sameAppearance(prefs, snap.prefs) && snap.stored) return;
  commit({ ...snap, prefs, ts: Date.now(), stored: true });
  upload();
}

/** Back to the defaults (keeps the sync choice). */
export const resetAppearance = () => setAppearance(cleanAppearance(null));

/** Turn syncing on (uploads these settings) or off (removes the synced copy) for this device. */
export function setAppearanceSync(on) {
  if (on) {
    commit({ ...snap, sync: true, seen: false, stored: true, ts: snap.ts || Date.now() });
    upload();
  } else {
    commit({ ...snap, sync: false, seen: false, stored: true });
    remote?.remove().catch((e) => console.warn('[appearance] removing the synced copy failed', e));
  }
}

/** The synced copy changed (or exists on a fresh browser): adopt it when it should win. */
export function onRemoteAppearance(value) {
  if (value && typeof value === 'object') {
    const ts = typeof value.ts === 'number' ? value.ts : 0;
    if (!snap.stored || (snap.sync && ts > snap.ts)) {
      commit({ prefs: cleanAppearance(value), sync: true, seen: true, ts, stored: true });
    } else if (snap.sync && !snap.seen) {
      commit({ ...snap, seen: true });
    }
    return;
  }
  if (!snap.sync) return;
  if (snap.seen) commit({ ...snap, sync: false, seen: false }); // turned off on another device
  else upload(); // just turned on here, or the first upload never landed
}

/** The keeper's database adapter (null when signed out). */
export function setAppearanceRemote(adapter) {
  remote = adapter && typeof adapter.push === 'function' && typeof adapter.remove === 'function' ? adapter : null;
}

export function subscribeAppearance(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook: { prefs, sync, seen, ts, stored }. */
export function useAppearance() {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

const clockOf = () => snap.prefs.clock;
/** React hook: the chosen clock ('auto' | '12' | '24'), for chat timestamps. */
export function useClockFormat() {
  return useSyncExternalStore(subscribeAppearance, clockOf, clockOf);
}

let started = false;
/** Apply now and follow the device's reduced-motion setting and other tabs. Idempotent. */
export function initAppearance() {
  apply();
  if (started || typeof window === 'undefined') return;
  started = true;
  try {
    const mq = matchMedia(MQ);
    const on = () => apply();
    if (mq.addEventListener) mq.addEventListener('change', on);
    else if (mq.addListener) mq.addListener(on);
  } catch {
    /* no matchMedia */
  }
  window.addEventListener('storage', (e) => {
    if (e.key !== APPEARANCE_KEY && e.key !== null) return;
    snap = readStored();
    apply();
    listeners.forEach((fn) => fn());
  });
}

/** True while the device asks for reduced motion (for the settings hint). */
export const deviceReducesMotion = systemReduce;

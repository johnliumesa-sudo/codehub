// Presence: presence/{uid} = { state: 'online'|'idle'|'offline', lastChanged }.
// Plaintext by design (documented). Uses .info/connected + onDisconnect so a closed tab
// or dropped connection flips the user to offline server-side.
//
// Status modes (round 3, personal; docs/features/personal.md): udata/{uid}/status/mode
// ('online' | 'idle' | 'dnd' | 'invisible', private, synced across my devices) decides what this tab
// writes: invisible -> 'offline', idle -> 'idle', online and dnd -> automatic ('idle' after 10 minutes
// without input in any open Codehub tab, back to 'online' on activity). The first write waits for the
// mode, so an invisible user never flashes online. Readers combine presence with the public record
// upub/{uid}/status/now, so usePresence() returns 'online' | 'idle' | 'dnd' | 'offline'.
import { useEffect, useState } from 'react';
import { onDisconnect, onValue, ref, serverTimestamp, set } from 'firebase/database';
import { db } from './firebase.js';
import { effectivePresence, normalizeMode, presenceToWrite } from '../features/personal/lib/statusCore.js';

const IDLE_AFTER_MS = 10 * 60 * 1000; // no input (in any tab) for 10 min -> idle; a hidden tab gets no input
const CHECK_EVERY_MS = 15 * 1000;
const MODE_WAIT_MS = 6000; // announce anyway if the mode never loads
const HEAL_EVERY_MS = 5000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'];
const ACTIVITY_KEY = 'codehub.activity'; // last input in any tab (ms), shared through localStorage
const MODE_CACHE_KEY = 'codehub.statusMode'; // last known mode, used only until the database answers

let current = null; // the single active presence session for this tab

// ---------- My status mode (shared with notify.js for Do Not Disturb) ----------

let myMode = 'online';
const modeListeners = new Set();

function setMyMode(next) {
  const m = normalizeMode(next);
  if (m === myMode) return;
  myMode = m;
  modeListeners.forEach((fn) => {
    try {
      fn(m);
    } catch (e) {
      console.error('[presence] mode listener failed', e);
    }
  });
}

/** My chosen status mode in this tab's session: 'online' | 'idle' | 'dnd' | 'invisible'. */
export const getMyStatusMode = () => myMode;
/** Do Not Disturb: desktop notifications and the ringtone stay quiet (unread counts don't change). */
export const isDoNotDisturb = () => myMode === 'dnd';
/** Called with the new mode whenever it changes. Returns an unsubscribe function. */
export function onStatusModeChange(fn) {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

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
  const modeRef = ref(db, `udata/${uid}/status/mode`);
  let stopped = false;
  let connected = false;
  let modeReady = false;
  let auto = 'online'; // from activity
  let written = null; // last state this tab wrote since it (re)connected
  let lastActivity = Date.now();
  let lastShared = 0;
  let lastHeal = 0;

  const desired = () => presenceToWrite(myMode, auto);

  const write = (s) => {
    written = s;
    return set(myRef, { state: s, lastChanged: serverTimestamp() }).catch((e) => {
      console.warn('[presence] write failed', e);
    });
  };

  const sync = () => {
    if (stopped || !connected || !modeReady) return;
    const s = desired();
    if (s !== written) write(s);
  };

  const sharedActivity = () => Math.max(lastActivity, Number(readLocal(ACTIVITY_KEY)) || 0);

  const evaluate = () => {
    if (stopped) return;
    auto = Date.now() - sharedActivity() > IDLE_AFTER_MS ? 'idle' : 'online';
    sync();
  };

  let lastActivityHandled = 0;
  const onActivity = () => {
    const now = Date.now();
    lastActivity = now;
    if (now - lastShared > 5000) {
      lastShared = now;
      writeLocal(ACTIVITY_KEY, String(now));
    }
    // Throttle: only re-evaluate at most once per second.
    if (auto !== 'online' && now - lastActivityHandled > 1000) {
      lastActivityHandled = now;
      evaluate();
    }
  };

  const onVisibility = () => {
    if (!document.hidden) onActivity();
    evaluate();
  };

  // Activity in another tab brings this one back too.
  const onStorage = (e) => {
    if (e.key === ACTIVITY_KEY && auto !== 'online') evaluate();
  };

  const markModeReady = () => {
    if (modeReady || stopped) return;
    modeReady = true;
    evaluate();
  };

  const cached = readLocal(MODE_CACHE_KEY);
  if (cached) setMyMode(cached);
  const unsubMode = onValue(
    modeRef,
    (snap) => {
      const m = normalizeMode(snap.val());
      writeLocal(MODE_CACHE_KEY, m);
      setMyMode(m);
      if (modeReady) sync();
      else markModeReady();
    },
    () => markModeReady(),
  );
  const modeTimer = setTimeout(markModeReady, MODE_WAIT_MS);

  const unsubConnected = onValue(connectedRef, (snap) => {
    connected = snap.val() === true;
    written = null;
    if (!connected || stopped) return;
    // Register the server-side "offline on disconnect" first, then announce ourselves.
    onDisconnect(myRef)
      .set({ state: 'offline', lastChanged: serverTimestamp() })
      .then(() => sync())
      .catch((e) => console.warn('[presence] onDisconnect failed', e));
  });

  // Another tab of mine closing marks me offline through its onDisconnect: put my state back.
  const unsubSelf = onValue(myRef, (snap) => {
    if (stopped || !connected || !modeReady || written === null) return;
    const remote = snap.val()?.state;
    const want = desired();
    if (remote === 'offline' && want !== 'offline' && Date.now() - lastHeal > HEAL_EVERY_MS) {
      lastHeal = Date.now();
      write(want);
    }
  });

  ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);
  const timer = setInterval(evaluate, CHECK_EVERY_MS);
  const unsubModeChange = onStatusModeChange(() => sync());

  let stopPromise = null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    unsubConnected();
    unsubMode();
    unsubSelf();
    unsubModeChange();
    clearTimeout(modeTimer);
    clearInterval(timer);
    ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
    if (current && current.stop === stop) current = null;
    setMyMode('online');
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

const cache = new Map(); // uid -> { value, state, pub, listeners:Set, unsubs }

function subscribe(uid, fn) {
  let entry = cache.get(uid);
  if (!entry) {
    entry = { value: 'offline', state: null, pub: null, ready: false, listeners: new Set(), unsubs: [] };
    cache.set(uid, entry);
    const recompute = () => {
      const v = effectivePresence(entry.state, entry.pub);
      const changed = v !== entry.value || !entry.ready;
      entry.value = v;
      entry.ready = true;
      if (changed) entry.listeners.forEach((l) => l(entry.value));
    };
    entry.unsubs.push(
      onValue(
        ref(db, `presence/${uid}`),
        (s) => {
          entry.state = s.val()?.state || 'offline';
          recompute();
        },
        () => {
          entry.state = 'offline';
          recompute();
        },
      ),
      // Public status record (the Do Not Disturb flag); a failed read just means "no record".
      onValue(
        ref(db, `upub/${uid}/status/now`),
        (s) => {
          entry.pub = s.val();
          if (entry.state !== null) recompute();
        },
        () => {
          entry.pub = null;
        },
      ),
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
          entry.unsubs.forEach((u) => u());
          cache.delete(uid);
        }
      }, 5000);
    }
  };
}

/** Live presence for one user: 'online' | 'idle' | 'dnd' | 'offline'. */
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

/** Live presence for many users: { [uid]: 'online'|'idle'|'dnd'|'offline' }. */
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

// App-wide admin (F6). Admin status is granted by the database rules only: the client
// writes a guess into promoAttempts/{me} (rate limited, unreadable), then tries to create
// admins/{me}. The rules compare the stored guess with config/adminPromo, which no client
// can read. The secret never exists in this codebase.
//
// App admins have NO rules access to any end-to-end encrypted path and never receive wrapped
// keys, so they cannot read or decrypt private content. Admin power only covers plaintext,
// public-by-design surfaces: shop catalog, games, reports, announcements and badges.
import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { onValue, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { auth, db } from './firebase.js';

export const PROMO_COOLDOWN_MS = 30_000;
export const PROMO_MAX = 128;

// In-memory only (never persisted): when this tab last submitted a guess.
let lastAttemptAt = 0;

export function promoCooldownLeft() {
  return Math.max(0, lastAttemptAt + PROMO_COOLDOWN_MS - Date.now());
}

function isDenied(err) {
  const s = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  return s.includes('permission_denied') || s.includes('permission denied');
}

/**
 * Try a promo code. Resolves to { ok: true } or { ok: false, reason: 'cooldown'|'invalid'|'error', message }.
 * The caller must clear its input before awaiting this. The code is never logged or stored
 * client-side; it is only sent to promoAttempts/{uid}, which nobody can read back.
 */
export async function redeemPromo(code) {
  const user = auth.currentUser;
  if (!user) return { ok: false, reason: 'error', message: 'You are signed out.' };
  const value = typeof code === 'string' ? code.trim() : '';
  if (!value || value.length > PROMO_MAX) {
    return { ok: false, reason: 'invalid', message: 'Invalid code — wait 30 s between attempts.' };
  }
  if (promoCooldownLeft() > 0) {
    return { ok: false, reason: 'cooldown', message: `Wait ${Math.ceil(promoCooldownLeft() / 1000)} s between attempts.` };
  }
  const uid = user.uid;
  lastAttemptAt = Date.now();

  // Step 1: record the guess. The rules allow this at most once every 30 s per account.
  try {
    await set(ref(db, `promoAttempts/${uid}`), { code: value, at: serverTimestamp() });
  } catch (err) {
    if (isDenied(err)) return { ok: false, reason: 'cooldown', message: 'Too many attempts — wait 30 s between attempts.' };
    return { ok: false, reason: 'error', message: 'Could not reach the server. Try again shortly.' };
  }

  // Step 2: claim admin. Succeeds only if the stored guess matches the secret and is fresh.
  try {
    await update(ref(db), {
      [`admins/${uid}`]: { at: serverTimestamp() },
      [`adminBadges/${uid}`]: true,
    });
    return { ok: true };
  } catch (err) {
    if (isDenied(err)) return { ok: false, reason: 'invalid', message: 'Invalid code — wait 30 s between attempts.' };
    return { ok: false, reason: 'error', message: 'Could not reach the server. Try again shortly.' };
  }
}

/** Show or hide my public admin shield. Showing requires admins/{me} (rules-enforced). */
export async function setAdminBadgeVisible(visible) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('You are signed out.');
  const r = ref(db, `adminBadges/${uid}`);
  if (visible) await set(r, true);
  else await remove(r);
}

function useAuthUid() {
  const [uid, setUid] = useState(() => auth.currentUser?.uid || null);
  useEffect(() => onAuthStateChanged(auth, (u) => setUid(u?.uid || null)), []);
  return uid;
}

/** { isAdmin, loading } for the signed-in user (reads admins/{me}, which only I can read). */
export function useAppAdminState() {
  const uid = useAuthUid();
  const [state, setState] = useState({ uid: null, isAdmin: false, loading: true });
  useEffect(() => {
    if (!uid) {
      setState({ uid: null, isAdmin: false, loading: false });
      return undefined;
    }
    setState((s) => (s.uid === uid ? s : { uid, isAdmin: false, loading: true }));
    return onValue(
      ref(db, `admins/${uid}`),
      (s) => setState({ uid, isAdmin: s.exists(), loading: false }),
      () => setState({ uid, isAdmin: false, loading: false }),
    );
  }, [uid]);
  return { isAdmin: state.uid === uid && state.isAdmin, loading: state.uid !== uid ? !!uid : state.loading };
}

/** true if the signed-in user is an app admin (false while loading). */
export function useIsAppAdmin() {
  return useAppAdminState().isAdmin;
}

// ---- Public admin badges (adminBadges/{uid}), shared listener cache ----

const badgeCache = new Map(); // uid -> { value, listeners:Set, unsub, idleTimer }
const IDLE_MS = 30_000;

function dropBadge(uid, entry) {
  if (badgeCache.get(uid) === entry) badgeCache.delete(uid);
  clearTimeout(entry.idleTimer);
  entry.unsub?.();
  entry.unsub = null;
}

function subscribeBadge(uid, fn) {
  let entry = badgeCache.get(uid);
  if (!entry) {
    const e = { value: undefined, listeners: new Set(), unsub: null, idleTimer: null };
    entry = e;
    badgeCache.set(uid, e);
    e.unsub = onValue(
      ref(db, `adminBadges/${uid}`),
      (s) => {
        e.value = s.val() === true;
        e.listeners.forEach((l) => l(e.value));
      },
      // Cancelled (e.g. sign-out): forget the entry so a later subscriber starts a live listener.
      () => {
        e.value = false;
        e.listeners.forEach((l) => l(false));
        dropBadge(uid, e);
      },
    );
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.listeners.add(fn);
  if (entry.value !== undefined) fn(entry.value);
  const e = entry;
  return () => {
    e.listeners.delete(fn);
    if (e.listeners.size === 0 && badgeCache.get(uid) === e) {
      clearTimeout(e.idleTimer);
      e.idleTimer = setTimeout(() => {
        if (e.listeners.size === 0) dropBadge(uid, e);
      }, IDLE_MS);
    }
  };
}

/** true if uid displays a public admin badge. */
export function useAdminBadge(uid) {
  const [val, setVal] = useState(() => (uid && badgeCache.get(uid)?.value) || false);
  useEffect(() => {
    if (!uid) {
      setVal(false);
      return undefined;
    }
    setVal(badgeCache.get(uid)?.value || false);
    return subscribeBadge(uid, setVal);
  }, [uid]);
  return val;
}

/** Drop every cached badge listener (optional; call on sign-out). */
export function resetAdminBadges() {
  for (const [uid, e] of [...badgeCache]) dropBadge(uid, e);
}

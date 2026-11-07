// Premium membership actions and live hooks (Firebase). Pure helpers live in codes.js / lookCore.js.
//
//   premium/{uid}            { at, until, m }   member writes (code check in the rules); signed-in read;
//                                               app admins list and revoke; member may delete
//   premiumCodes/{YYYYMM}    { c, from, until } owner only: app admin + fresh owner passcode
//   promoAttempts/{uid}      { code, at }       the guess (30 s per account, nobody can read it)
//   upub/{uid}/premium/look  cosmetics         shown only while premium/{uid} is active
//
// Secrets (codes, the owner passcode) live only in component state and in the write that carries them;
// they are never logged, persisted or put in error messages.
import { useEffect, useMemo, useState } from 'react';
import { get, onValue, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { auth, db } from '../../../lib/firebase.js';
import { promoCooldownLeft } from '../../../lib/admin.js';
import { upubRef, useUpub } from '../../../lib/ext/store.js';
import { PREMIUM_MS, usePremium } from './status.js';
import { candidateMonths, planCodes, replacementCode } from './codes.js';
import { hasLook, lookRecord, normalizeLook } from './lookCore.js';

export const PROMO_COOLDOWN_MS = 30_000;
/** The rules accept an owner passcode guess for 15 minutes. */
export const OWNER_UNLOCK_MS = 15 * 60 * 1000;
/** `until` is written a little below now + 30 days: the rules accept the minute before it. */
const UNTIL_MARGIN_MS = 10_000;

const isDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e || ''));
const NET = 'Could not reach the server. Try again shortly.';

function me() {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('You are signed out.');
  return uid;
}

async function serverOffset() {
  try {
    return Number((await get(ref(db, '.info/serverTimeOffset'))).val()) || 0;
  } catch {
    return 0;
  }
}

// The promo cooldown is shared with Settings → Codes & admin (same promoAttempts node, same 30 s).
// admin.js keeps its own in-memory timestamp; this module adds one for its own writes.
let lastGuessAt = 0;
/** Milliseconds until this tab may write another guess. */
export function guessCooldownLeft() {
  return Math.max(0, lastGuessAt + PROMO_COOLDOWN_MS - Date.now(), promoCooldownLeft());
}

/** Write a guess to promoAttempts/{me}. -> null on success, or a { reason, message } failure. */
async function writeGuess(uid, value) {
  if (guessCooldownLeft() > 0) {
    return { reason: 'cooldown', message: `Wait ${Math.ceil(guessCooldownLeft() / 1000)} s between attempts.` };
  }
  lastGuessAt = Date.now();
  try {
    await set(ref(db, `promoAttempts/${uid}`), { code: value, at: serverTimestamp() });
    lastGuessAt = Date.now(); // the server's 30 s count starts when the write lands
    return null;
  } catch (e) {
    if (isDenied(e)) return { reason: 'cooldown', message: 'Too many attempts. Wait 30 s between attempts.' };
    return { reason: 'error', message: NET };
  }
}

/**
 * Redeem a monthly premium code. The caller clears its input first and passes the normalized code.
 * Writes the guess once, then tries premium/{me} for the month of the server clock and, near a month
 * boundary, the neighbouring month. -> { ok: true, until, m } or { ok: false, reason, message }.
 * reason: 'cooldown' | 'invalid' | 'same' (this month's code is already redeemed) | 'error'
 */
export async function redeemPremium(code, current = null) {
  let uid;
  try {
    uid = me();
  } catch (e) {
    return { ok: false, reason: 'error', message: e.message };
  }
  const value = typeof code === 'string' ? code.trim() : '';
  if (!value || value.length > 128) return { ok: false, reason: 'invalid', message: 'Enter the code you were given.' };
  const fail = await writeGuess(uid, value);
  if (fail) return { ok: false, ...fail };
  const offset = await serverOffset();
  const now = Date.now() + offset;
  const months = candidateMonths(now);
  let netError = false;
  for (const m of months) {
    const until = Date.now() + offset + PREMIUM_MS - UNTIL_MARGIN_MS;
    try {
      await set(ref(db, `premium/${uid}`), { at: serverTimestamp(), until, m });
      return { ok: true, until, m };
    } catch (e) {
      if (!isDenied(e)) netError = true;
    }
  }
  if (netError) return { ok: false, reason: 'error', message: NET };
  if (current && months.includes(current.m) && typeof current.until === 'number' && current.until > now) {
    return {
      ok: false,
      reason: 'same',
      message: "You've already redeemed this month's code. Renew with next month's code once it is out.",
    };
  }
  return {
    ok: false,
    reason: 'invalid',
    message: "That code doesn't work. Codes change on the 1st of every month (UTC), so an older code has expired. Check it and try again in 30 s.",
  };
}

/** Leave premium (deletes my record; perks stop at once). */
export async function cancelPremium() {
  const uid = me();
  await remove(ref(db, `premium/${uid}`));
}

// ---------------------------------------------------------------------------------------------
// Owner dashboard: unlock with the owner passcode
// ---------------------------------------------------------------------------------------------

const ownerState = { unlockedAt: 0, uid: null };
const ownerListeners = new Set();
let relockTimer = null;
let scrubTimer = null;
const emitOwner = () => ownerListeners.forEach((fn) => fn({ ...ownerState }));

function scheduleRelock() {
  clearTimeout(relockTimer);
  if (!ownerState.unlockedAt) return;
  const left = ownerState.unlockedAt + OWNER_UNLOCK_MS - Date.now();
  relockTimer = setTimeout(() => lockOwner({ scrub: false }), Math.max(0, left));
}

/** Random filler that replaces the passcode in promoAttempts when locking (not a secret). */
function filler() {
  const a = new Uint8Array(12);
  globalThis.crypto.getRandomValues(a);
  return `lock-${Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Overwrite my stored passcode guess so the rules stop granting access before the 15 minutes end. */
async function scrubGuess(uid) {
  clearTimeout(scrubTimer);
  const wait = guessCooldownLeft();
  if (wait > 0) {
    scrubTimer = setTimeout(() => {
      if (!ownerState.unlockedAt && auth.currentUser?.uid === uid) scrubGuess(uid);
    }, wait + 250);
    return;
  }
  lastGuessAt = Date.now();
  try {
    await set(ref(db, `promoAttempts/${uid}`), { code: filler(), at: serverTimestamp() });
  } catch {
    /* the 15-minute window ends anyway */
  }
}

/**
 * Unlock the owner dashboard with the passcode (written to promoAttempts/{me}; the rules compare it
 * with config/ownerPass). -> { ok: true } or { ok: false, reason: 'cooldown'|'invalid'|'error', message }
 */
export async function unlockOwner(passcode) {
  let uid;
  try {
    uid = me();
  } catch (e) {
    return { ok: false, reason: 'error', message: e.message };
  }
  if (typeof passcode !== 'string' || !passcode || passcode.length > 128) {
    return { ok: false, reason: 'invalid', message: 'Enter the owner passcode.' };
  }
  const fail = await writeGuess(uid, passcode);
  if (fail) return { ok: false, ...fail };
  try {
    await get(ref(db, 'premiumCodes'));
  } catch (e) {
    if (isDenied(e)) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'Wrong passcode, or the owner passcode or the premium rules are not set up yet (see README, "Owner setup"). Wait 30 s before trying again.',
      };
    }
    return { ok: false, reason: 'error', message: NET };
  }
  ownerState.unlockedAt = Date.now();
  ownerState.uid = uid;
  scheduleRelock();
  emitOwner();
  return { ok: true };
}

/** Lock the dashboard. `scrub` also overwrites the stored passcode guess (default). */
export function lockOwner({ scrub = true } = {}) {
  const uid = ownerState.uid;
  ownerState.unlockedAt = 0;
  ownerState.uid = null;
  clearTimeout(relockTimer);
  emitOwner();
  if (scrub && uid && auth.currentUser?.uid === uid) scrubGuess(uid);
}

/** { unlocked, left } for the signed-in admin; re-renders every second while unlocked. */
export function useOwnerLock() {
  const [st, setSt] = useState(() => ({ ...ownerState }));
  const [, tick] = useState(0);
  useEffect(() => {
    ownerListeners.add(setSt);
    return () => ownerListeners.delete(setSt);
  }, []);
  const uid = auth.currentUser?.uid;
  const unlocked = !!st.unlockedAt && st.uid === uid && Date.now() - st.unlockedAt < OWNER_UNLOCK_MS;
  useEffect(() => {
    if (!unlocked) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [unlocked]);
  return { unlocked, left: unlocked ? st.unlockedAt + OWNER_UNLOCK_MS - Date.now() : 0 };
}

/** Live premiumCodes while unlocked: { loading, codes, error }. A refused listener locks the dashboard. */
export function usePremiumCodes(unlocked) {
  const [st, setSt] = useState({ loading: true, codes: null, error: null });
  useEffect(() => {
    if (!unlocked) {
      setSt({ loading: false, codes: null, error: null });
      return undefined;
    }
    setSt((s) => ({ ...s, loading: true }));
    return onValue(
      ref(db, 'premiumCodes'),
      (s) => setSt({ loading: false, codes: s.val() || {}, error: null }),
      () => {
        setSt({ loading: false, codes: null, error: 'Access to the codes ended. Unlock again.' });
        lockOwner({ scrub: false });
      },
    );
  }, [unlocked]);
  return st;
}

/** Create codes for this month and the next 11 months that have none. -> number created. */
export async function generateMissingCodes(existing) {
  const offset = await serverOffset();
  const plan = planCodes(existing, Date.now() + offset);
  const keys = Object.keys(plan);
  if (!keys.length) return 0;
  const updates = {};
  for (const k of keys) updates[`premiumCodes/${k}`] = plan[k];
  try {
    await update(ref(db), updates);
  } catch (e) {
    throw new Error(isDenied(e) ? 'Refused. Unlock the dashboard again.' : NET);
  }
  return keys.length;
}

/** Replace one month's code; the old one stops working at once. */
export async function replaceCode(key, existing) {
  try {
    await set(ref(db, `premiumCodes/${key}`), replacementCode(key, existing));
  } catch (e) {
    throw new Error(isDenied(e) ? 'Refused. Unlock the dashboard again.' : NET);
  }
}

// ---------------------------------------------------------------------------------------------
// Members (app admins)
// ---------------------------------------------------------------------------------------------

/** Every premium record (app admins only): { loading, members: [{ uid, at, until, m }], error } */
export function usePremiumMembers(enabled = true) {
  const [st, setSt] = useState({ loading: !!enabled, members: [], error: null });
  useEffect(() => {
    if (!enabled) return undefined;
    return onValue(
      ref(db, 'premium'),
      (s) => {
        const v = s.val() || {};
        const members = Object.entries(v)
          .filter(([, r]) => r && typeof r === 'object')
          .map(([uid, r]) => ({ uid, at: Number(r.at) || 0, until: Number(r.until) || 0, m: typeof r.m === 'string' ? r.m : '' }))
          .sort((a, b) => b.until - a.until);
        setSt({ loading: false, members, error: null });
      },
      (e) => setSt({ loading: false, members: [], error: isDenied(e) ? 'The premium rules are not published yet, or you are not an app admin.' : NET }),
    );
  }, [enabled]);
  return st;
}

/** Revoke someone's premium (app admins). */
export async function revokePremium(uid) {
  try {
    await remove(ref(db, `premium/${uid}`));
  } catch (e) {
    throw new Error(isDenied(e) ? 'Only app admins can revoke premium.' : NET);
  }
}

// ---------------------------------------------------------------------------------------------
// Cosmetics
// ---------------------------------------------------------------------------------------------

/** Save my premium look (validated; throws a readable Error). */
export async function saveLook(input) {
  const uid = me();
  const rec = lookRecord(input);
  await set(upubRef(uid, 'premium', 'look'), rec);
}

/** Remove my premium look. */
export async function clearLook() {
  const uid = me();
  await remove(upubRef(uid, 'premium', 'look'));
}

const OFF = Object.freeze({ active: false, look: null });

/**
 * What to render for `uid`: { active, look } where `look` is the normalized cosmetics, or null when the
 * member isn't premium right now or has none. Never trusts upub alone.
 */
export function usePremiumLook(uid) {
  const { active } = usePremium(uid);
  const { value } = useUpub(active ? uid : null, 'premium', 'look');
  return useMemo(() => {
    if (!active) return OFF;
    const look = normalizeLook(value);
    return { active: true, look: hasLook(look) ? look : null };
  }, [active, value]);
}

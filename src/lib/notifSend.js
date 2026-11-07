// Sending notifications (notifs/{to}/{nid} + the notifLog/{from}/{to} rate-limit stamp). Kept free of
// React and of other app modules so any lib (friends, groups, roles, games, announcements) can import it
// without import cycles. lib/notifications.js re-exports everything here.
import { push, ref, serverTimestamp, update } from 'firebase/database';
import { auth, db } from './firebase.js';

// 'reminder' (round 3, messaging) is the only kind a user writes to their own list (from === to).
export const NOTIF_KINDS = ['mention', 'reply', 'dm', 'groupAdd', 'friendReq', 'roleChange', 'gameLike', 'call', 'announcement', 'reminder'];
export const NOTIF_MIN_GAP_MS = 3000;
const REF_KEYS = ['sid', 'cid', 'gid', 'dmId', 'mid', 'gameId', 'callId'];

/** Keep only known ref keys with non-empty string values of <= 64 chars (rules require it). */
export function cleanRef(r) {
  const out = {};
  REF_KEYS.forEach((k) => {
    const v = r?.[k];
    if (typeof v === 'string' && v && v.length <= 64) out[k] = v;
  });
  return out;
}

const lastSent = new Map(); // recipient uid -> client time of last send (rate-limit guard)

/**
 * Add `notifs/{to}/{nid}` and `notifLog/{me}/{to}` to a multi-path update map.
 * Returns the nid, or null when skipped (self, bad kind, no sign-in, or sent <3 s ago to the same user).
 * Skipping is silent on purpose: a notification must never break the action that triggered it.
 */
export function sendNotif(updates, { to, kind, ref: r = {}, from } = {}) {
  const me = from || auth.currentUser?.uid;
  if (!me || !to || to === me || !NOTIF_KINDS.includes(kind) || !updates) return null;
  const now = Date.now();
  if (now - (lastSent.get(to) || 0) < NOTIF_MIN_GAP_MS + 250) return null;
  lastSent.set(to, now);
  const nid = push(ref(db, `notifs/${to}`)).key;
  updates[`notifs/${to}/${nid}`] = { kind, from: me, ts: serverTimestamp(), ref: cleanRef(r) };
  updates[`notifLog/${me}/${to}`] = serverTimestamp();
  return nid;
}

/** Standalone send; never throws (blocked / rate-limited / rules rejection are all ignorable). */
export async function deliverNotif(args) {
  const u = {};
  const nid = sendNotif(u, args);
  if (!nid) return null;
  try {
    await update(ref(db), u);
    return nid;
  } catch {
    return null;
  }
}

/**
 * Deliver to many recipients (each its own update so one block/rate-limit failure doesn't affect others),
 * 25 at a time. Resolves to the nids (null where skipped or refused).
 */
export async function deliverNotifs(recipients, args) {
  const list = [...new Set(recipients || [])];
  const out = [];
  for (let i = 0; i < list.length; i += 25) {
    out.push(...(await Promise.all(list.slice(i, i + 25).map((to) => deliverNotif({ ...args, to })))));
  }
  return out;
}

// Notification center (feature 1).
//
// notifs/{uid}/{nid}   = { kind, from, ts, ref, read? }      recipient reads/updates `read`/deletes
// notifLog/{from}/{uid} = ts                                  per-pair rate-limit stamp (>= 3 s apart)
//
// Plaintext by design: kind, sender uid, timestamp and opaque ids in `ref`. NO message text, names or
// previews are ever stored. Desktop alerts reuse notify.js and show only the sender's profile name.
//
// Senders add entries to a multi-path update map with sendNotif(update, ...) or fire them on their own with
// deliverNotif(...) (preferred next to a message write: the 3 s rate-limit rule or a block would otherwise
// reject the WHOLE multi-path update, including the message).
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, limitToLast, onValue, orderByKey, push, query, ref, remove, serverTimestamp, update } from 'firebase/database';
import { auth, db } from './firebase.js';
import { useBlocks } from './blocks.js';
import { isMuted, notificationPermission, showNotification, useNotifPrefs } from './notify.js';
import { useProfiles } from './profiles.js';

export const NOTIF_KINDS = ['mention', 'reply', 'dm', 'groupAdd', 'friendReq', 'roleChange', 'gameLike', 'call', 'announcement'];
export const MAX_NOTIFS = 200;
export const NOTIF_MIN_GAP_MS = 3000;
const REF_KEYS = ['sid', 'cid', 'gid', 'dmId', 'mid', 'gameId', 'callId'];

const uidOf = (me) => (typeof me === 'string' ? me : me?.uid) || null;

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

/** Deliver to many recipients (each its own update so one block/rate-limit failure doesn't affect others). */
export function deliverNotifs(recipients, args) {
  return Promise.all([...new Set(recipients || [])].map((to) => deliverNotif({ ...args, to })));
}

// ---------- Shared live subscription (one listener per uid, ref-counted) ----------

const stores = new Map(); // uid -> { value, listeners, unsub, idle }
const IDLE_MS = 30_000;
const EMPTY = Object.freeze({ loading: true, items: Object.freeze([]), unread: 0 });

function build(val) {
  const items = Object.entries(val || {})
    .filter(([, n]) => n && NOTIF_KINDS.includes(n.kind) && typeof n.from === 'string')
    .map(([id, n]) => ({ id, kind: n.kind, from: n.from, ts: Number(n.ts) || 0, ref: n.ref || {}, read: n.read === true }))
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  return { loading: false, items, unread: items.reduce((c, n) => c + (n.read ? 0 : 1), 0), full: items.length >= MAX_NOTIFS };
}

function subscribe(uid, fn) {
  let st = stores.get(uid);
  if (!st) {
    const entry = { value: null, listeners: new Set(), unsub: null, idle: null };
    st = entry;
    stores.set(uid, entry);
    entry.unsub = onValue(
      query(ref(db, `notifs/${uid}`), orderByKey(), limitToLast(MAX_NOTIFS)),
      (snap) => {
        entry.value = build(snap.val());
        entry.listeners.forEach((l) => l(entry.value));
      },
      () => {
        if (stores.get(uid) === entry) stores.delete(uid);
        entry.value = build(null);
        entry.listeners.forEach((l) => l(entry.value));
      },
    );
  }
  const e = st;
  clearTimeout(e.idle);
  e.idle = null;
  e.listeners.add(fn);
  if (e.value) fn(e.value);
  return () => {
    e.listeners.delete(fn);
    if (e.listeners.size === 0 && stores.get(uid) === e) {
      e.idle = setTimeout(() => {
        if (e.listeners.size === 0 && stores.get(uid) === e) {
          e.unsub();
          stores.delete(uid);
        }
      }, IDLE_MS);
    }
  };
}

/** Live notifications of `me`: { loading, items (newest first), unread }. Safe to call from many components. */
export function useNotifications(me) {
  const uid = uidOf(me);
  const [state, setState] = useState(() => (uid && stores.get(uid)?.value) || EMPTY);
  useEffect(() => {
    if (!uid) {
      setState(EMPTY);
      return undefined;
    }
    return subscribe(uid, setState);
  }, [uid]);
  const cur = uid ? state : EMPTY;
  const trimmed = useRef(null);
  useEffect(() => {
    if (!uid || !cur.full || trimmed.current === uid) return;
    trimmed.current = uid;
    trim(uid).catch(() => {});
  }, [uid, cur.full]);
  return cur;
}

// ---------- Mutations (recipient only) ----------

export function markRead(me, nid) {
  const uid = uidOf(me);
  if (!uid || !nid) return Promise.resolve();
  return update(ref(db, `notifs/${uid}/${nid}`), { read: true });
}

/** Mark every unread notification read in one multi-path update. */
export function markAllRead(me, items) {
  const uid = uidOf(me);
  const out = {};
  (items || []).forEach((n) => {
    if (!n.read) out[`notifs/${uid}/${n.id}/read`] = true;
  });
  return uid && Object.keys(out).length ? update(ref(db), out) : Promise.resolve();
}

export function removeNotif(me, nid) {
  const uid = uidOf(me);
  return uid && nid ? remove(ref(db, `notifs/${uid}/${nid}`)) : Promise.resolve();
}

export async function clearAll(me) {
  const uid = uidOf(me);
  if (uid) await remove(ref(db, `notifs/${uid}`));
}

/** Delete everything but the newest `keep` (push keys sort chronologically). Returns number removed. */
export async function trim(me, keep = MAX_NOTIFS) {
  const uid = uidOf(me);
  if (!uid) return 0;
  const snap = await get(ref(db, `notifs/${uid}`));
  const keys = Object.keys(snap.val() || {}).sort();
  const extra = keys.slice(0, Math.max(0, keys.length - keep));
  if (!extra.length) return 0;
  const out = {};
  extra.forEach((k) => {
    out[`notifs/${uid}/${k}`] = null;
  });
  await update(ref(db), out);
  return extra.length;
}

export const notifCleanupPaths = (uid) => [`notifs/${uid}`, `notifLog/${uid}`];

// ---------- Presentation helpers ----------

export const KIND_LABEL = {
  mention: 'mentioned you',
  reply: 'replied to you',
  dm: 'sent you a message',
  groupAdd: 'added you to a group',
  friendReq: 'sent you a friend request',
  roleChange: 'changed your role',
  gameLike: 'liked your game',
  call: 'is calling you',
  announcement: 'posted an announcement',
};

/** Mute scope used by notify.js for this notification, or null. */
export function scopeOfNotif(n) {
  const r = n?.ref || {};
  if (r.dmId) return `dm_${r.dmId}`;
  if (r.gid) return `grp_${r.gid}`;
  if (r.sid && r.cid) return `${r.sid}_${r.cid}`;
  return null;
}

/** Where a click should go: { type: 'channel'|'dm'|'group'|'friends'|'game'|'server'|'call', ...ids }. */
export function targetOfNotif(n) {
  const r = n?.ref || {};
  if (n.kind === 'call') return { type: 'call', callId: r.callId, dmId: r.dmId, gid: r.gid };
  if (r.dmId) return { type: 'dm', dmId: r.dmId, mid: r.mid };
  if (r.gid) return { type: 'group', gid: r.gid, mid: r.mid };
  if (r.sid && r.cid) return { type: 'channel', sid: r.sid, cid: r.cid, mid: r.mid };
  if (r.sid) return { type: 'server', sid: r.sid };
  if (r.gameId) return { type: 'game', gameId: r.gameId };
  if (n.kind === 'friendReq') return { type: 'friends' };
  return { type: 'none' };
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}

// ---------- Hooks: tab title + desktop alerts ----------

/** Sets document.title to `(N) Codehub` while N > 0 and restores it afterwards. */
export function useUnreadTitle(unread, base = 'Codehub') {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
    return undefined;
  }, [unread, base]);
  useEffect(() => () => {
    if (typeof document !== 'undefined') document.title = base;
  }, [base]);
}

/**
 * Desktop alerts for notifications that arrive while the tab is open. Respects notifPrefs (desktop on,
 * mentionsOnly, per-scope mute via isMuted) and the block list; never shows message text.
 * `onOpen(item)` is called when the alert is clicked.
 */
export function useNotificationAlerts({ me, state, onOpen }) {
  const uid = uidOf(me);
  const own = useNotifications(state ? null : uid);
  const { items, loading } = state || own;
  const prefs = useNotifPrefs(uid);
  const blocked = useBlocks(uid);
  const seen = useRef(null);
  const latest = useRef({});
  const fresh = useMemo(() => items.slice(0, 5).map((n) => n.from), [items]);
  const profiles = useProfiles(fresh);
  latest.current = { prefs, blocked, onOpen, profiles };

  useEffect(() => {
    if (loading || !uid) return;
    if (!seen.current) {
      seen.current = new Set(items.map((n) => n.id)); // seed: history never alerts
      return;
    }
    const { prefs: p, blocked: bl, onOpen: open, profiles: pr } = latest.current;
    items.forEach((n) => {
      if (seen.current.has(n.id)) return;
      seen.current.add(n.id);
      if (n.read || bl.has(n.from)) return;
      const s = p?.settings;
      if (!s?.desktop || notificationPermission() !== 'granted') return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return;
      const scope = scopeOfNotif(n);
      if (scope && isMuted(p, scope, Date.now(), { sid: n.ref.sid, mention: n.kind === 'mention' || n.kind === 'reply' })) return;
      if (s.mentionsOnly && !['mention', 'reply', 'dm', 'call'].includes(n.kind)) return;
      const who = pr[n.from]?.name || 'Someone';
      showNotification(`${who} ${KIND_LABEL[n.kind]}`, { body: 'Codehub', tag: `notif_${n.id}`, onClick: () => open?.(n) });
    });
  }, [items, loading, uid]);
}

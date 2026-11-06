// Slowmode (rules-enforced). servers/{sid}/channels/{cid}/slowmode = seconds (0..21600, set by manageChannels).
// Non-moderators must write lastPost/{sid}/{cid}/{uid} = now in the SAME multi-path update as their
// message; the rules reject the update unless now - previous lastPost >= slowmode*1000. Moderators
// (owner/admin/manageMessages) are exempt and must NOT write lastPost (the rules would still accept it
// only if their own interval has elapsed).
import { useEffect, useState } from 'react';
import { onValue, ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from '../firebase.js';
import { can } from '../roles.js';

export const MAX_SLOWMODE = 21600;
export const SLOWMODE_PRESETS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

export const slowmodePath = (sid, cid) => `servers/${sid}/channels/${cid}/slowmode`;
export const lastPostPath = (sid, cid, uid) => `lastPost/${sid}/${cid}/${uid}`;

export const cleanSlowmode = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_SLOWMODE, Math.max(0, v)) : 0;
};

export function formatSeconds(s) {
  s = Math.max(0, Math.ceil(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Set (seconds > 0) or clear (0) the channel's slowmode. Rules: manageChannels. */
export function setSlowmode(sid, cid, seconds) {
  const v = cleanSlowmode(seconds);
  return v > 0 ? set(ref(db, slowmodePath(sid, cid)), v) : remove(ref(db, slowmodePath(sid, cid)));
}

/** Moderators are exempt: owner/admin or the manageMessages permission (mirrors the rules). */
export const bypassesSlowmode = (member, roles) => can(member, roles, 'manageMessages');

/** Milliseconds until `uid` may post again (0 = now). Pure. */
export function remainingMs(lastPost, seconds, now = Date.now(), bypass = false) {
  if (bypass || !(seconds > 0) || typeof lastPost !== 'number') return 0;
  return Math.max(0, lastPost + seconds * 1000 - now);
}

/**
 * Extra multi-path entries to merge into the message write. Returns {} when no slowmode applies or the
 * author is exempt, so callers can always spread it:  update(ref(db), { [msgPath]: record, ...slowmodeExtras(...) })
 */
export function slowmodeExtras({ sid, cid, uid, seconds, bypass }) {
  if (bypass || !(seconds > 0)) return {};
  return { [lastPostPath(sid, cid, uid)]: serverTimestamp() };
}

/**
 * Live slowmode state for the open channel. Two tiny listeners (channel slowmode + my lastPost).
 * Returns { seconds, remaining (ms, ticking at 1 Hz while active), blocked, markPosted() }.
 * markPosted() is an optimistic local stamp, used right after send so the UI locks without waiting
 * for the lastPost echo; the server value overwrites it.
 */
export function useSlowmode(sid, cid, uid, bypass = false) {
  const [seconds, setSeconds] = useState(0);
  const [last, setLast] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setSeconds(0);
    if (!sid || !cid) return undefined;
    return onValue(ref(db, slowmodePath(sid, cid)), (s) => setSeconds(cleanSlowmode(s.val())), () => setSeconds(0));
  }, [sid, cid]);

  useEffect(() => {
    setLast(null);
    if (!sid || !cid || !uid || bypass) return undefined;
    return onValue(ref(db, lastPostPath(sid, cid, uid)), (s) => setLast(typeof s.val() === 'number' ? s.val() : null), () => setLast(null));
  }, [sid, cid, uid, bypass]);

  const remaining = remainingMs(last, seconds, now, bypass);
  useEffect(() => {
    if (remaining <= 0) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    seconds,
    remaining,
    blocked: remaining > 0,
    markPosted: () => {
      setNow(Date.now());
      setLast(Date.now());
    },
  };
}

/** Friendly message for a permission_denied that is likely slowmode (callers may show it). */
export const SLOWMODE_DENIED = 'Slowmode is on — wait a moment before posting again.';

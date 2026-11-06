// Member timeouts (F14) and the encrypted moderation audit log (F15).
//
// Timeouts: servers/{sid}/timeouts/{uid} = untilMs (plaintext; members can read it). The rules
// stop a timed-out member from sending, editing, reacting and typing until then (max 28 days).
//
// Audit log: audit/{sid}/{aid} = { by, ts, iv, ct }. ct = server-key AES-GCM over JSON
// { action, target?, detail? } with AAD `audit:{sid}/{aid}:{by}`. `by` and `ts` are plaintext.
// Entries are written by the acting client right after a successful action. That is BEST EFFORT:
// rules cannot force a client to log, and a failed log write never fails the action itself.
import { useEffect, useMemo, useState } from 'react';
import { limitToLast, onValue, orderByChild, push, query, ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from './firebase.js';
import { decryptJSON, encryptJSON } from './crypto.js';
import * as keystore from './keystore.js';
import { serverNow } from './messages.js';

export { serverNow };

// ---------- Timeouts ----------

export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // 2419200000, same bound as the rules
export const TIMEOUT_PRESETS = [
  { label: '60 seconds', ms: 60 * 1000 },
  { label: '5 minutes', ms: 5 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
];

/** Short human duration: 45s, 5m, 3h, 2d. */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function fmtUntil(until) {
  const d = new Date(until);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Time a member out for `ms` (clamped to 28 days, measured on the server clock), or lift it (null/0).
 * Rules: needs the `timeout` permission and to outrank the member.
 */
export function setTimeoutFor(sid, uid, ms) {
  const r = ref(db, `servers/${sid}/timeouts/${uid}`);
  if (!ms) return remove(r);
  // Leave a minute of slack under the rule's `now + 28d` bound for clock/latency drift.
  const dur = Math.max(1000, Math.min(Number(ms) || 0, MAX_TIMEOUT_MS - 60 * 1000));
  return set(r, Math.round(serverNow() + dur));
}

const activeOnly = (val, now) => {
  const out = {};
  Object.entries(val || {}).forEach(([uid, until]) => {
    if (typeof until === 'number' && until > now) out[uid] = until;
  });
  return out;
};

/** Re-render when the earliest of `untils` passes. */
function useExpiryTick(untils) {
  const [, setTick] = useState(0);
  const next = untils.length ? Math.min(...untils) : 0;
  useEffect(() => {
    if (!next) return undefined;
    // setTimeout caps at ~24.8 days; re-arm after that.
    const wait = Math.min(Math.max(250, next - serverNow() + 250), 2 ** 31 - 1);
    const t = setTimeout(() => setTick((x) => x + 1), wait);
    return () => clearTimeout(t);
  }, [next]);
}

/** Active timeouts of a server: { timeouts: { uid: untilMs }, loading }. Expired ones drop out live. */
export function useTimeouts(sid, nonce) {
  const [st, setSt] = useState({ sid, val: null, loading: !!sid });
  useEffect(() => {
    if (!sid) return undefined;
    setSt({ sid, val: null, loading: true });
    return onValue(
      ref(db, `servers/${sid}/timeouts`),
      (s) => setSt({ sid, val: s.val() || {}, loading: false }),
      () => setSt({ sid, val: {}, loading: false }),
    );
  }, [sid, nonce]);
  const val = st.sid === sid ? st.val : null;
  const all = useMemo(() => Object.values(val || {}).filter((v) => typeof v === 'number'), [val]);
  useExpiryTick(all.filter((v) => v > serverNow()));
  const timeouts = activeOnly(val, serverNow());
  return { timeouts, loading: !!sid && (st.sid !== sid || st.loading) };
}

/** My active timeout in a server: untilMs, or 0 when I'm free. Updates live and at expiry. */
export function useMyTimeout(sid, uid) {
  const [st, setSt] = useState({ key: null, until: 0 });
  const key = sid && uid ? `${sid}/${uid}` : null;
  useEffect(() => {
    if (!key) return undefined;
    return onValue(
      ref(db, `servers/${sid}/timeouts/${uid}`),
      (s) => setSt({ key, until: typeof s.val() === 'number' ? s.val() : 0 }),
      () => setSt({ key, until: 0 }),
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const until = st.key === key ? st.until : 0;
  useExpiryTick(until > serverNow() ? [until] : []);
  return until > serverNow() ? until : 0;
}

export const isTimedOut = (timeouts, uid) => !!timeouts && typeof timeouts[uid] === 'number' && timeouts[uid] > serverNow();

// ---------- Audit log ----------

export const AUDIT_ACTIONS = [
  'kick', 'ban', 'unban', 'timeout',
  'role.assign', 'role.create', 'role.update', 'role.delete',
  'invite.create', 'invite.revoke',
  'channel.create', 'channel.update', 'channel.delete',
  'member.role',
];

export const AUDIT_LABELS = {
  kick: 'kicked',
  ban: 'banned',
  unban: 'unbanned',
  timeout: 'timed out',
  'role.assign': 'changed the role of',
  'role.create': 'created role',
  'role.update': 'edited role',
  'role.delete': 'deleted role',
  'invite.create': 'created invite',
  'invite.revoke': 'revoked invite',
  'channel.create': 'created channel',
  'channel.update': 'edited channel',
  'channel.delete': 'deleted channel',
  'member.role': 'changed the built-in role of',
};

/** Actions whose `target` is a member uid. */
export const MEMBER_ACTIONS = new Set(['kick', 'ban', 'unban', 'timeout', 'role.assign', 'member.role']);

export const auditAad = (sid, aid, by) => `audit:${sid}/${aid}:${by}`;
const MAX_FIELD = 512;

function cleanEntry(entry) {
  const action = String(entry?.action || '');
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Unknown audit action: ${action}`);
  const out = { action };
  if (entry.target != null && entry.target !== '') out.target = String(entry.target).slice(0, 128);
  if (entry.detail != null && entry.detail !== '') {
    out.detail = typeof entry.detail === 'string' ? entry.detail.slice(0, MAX_FIELD) : JSON.parse(JSON.stringify(entry.detail));
    if (typeof out.detail !== 'string' && JSON.stringify(out.detail).length > MAX_FIELD * 2) out.detail = JSON.stringify(out.detail).slice(0, MAX_FIELD);
  }
  return out;
}

/**
 * Append an encrypted audit entry. `me` is a uid or { uid }. entry = { action, target?, detail? }.
 * Best effort: never throws; resolves to the new aid, or null if the write was refused/failed
 * (e.g. a member without a moderation permission isn't allowed to write audit entries).
 */
export async function writeAudit(sid, me, entry) {
  const by = typeof me === 'string' ? me : me?.uid;
  if (!sid || !by) return null;
  try {
    const clean = cleanEntry(entry);
    const r = push(ref(db, `audit/${sid}`));
    const key = await keystore.getServerKey(sid);
    const box = await encryptJSON(key, clean, auditAad(sid, r.key, by));
    await set(r, { by, ts: serverTimestamp(), iv: box.iv, ct: box.ct });
    return r.key;
  } catch (e) {
    console.warn('[audit] entry not recorded (best effort)', e);
    return null;
  }
}

/** Run `action()`; on success append the audit entry (fire-and-forget). Returns action's result. */
export async function audited(sid, me, entry, action) {
  const result = await action();
  writeAudit(sid, me, typeof entry === 'function' ? entry(result) : entry);
  return result;
}

const auditCache = new Map(); // `${sid}/${aid}|${by}|${iv}` -> entry | { failed }
try {
  keystore.onLock?.(() => auditCache.clear());
} catch {
  /* older keystore without onLock */
}

async function decryptAudit(sid, aid, raw) {
  const k = `${sid}/${aid}|${raw.by}|${raw.iv}`;
  if (auditCache.has(k)) return auditCache.get(k);
  let out;
  try {
    const key = await keystore.getServerKey(sid);
    const v = await decryptJSON(key, { iv: raw.iv, ct: raw.ct }, auditAad(sid, aid, raw.by));
    out = {
      action: AUDIT_ACTIONS.includes(v?.action) ? v.action : 'unknown',
      target: v?.target != null ? String(v.target) : null,
      detail: v?.detail ?? null,
    };
  } catch {
    out = { failed: true };
  }
  auditCache.set(k, out);
  return out;
}

/**
 * Newest `limit` audit entries (default 100), newest first, decrypted.
 * -> { entries: [{ aid, by, ts, action, target, detail, failed? }], loading, error }
 * Pass enabled=false when the viewer lacks viewAudit (the rules would deny the read anyway).
 */
export function useAuditLog(sid, { limit = 100, enabled = true } = {}) {
  const [st, setSt] = useState({ key: null, raw: null, error: null });
  const [dec, setDec] = useState({});
  const key = sid && enabled ? `${sid}|${limit}` : null;

  useEffect(() => {
    if (!key) return undefined;
    setSt({ key, raw: null, error: null });
    return onValue(
      query(ref(db, `audit/${sid}`), orderByChild('ts'), limitToLast(limit)),
      (s) => {
        const rows = [];
        s.forEach((c) => {
          const v = c.val();
          if (v && typeof v.iv === 'string' && typeof v.ct === 'string' && typeof v.by === 'string') rows.push({ aid: c.key, ...v });
        });
        setSt({ key, raw: rows, error: null });
      },
      (error) => setSt({ key, raw: [], error }),
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const raw = st.key === key ? st.raw : null;

  useEffect(() => {
    if (!raw?.length) return undefined;
    let alive = true;
    raw.forEach((r) => {
      decryptAudit(sid, r.aid, r).then((v) => alive && setDec((d) => (d[r.aid] === v ? d : { ...d, [r.aid]: v })));
    });
    return () => {
      alive = false;
    };
  }, [sid, raw]);

  const entries = useMemo(
    () =>
      (raw || [])
        .map((r) => {
          const v = dec[r.aid];
          return {
            aid: r.aid,
            by: r.by,
            ts: typeof r.ts === 'number' ? r.ts : 0,
            pending: !v,
            ...(v || {}),
          };
        })
        .sort((a, b) => b.ts - a.ts || (a.aid < b.aid ? 1 : -1)),
    [raw, dec],
  );

  return { entries, loading: !!key && raw === null, error: st.key === key ? st.error : null };
}

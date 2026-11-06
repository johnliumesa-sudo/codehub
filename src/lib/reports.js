// Reports to app admins (F17). Reports are PLAINTEXT by design: kind, target id, reason,
// optional note and an optional message excerpt that the reporter chose to share.
// Only app admins can read or delete them (rules). One report per 30 s per account (reportLog).
import { useEffect, useState } from 'react';
import { limitToLast, onValue, orderByChild, push, query, ref, remove, serverTimestamp, update } from 'firebase/database';
import { auth, db } from './firebase.js';

export const REPORT_KINDS = ['game', 'user', 'shopItem', 'message'];
export const REPORT_REASONS = [
  ['spam', 'Spam'],
  ['abuse', 'Harassment or abuse'],
  ['malware', 'Malware or phishing'],
  ['nsfw', 'Sexual or graphic content'],
  ['other', 'Something else'],
];
export const KIND_LABEL = { game: 'Game', user: 'User', shopItem: 'Shop item', message: 'Message' };
export const NOTE_MAX = 500;
export const EXCERPT_MAX = 2000;
export const TARGET_MAX = 256;
export const REPORT_COOLDOWN_MS = 30_000;

function isDenied(err) {
  const s = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  return s.includes('permission_denied') || s.includes('permission denied');
}

/**
 * Message report target strings (plaintext, so admins can locate the context):
 *   channel: msg:{sid}/{cid}/{mid}:{authorUid}
 *   DM:      dm:{dmId}/{mid}:{authorUid}
 *   group:   gmsg:{gid}/{mid}:{authorUid}
 */
export function messageTarget(conv, m) {
  if (!conv || !m) return '';
  if (conv.kind === 'dm') return `dm:${conv.dmId}/${m.mid}:${m.uid}`;
  if (conv.kind === 'group') return `gmsg:${conv.gid}/${m.mid}:${m.uid}`;
  return `msg:${conv.sid}/${conv.cid}/${m.mid}:${m.uid}`;
}

/** Parse a message target back into { where, author } for display. */
export function parseMessageTarget(target) {
  const m = /^(msg|dm|gmsg):(.+?)(?::([^:/]+))?$/.exec(String(target || ''));
  if (!m) return { where: String(target || ''), author: null, scope: null };
  const scope = { msg: 'Channel', dm: 'Direct message', gmsg: 'Group' }[m[1]];
  return { where: m[2], author: m[3] || null, scope };
}

/**
 * Submit a report. Resolves on success; throws Error with a user-facing message.
 * reports/{rid} and reportLog/{me} are written in ONE update (the rules require both).
 */
export async function submitReport({ kind, target, reason, note, excerpt }) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('You are signed out.');
  if (!REPORT_KINDS.includes(kind)) throw new Error('Unknown report type.');
  const t = String(target || '');
  if (!t || t.length > TARGET_MAX) throw new Error('Nothing to report.');
  if (!REPORT_REASONS.some(([r]) => r === reason)) throw new Error('Pick a reason.');
  const report = { by: uid, kind, target: t, reason, ts: serverTimestamp() };
  const n = String(note || '').trim().slice(0, NOTE_MAX);
  if (n) report.note = n;
  const ex = kind === 'message' ? String(excerpt || '').slice(0, EXCERPT_MAX) : '';
  if (ex.trim()) report.excerpt = ex;
  const rid = push(ref(db, 'reports')).key;
  try {
    await update(ref(db), {
      [`reports/${rid}`]: report,
      [`reportLog/${uid}`]: serverTimestamp(),
    });
  } catch (err) {
    if (isDenied(err)) throw new Error('You can send one report every 30 seconds. Please wait and try again.');
    throw new Error('Could not send the report. Check your connection and try again.');
  }
  return rid;
}

/** Admin only: live list of reports, newest first. */
export function useReports(max = 200) {
  const [state, setState] = useState({ reports: [], loading: true, error: null });
  useEffect(() => {
    const q = query(ref(db, 'reports'), orderByChild('ts'), limitToLast(max));
    return onValue(
      q,
      (s) => {
        const list = [];
        s.forEach((c) => {
          list.push({ rid: c.key, ...c.val() });
        });
        list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        setState({ reports: list, loading: false, error: null });
      },
      (err) => setState({ reports: [], loading: false, error: isDenied(err) ? 'Only app admins can view reports.' : 'Could not load reports.' }),
    );
  }, [max]);
  return state;
}

/** Admin only: dismiss (delete) a report. */
export function dismissReport(rid) {
  return remove(ref(db, `reports/${rid}`));
}

/** Admin only: dismiss several reports at once. */
export function dismissReports(rids) {
  const patch = {};
  for (const rid of rids) patch[`reports/${rid}`] = null;
  return update(ref(db), patch);
}

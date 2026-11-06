// Global admin announcement (F16). PLAINTEXT by design: announcements/current is readable by
// every signed-in user and writable only by app admins (rules). Always render as text, never HTML.
import { useEffect, useState } from 'react';
import { onValue, ref, remove, serverTimestamp, set } from 'firebase/database';
import { auth, db } from './firebase.js';

export const ANN_MAX = 280;
export const ANN_LEVELS = ['info', 'warn'];
const DISMISS_KEY = 'codehub.annDismissed';

/** Live current announcement: { text, level, ts, by } | null. */
export function useAnnouncement() {
  const [state, setState] = useState({ ann: null, loading: true });
  useEffect(
    () =>
      onValue(
        ref(db, 'announcements/current'),
        (s) => {
          const v = s.val();
          const ok = v && typeof v.text === 'string' && v.text && typeof v.ts === 'number';
          setState({ ann: ok ? { text: v.text, level: v.level === 'warn' ? 'warn' : 'info', ts: v.ts, by: v.by } : null, loading: false });
        },
        () => setState({ ann: null, loading: false }),
      ),
    [],
  );
  return state;
}

/** Admin only: publish (replace) the announcement. */
export async function setAnnouncement({ text, level }) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('You are signed out.');
  const t = String(text || '').trim();
  if (!t) throw new Error('The announcement cannot be empty.');
  if (t.length > ANN_MAX) throw new Error(`Keep it under ${ANN_MAX} characters.`);
  if (!ANN_LEVELS.includes(level)) throw new Error('Unknown level.');
  await set(ref(db, 'announcements/current'), { text: t, level, ts: serverTimestamp(), by: uid });
}

/** Admin only: clear the announcement. */
export function clearAnnouncement() {
  return remove(ref(db, 'announcements/current'));
}

export function getDismissedTs() {
  try {
    const v = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function setDismissedTs(ts) {
  try {
    localStorage.setItem(DISMISS_KEY, String(ts));
  } catch {
    // Storage unavailable (private mode): dismissal lasts for this page only.
  }
}

// Custom status, Do Not Disturb and invisible: database reads and writes (pure helpers in statusCore.js).
//   udata/{me}/status/mode   private mode, read by src/lib/presence.js (what this tab writes to presence/{me})
//   upub/{uid}/status/now    public { mode?: 'dnd', emoji?, text?, until? } (signed-in users read)
import { useEffect, useState } from 'react';
import { ref, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { myUid, useUdata, useUpub } from '../../../lib/ext/store.js';
import { cleanEmoji, cleanStatusText, clearAfterUntil, normalizeMode, readCustomStatus } from './statusCore.js';

/**
 * Change my mode. One update keeps the private mode and the public DND flag together; invisible and
 * idle never appear in public data (presence.js writes 'offline' / 'idle' for them).
 */
export function setStatusMode(mode) {
  const uid = myUid();
  const m = normalizeMode(mode);
  return update(ref(db), {
    [`udata/${uid}/status/mode`]: m,
    [`upub/${uid}/status/now/mode`]: m === 'dnd' ? 'dnd' : null,
  });
}

/**
 * Set my custom status (emoji and/or text, cleaned) clearing after `clear` (a CLEAR_AFTER id), or at
 * `until` (ms) when that is given and still in the future (keeps an existing expiry).
 */
export function setCustomStatus({ emoji, text, clear = 'never', until: keep }, now = Date.now()) {
  const e = cleanEmoji(emoji);
  const t = cleanStatusText(text);
  if (!e && !t) return clearCustomStatus();
  const until = typeof keep === 'number' && keep > now ? keep : clearAfterUntil(clear, now);
  return update(ref(db, `upub/${myUid()}/status/now`), { emoji: e || null, text: t || null, until: until || null });
}

/** Remove my custom status (keeps the mode). */
export function clearCustomStatus() {
  return update(ref(db, `upub/${myUid()}/status/now`), { emoji: null, text: null, until: null });
}

/** Re-render at `until` (an expiring status disappears without other changes). */
function useExpiry(until) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!until) return undefined;
    const left = until - Date.now();
    if (left <= 0) return undefined;
    const t = setTimeout(() => bump((n) => n + 1), Math.min(left + 50, 2_147_000_000));
    return () => clearTimeout(t);
  }, [until]);
}

/** Someone's custom status: { emoji, text, until } or null (expired, empty or invalid). */
export function useCustomStatus(uid) {
  const { value } = useUpub(uid || null, 'status', 'now');
  const until = value && typeof value.until === 'number' ? value.until : 0;
  useExpiry(until);
  return readCustomStatus(value);
}

/** My public record as stored (for the editor and the keeper), with loading. */
export function useMyPublicStatus(uid) {
  return useUpub(uid || null, 'status', 'now');
}

/** My private mode: { loading, mode }. */
export function useMyStatusMode() {
  const { loading, value } = useUdata('status', 'mode');
  return { loading, mode: normalizeMode(value) };
}

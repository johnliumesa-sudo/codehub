// Drafts: the app's draft store (localStorage + vault-key sealing) and a React hook over it.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { openForMe, sealForMe } from '../../../lib/ext/store.js';
import { createDraftStore } from './draftStore.js';

const memory = new Map();
const fallbackStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
};

function pickStorage() {
  try {
    const s = window.localStorage;
    const probe = '__codehub_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return fallbackStorage;
  }
}

export const drafts = createDraftStore({
  storage: typeof window !== 'undefined' ? pickStorage() : fallbackStorage,
  seal: sealForMe,
  open: openForMe,
});

if (typeof window !== 'undefined') window.addEventListener('storage', (e) => drafts.onStorageEvent(e));

// Snapshots per uid, rebuilt only after a change (useSyncExternalStore needs stable identities).
let version = 0;
drafts.subscribe(() => {
  version++;
});
const snaps = new Map(); // uid -> { v, value }
function snapshot(uid) {
  const c = snaps.get(uid);
  if (c && c.v === version) return c.value;
  const value = drafts.list(uid);
  snaps.set(uid, { v: version, value });
  return value;
}

/** Live list of my drafts ([{ key, conv, at }], newest first). */
export function useDraftList(uid) {
  return useSyncExternalStore(drafts.subscribe, () => snapshot(uid), () => snapshot(uid));
}

/** Decrypted title of a draft (for the sidebar), or ''. */
export function useDraftTitle(uid, conv, at) {
  const [title, setTitle] = useState('');
  useEffect(() => {
    let alive = true;
    drafts.get(uid, conv).then((d) => alive && setTitle(d?.title || '')).catch(() => alive && setTitle(''));
    return () => {
      alive = false;
    };
    // `at` changes whenever the draft is saved again
  }, [uid, conv?.kind, conv?.sid, conv?.cid, conv?.dmId, conv?.gid, at]); // eslint-disable-line react-hooks/exhaustive-deps
  return title;
}

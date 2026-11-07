// Private user notes: udata/{me}/userNotes/{uid} = { iv, ct } = sealForMe(`unote:{me}/{uid}`, { text }).
// Only I can read them (owner-only rules, and the text is encrypted with my vault key).
import { useEffect, useMemo, useState } from 'react';
import { ref, remove, set } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { myUid, openForMe, sealForMe, useUdata } from '../../../lib/ext/store.js';
import { cleanNote, noteAad } from './notesCore.js';

export { NOTE_MAX, cleanNote, noteAad } from './notesCore.js';

/** Set of uids I have a note about (no decryption needed). */
export function useNoteUids() {
  const { value } = useUdata('userNotes');
  return useMemo(() => new Set(value && typeof value === 'object' ? Object.keys(value) : []), [value]);
}

/** My note about `uid`: { loading, text, error }. */
export function useUserNote(uid) {
  const { loading, value } = useUdata(uid ? 'userNotes' : null, uid || undefined);
  const [st, setSt] = useState({ box: undefined, text: '', error: null });
  useEffect(() => {
    if (loading) return undefined;
    if (!value) {
      setSt({ box: null, text: '', error: null });
      return undefined;
    }
    let alive = true;
    let me;
    try {
      me = myUid();
    } catch (e) {
      setSt({ box: value, text: '', error: e });
      return undefined;
    }
    openForMe(noteAad(me, uid), value).then(
      (v) => alive && setSt({ box: value, text: cleanNote(v?.text), error: null }),
      (e) => alive && setSt({ box: value, text: '', error: e }),
    );
    return () => {
      alive = false;
    };
  }, [loading, value, uid]);
  const ready = !loading && st.box === (value || null);
  return { loading: !ready, text: ready ? st.text : '', error: ready ? st.error : null };
}

/** Save (or with empty text, delete) my note about `uid`. */
export async function saveUserNote(uid, text) {
  const me = myUid();
  const path = `udata/${me}/userNotes/${uid}`;
  const clean = cleanNote(text);
  if (!clean) return remove(ref(db, path));
  const box = await sealForMe(noteAad(me, uid), { text: clean });
  return set(ref(db, path), { iv: box.iv, ct: box.ct });
}

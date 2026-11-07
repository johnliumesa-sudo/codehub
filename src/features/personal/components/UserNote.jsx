// Private notes about other users: the "Note" field on profile cards and the note mark in member lists.
// Encrypted with my vault key (sealForMe, AAD unote:{me}/{uid}) in udata/{me}/userNotes/{uid}.
import { useEffect, useId, useRef, useState } from 'react';
import { NOTE_MAX, cleanNote, saveUserNote, useNoteUids, useUserNote } from '../lib/notes.js';

/** Profile card section (hidden on my own card). Saves on blur, Ctrl/⌘+Enter, or when the card closes. */
export function UserNoteSection({ uid }) {
  const { loading, text, error } = useUserNote(uid);
  const [draft, setDraft] = useState(null); // null = showing the saved text
  const [state, setState] = useState(''); // '' | 'saving' | 'saved' | error text
  const id = useId();
  const taRef = useRef(null);
  const value = draft ?? text;

  useEffect(() => {
    if (state !== 'saved') return undefined;
    const t = setTimeout(() => setState(''), 1800);
    return () => clearTimeout(t);
  }, [state]);

  // Grow with the text (2 to 8 lines).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 8 * 18 + 12)}px`;
  }, [value]);

  // The card can close without a blur (outside click, Escape): keep the latest draft for the unmount flush.
  const pending = useRef(null);
  pending.current = draft !== null && cleanNote(draft) !== text ? draft : null;
  useEffect(() => () => {
    if (pending.current !== null) saveUserNote(uid, pending.current).catch((e) => console.warn('[notes] save failed', e));
  }, [uid]);

  const save = async () => {
    if (draft === null) return;
    const next = cleanNote(draft);
    if (next === text) {
      setDraft(null);
      return;
    }
    pending.current = null;
    setState('saving');
    try {
      await saveUserNote(uid, next);
      setDraft(null);
      setState('saved');
    } catch (e) {
      setState(e?.message || "Couldn't save the note");
    }
  };

  const status = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state;
  return (
    <div className="pf-note">
      <label className="pf-note-label" htmlFor={id}>
        Note <span className="pf-muted-sm">· only you can see this</span>
      </label>
      <textarea
        id={id}
        ref={taRef}
        className="pf-note-input"
        rows={2}
        maxLength={NOTE_MAX}
        placeholder={loading ? 'Loading…' : error ? "Couldn't decrypt your note" : 'Click to add a note'}
        disabled={loading}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
        aria-describedby={`${id}-state`}
      />
      <span id={`${id}-state`} className={`pf-note-state${state && state !== 'saving' && state !== 'saved' ? ' err' : ''}`} aria-live="polite">
        {status}
      </span>
    </div>
  );
}

/** Small note icon next to a user I have a note about. */
export function NoteMark({ uid }) {
  const uids = useNoteUids();
  if (!uids.has(uid)) return null;
  return (
    <span className="pf-note-mark" role="img" aria-label="You have a private note about this user" title="You have a private note about this user">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 3h10l4 4v14H5z" />
        <path d="M9 11h6M9 15h6" />
      </svg>
    </span>
  );
}

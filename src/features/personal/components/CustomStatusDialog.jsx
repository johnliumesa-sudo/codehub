// "Set a custom status" dialog: emoji + text (<= 80 characters) + clear after, with presets.
// Saved to upub/{me}/status/now (public: every signed-in user can read it).
import { useEffect, useId, useRef, useState } from 'react';
import EmojiPopover from '../../../components/chat/EmojiPopover.jsx';
import { myUid } from '../../../lib/ext/store.js';
import {
  CLEAR_AFTER, STATUS_PRESETS, STATUS_TEXT_MAX, cleanEmoji, cleanStatusText, describeUntil, readCustomStatus,
} from '../lib/statusCore.js';
import { clearCustomStatus, setCustomStatus, useMyPublicStatus } from '../lib/status.js';
import Dialog from './Dialog.jsx';

export default function CustomStatusDialog({ onClose }) {
  let uid = null;
  try {
    uid = myUid();
  } catch {
    uid = null;
  }
  const { loading, value } = useMyPublicStatus(uid);
  const [emoji, setEmoji] = useState('');
  const [text, setText] = useState('');
  const [clear, setClear] = useState('4h');
  const [loaded, setLoaded] = useState(false);
  const [picker, setPicker] = useState(null); // DOMRect
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const emojiBtn = useRef(null);
  const textId = useId();
  const clearId = useId();
  const noteId = useId();

  const existing = readCustomStatus(value);
  useEffect(() => {
    if (loading || loaded) return;
    if (existing) {
      setEmoji(existing.emoji);
      setText(existing.text);
      setClear(existing.until ? 'keep' : 'never');
    }
    setLoaded(true);
  }, [loading, loaded, existing]);

  const count = Array.from(text).length;
  const cleanText = cleanStatusText(text);
  const canSave = !busy && (cleanEmoji(emoji) || cleanText);

  const save = async (e) => {
    e?.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError('');
    try {
      await setCustomStatus({ emoji, text, clear, until: clear === 'keep' ? existing?.until : undefined });
      onClose();
    } catch (err) {
      setError(err?.message || "Couldn't save your status");
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await clearCustomStatus();
      onClose();
    } catch (err) {
      setError(err?.message || "Couldn't clear your status");
      setBusy(false);
    }
  };

  const clearOptions = [
    ...(existing?.until ? [{ id: 'keep', label: `Keep current (${describeUntil(existing.until).toLowerCase()})` }] : []),
    ...CLEAR_AFTER,
  ];

  return (
    <Dialog title="Set a custom status" onClose={onClose} className="pf-status-dialog" describedBy={noteId}>
      <form onSubmit={save} className="pf-form">
        <div className="pf-status-row">
          <button
            ref={emojiBtn}
            type="button"
            className="pf-emoji-btn"
            aria-label={emoji ? `Status emoji ${emoji}. Change emoji` : 'Choose a status emoji'}
            aria-haspopup="dialog"
            onClick={() => setPicker(emojiBtn.current.getBoundingClientRect())}
          >
            {emoji || <span aria-hidden="true">🙂</span>}
          </button>
          <label className="pf-sr" htmlFor={textId}>Status text</label>
          <input
            id={textId}
            className="input pf-status-input"
            value={text}
            data-autofocus
            maxLength={STATUS_TEXT_MAX * 2}
            placeholder="What's happening?"
            onChange={(e) => setText(e.target.value)}
            aria-describedby={`${textId}-count`}
          />
          {(emoji || text) && (
            <button type="button" className="btn ghost sm" onClick={() => { setEmoji(''); setText(''); }} aria-label="Clear the emoji and text">
              ✕
            </button>
          )}
        </div>
        <div id={`${textId}-count`} className={`pf-count${count > STATUS_TEXT_MAX ? ' over' : ''}`} aria-live="polite">
          {count > STATUS_TEXT_MAX ? `Only the first ${STATUS_TEXT_MAX} characters are kept` : `${count}/${STATUS_TEXT_MAX}`}
        </div>

        {!existing && (
          <div className="pf-presets" role="group" aria-label="Suggestions">
            {STATUS_PRESETS.map((p) => (
              <button
                key={p.text}
                type="button"
                className="pf-preset"
                onClick={() => {
                  setEmoji(p.emoji);
                  setText(p.text);
                  setClear(p.clear);
                }}
              >
                <span aria-hidden="true">{p.emoji}</span> {p.text}
              </button>
            ))}
          </div>
        )}

        <label className="field" htmlFor={clearId}>
          <span>Clear after</span>
          <select id={clearId} className="input" value={clear} onChange={(e) => setClear(e.target.value)}>
            {clearOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
        <p id={noteId} className="pf-note-text">Your custom status is public: anyone signed in to Codehub can see it.</p>
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="pf-actions">
          {existing && (
            <button type="button" className="btn ghost" onClick={remove} disabled={busy}>Clear status</button>
          )}
          <span className="pf-spacer" />
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!canSave}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
      {picker && (
        <EmojiPopover
          anchorRect={picker}
          onSelect={(v) => {
            const e = cleanEmoji(v);
            if (e) setEmoji(e);
          }}
          onClose={() => {
            setPicker(null);
            emojiBtn.current?.focus();
          }}
        />
      )}
    </Dialog>
  );
}

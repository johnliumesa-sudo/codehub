// "Remind me" dialog for a message: presets (20 min, 1 h, 3 h, tomorrow 9:00) or a custom date and
// time, plus an optional note. Opened from the message action through openRemindDialog(); rendered by
// RemindDialogHost (appMounts) so it sits above the chat like the app's other modals.
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Modal } from '../../../components/layout/ui.jsx';
import { createReminder } from '../lib/reminders.js';
import { MAX_NOTE } from '../lib/reminderModel.js';
import { formatDue, fromLocalInput, presets, toLocalInput } from '../lib/when.js';

let pending = null; // { conv, mid, title, excerpt, author, toast }
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

export function openRemindDialog(payload) {
  pending = payload ? { ...payload, key: Date.now() } : null;
  emit();
}

const usePending = () => useSyncExternalStore(
  (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  () => pending,
  () => pending,
);

export function RemindDialogHost() {
  const p = usePending();
  if (!p) return null;
  return <RemindDialog key={p.key} payload={p} onClose={() => openRemindDialog(null)} />;
}

function RemindDialog({ payload, onClose }) {
  const [note, setNote] = useState('');
  const [custom, setCustom] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(Date.now() + 3_600_000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => new Date());
  const noteId = useId();
  const whenId = useId();
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const save = async (due) => {
    if (!Number.isFinite(due) || due <= Date.now()) {
      setError('Pick a time in the future.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createReminder({ due, note, conv: payload.conv, mid: payload.mid, title: payload.title, excerpt: payload.excerpt, author: payload.author });
      payload.toast?.(`Reminder set for ${formatDue(due)}`, 'ok');
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not save the reminder');
      setBusy(false);
    }
  };

  return (
    <Modal title="Remind me" onClose={onClose} className="mx-remind-modal">
      {(payload.excerpt || payload.author) && (
        <blockquote className="mx-remind-quote">
          {payload.author && <strong>{payload.author}</strong>}
          {payload.excerpt && <span>{payload.excerpt}</span>}
        </blockquote>
      )}
      <label className="field mx-remind-field" htmlFor={noteId}>
        <span>Note (optional, only you see it)</span>
        <input
          id={noteId}
          className="input"
          value={note}
          maxLength={MAX_NOTE}
          placeholder="What should you do?"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="mx-remind-presets" role="group" aria-label="When">
        {presets(now).map((p) => (
          <button key={p.id} type="button" className="btn ghost mx-remind-preset" disabled={busy} onClick={() => save(p.due)}>
            <span>{p.label}</span>
            <span className="muted">{formatDue(p.due, now)}</span>
          </button>
        ))}
        <button type="button" className="btn ghost mx-remind-preset" aria-expanded={custom} disabled={busy} onClick={() => setCustom((c) => !c)}>
          <span>Custom…</span>
          <span className="muted">Pick a date and time</span>
        </button>
      </div>
      {custom && (
        <form
          className="mx-remind-custom"
          onSubmit={(e) => {
            e.preventDefault();
            save(fromLocalInput(when));
          }}
        >
          <label className="field" htmlFor={whenId}>
            <span>Date and time</span>
            <input id={whenId} className="input" type="datetime-local" value={when} min={toLocalInput(Date.now())} onChange={(e) => setWhen(e.target.value)} required />
          </label>
          <button type="submit" className="btn primary" disabled={busy}>Set reminder</button>
        </form>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted small mx-remind-note">
        Reminders are encrypted and stored in your account. They go off while Codehub is open in a tab; one that came due
        while you were away goes off the next time you open Codehub.
      </p>
    </Modal>
  );
}

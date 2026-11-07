// Report a published bot through the existing reports flow (submitReport: plaintext, admins only,
// one report per 30 s): kind `bot`, target = the pub/bots id, the reported version in the note.
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NOTE_MAX, REPORT_REASONS, submitReport } from '../../../lib/reports.js';
import '../../../components/admin/admin.css';

export const botReportNote = (entry, note) => {
  const head = `[v${entry.ver}]`;
  const body = String(note || '').trim();
  return `${head}${body ? ` ${body}` : ''}`.slice(0, NOTE_MAX);
};

function ReportDialog({ entry, onClose }) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const box = useRef(null);
  const room = NOTE_MAX - botReportNote(entry, '').length - 1;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.activeElement;
    box.current?.querySelector('input,button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);

  async function send(e) {
    e.preventDefault();
    if (!reason || busy) return;
    setBusy(true);
    setErr('');
    try {
      await submitReport({ kind: 'bot', target: entry.id, reason, note: botReportNote(entry, note) });
      setDone(true);
    } catch (ex) {
      setErr(ex?.message || 'Could not send the report.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop adm-backdrop"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={box} className="modal adm-report-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`}>
        {done ? (
          <div className="adm-report-done">
            <h2 id={`${id}-t`}>Report sent</h2>
            <p className="muted">Thanks. Codehub app admins will review this bot.</p>
            <button type="button" className="btn primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={send} className="adm-report-form">
            <h2 id={`${id}-t`}>Report bot</h2>
            <p className="adm-note">
              Reports go to Codehub app admins as plaintext: the bot&apos;s id and version, your reason and note.
            </p>
            <fieldset className="adm-reasons">
              <legend>Reason</legend>
              {REPORT_REASONS.map(([rid, label]) => (
                <label key={rid} className={`adm-reason${reason === rid ? ' on' : ''}`}>
                  <input type="radio" name={`${id}-reason`} value={rid} checked={reason === rid} onChange={() => setReason(rid)} />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span>Note (optional)</span>
              <textarea className="input adm-textarea" rows={3} maxLength={Math.max(0, room)} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {err && <p className="error-text" role="alert">{err}</p>}
            <div className="adm-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn danger" disabled={!reason || busy}>{busy ? 'Sending…' : 'Send report'}</button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default function BotReportButton({ entry }) {
  const [open, setOpen] = useState(false);
  if (!entry?.ok) return null;
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>Report</button>
      {open && <ReportDialog entry={entry} onClose={() => setOpen(false)} />}
    </>
  );
}

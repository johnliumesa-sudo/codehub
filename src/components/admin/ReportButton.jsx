import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EXCERPT_MAX, KIND_LABEL, NOTE_MAX, REPORT_REASONS, submitReport } from '../../lib/reports.js';
import './admin.css';

function FlagIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </svg>
  );
}

// Own portal host: native mouse/pointer events stop here, so "click outside" listeners on
// document (e.g. the member profile card) don't close the card, and with it this modal.
function usePortalHost() {
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.className = 'adm-portal';
    return el;
  });
  useEffect(() => {
    const stop = (e) => e.stopPropagation();
    const evs = ['mousedown', 'pointerdown', 'touchstart', 'click'];
    document.body.appendChild(host);
    evs.forEach((ev) => host.addEventListener(ev, stop));
    return () => {
      evs.forEach((ev) => host.removeEventListener(ev, stop));
      host.remove();
    };
  }, [host]);
  return host;
}

function ReportModal({ kind, target, excerpt, onClose }) {
  const host = usePortalHost();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const boxRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.activeElement;
    boxRef.current?.querySelector('input,button')?.focus?.();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);

  const canExcerpt = kind === 'message' && typeof excerpt === 'string' && excerpt.trim().length > 0;
  const shown = canExcerpt ? excerpt.slice(0, EXCERPT_MAX) : '';

  async function send(e) {
    e.preventDefault();
    if (!reason || busy) return;
    setBusy(true);
    setErr('');
    try {
      await submitReport({ kind, target, reason, note, excerpt: canExcerpt && share ? shown : '' });
      if (mounted.current) setDone(true);
    } catch (e2) {
      if (mounted.current) setErr(e2?.message || 'Could not send the report.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const title = `Report ${(KIND_LABEL[kind] || 'content').toLowerCase()}`;

  return createPortal(
    <div
      className="modal-backdrop adm-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={boxRef} className="modal adm-report-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div className="adm-report-done">
            <div className="adm-report-done-icon"><FlagIcon size={22} /></div>
            <h2>Report sent</h2>
            <p className="muted">Thanks. Codehub app admins will review it. They only see what is in the report — never your encrypted conversations.</p>
            <button type="button" className="btn primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={send} className="adm-report-form">
            <h2>{title}</h2>
            <p className="adm-note">
              Reports go to Codehub app admins as plaintext: the {KIND_LABEL[kind]?.toLowerCase() || 'item'} id, your reason and note.
              {kind === 'message' && ' Admins cannot decrypt messages, so they only see the text if you choose to include it below.'}
            </p>

            <fieldset className="adm-reasons">
              <legend>Reason</legend>
              {REPORT_REASONS.map(([id, label]) => (
                <label key={id} className={`adm-reason${reason === id ? ' on' : ''}`}>
                  <input type="radio" name="adm-reason" value={id} checked={reason === id} onChange={() => setReason(id)} />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>

            <label className="field">
              <span className="adm-label-row">Note (optional) <span className="adm-count">{note.length}/{NOTE_MAX}</span></span>
              <textarea
                className="input adm-textarea"
                rows={3}
                maxLength={NOTE_MAX}
                value={note}
                placeholder="Anything that helps admins understand the problem"
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            {canExcerpt && (
              <div className={`adm-excerpt-opt${share ? ' on' : ''}`}>
                <label className="adm-check">
                  <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
                  <span>Include the message text (this shares it with app admins in plaintext)</span>
                </label>
                {share && (
                  <blockquote className="adm-excerpt-preview">
                    {shown}
                    {excerpt.length > EXCERPT_MAX && <span className="muted"> … (trimmed to {EXCERPT_MAX} characters)</span>}
                  </blockquote>
                )}
              </div>
            )}

            {err && <p className="error-text">{err}</p>}
            <div className="adm-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn danger adm-report-send" disabled={!reason || busy}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    host,
  );
}

/**
 * Report something to app admins.
 * Props: kind 'game'|'user'|'shopItem'|'message', target (id string, ≤ 256),
 *        label? (button text; default "Report"), excerpt? (decrypted message text, offered
 *        only behind an explicit opt-in checkbox), small?, iconOnly?, className? (overrides button classes).
 */
export default function ReportButton({ kind, target, label = 'Report', excerpt, small, iconOnly, className, title }) {
  const [open, setOpen] = useState(false);
  if (!kind || !target) return null;
  const cls = className || `btn ${small ? 'sm ' : ''}ghost adm-report-btn`;
  return (
    <>
      <button
        type="button"
        className={cls}
        title={title || `Report this ${(KIND_LABEL[kind] || 'item').toLowerCase()}`}
        aria-label={iconOnly ? label : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <FlagIcon size={small || iconOnly ? 14 : 15} />
        {!iconOnly && <span>{label}</span>}
      </button>
      {open && <ReportModal kind={kind} target={target} excerpt={excerpt} onClose={() => setOpen(false)} />}
    </>
  );
}

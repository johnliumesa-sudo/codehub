// "Report add-on" through the existing reports flow (see lib/report.js for how it is filed).
import { useState } from 'react';
import { NOTE_MAX, REPORT_REASONS, submitReport } from '../../../lib/reports.js';
import { ADDON_REPORT_KIND, addonReportTarget } from '../lib/report.js';
import Dialog from './Dialog.jsx';
import { errText } from './bits.jsx';

export default function ReportAddon({ addon }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>
        Report
      </button>
      {open && <ReportDialog addon={addon} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportDialog({ addon, onClose }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <Dialog title="Report sent" onClose={onClose}>
        <p className="muted">Thanks. Codehub app admins will review “{addon.name}” and can remove it from the directory.</p>
        <div className="ad-actions">
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title={`Report “${addon.name}”`} onClose={onClose}>
      <form
        className="ad-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!reason || busy) return;
          setBusy(true);
          setErr('');
          try {
            await submitReport({ kind: ADDON_REPORT_KIND, target: addonReportTarget(addon.id), reason, note });
            setDone(true);
          } catch (e2) {
            setErr(errText(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="ad-hint muted">Reports go to Codehub app admins as plaintext: the add-on id, your reason and your note.</p>
        <fieldset className="ad-perm-pick">
          <legend>Reason</legend>
          {REPORT_REASONS.map(([id, label]) => (
            <label key={id} className="ad-check">
              <input type="radio" name="ad-report-reason" value={id} checked={reason === id} onChange={() => setReason(id)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <label className="ad-field">
          <span>Note (optional) <span className="muted">{note.length}/{NOTE_MAX}</span></span>
          <textarea className="input" rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {err && <p className="error-text" role="alert">{err}</p>}
        <div className="ad-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn danger" disabled={!reason || busy}>{busy ? 'Sending…' : 'Send report'}</button>
        </div>
      </form>
    </Dialog>
  );
}

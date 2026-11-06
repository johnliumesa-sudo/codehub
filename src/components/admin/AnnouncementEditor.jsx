import { useEffect, useRef, useState } from 'react';
import { ANN_MAX, clearAnnouncement, setAnnouncement, useAnnouncement } from '../../lib/announcements.js';
import { useProfile } from '../../lib/profiles.js';
import './admin.css';

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function CurrentAnnouncement({ ann }) {
  const author = useProfile(ann.by);
  return (
    <div className={`adm-ann-current ${ann.level}`}>
      <div className="adm-ann-current-head">
        <span className={`adm-pill ${ann.level === 'warn' ? 'warn' : 'info'}`}>{ann.level}</span>
        <span className="muted">Live since {fmt(ann.ts)} · by {author?.name || '…'}</span>
      </div>
      <p className="adm-ann-current-text">{ann.text}</p>
    </div>
  );
}

/** Admin-only editor for announcements/current (plain text, ≤ 280 chars, info|warn). */
export default function AnnouncementEditor() {
  const { ann, loading } = useAnnouncement();
  const [text, setText] = useState('');
  const [level, setLevel] = useState('info');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {ok, text}
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const clean = text.trim();

  async function run(fn, okText) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (mounted.current) setMsg({ ok: true, text: okText });
      return true;
    } catch (err) {
      if (mounted.current) setMsg({ ok: false, text: err?.message || 'Something went wrong.' });
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function publish(e) {
    e.preventDefault();
    if (!clean) return;
    const ok = await run(() => setAnnouncement({ text: clean, level }), 'Announcement published to everyone.');
    if (ok && mounted.current) setText('');
  }

  return (
    <div className="adm-section">
      <p className="adm-note">
        One global announcement shown at the top of the app for every signed-in user. It is stored and shown as
        <strong> public plain text</strong> (no Markdown, links are not clickable). Users can dismiss it; publishing a new one shows it again.
      </p>

      <div className="adm-card">
        <h3>Current</h3>
        {loading ? <div className="adm-loading"><div className="spinner" /></div> : ann ? <CurrentAnnouncement ann={ann} /> : <p className="muted">No announcement is live.</p>}
        {ann && (
          <div className="adm-actions">
            <button type="button" className="btn danger sm" disabled={busy} onClick={() => run(clearAnnouncement, 'Announcement cleared.')}>
              Clear announcement
            </button>
          </div>
        )}
      </div>

      <form className="adm-card" onSubmit={publish}>
        <h3>{ann ? 'Replace announcement' : 'New announcement'}</h3>
        <label className="field">
          <span className="adm-label-row">Text <span className={`adm-count${text.length > ANN_MAX ? ' over' : ''}`}>{text.length}/{ANN_MAX}</span></span>
          <textarea
            className="input adm-textarea"
            rows={3}
            maxLength={ANN_MAX}
            value={text}
            placeholder="Scheduled maintenance tonight at 22:00 UTC…"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="field adm-level">
          <span>Level</span>
          <div className="adm-seg" role="radiogroup" aria-label="Level">
            {['info', 'warn'].map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={level === l}
                className={`adm-seg-btn ${l}${level === l ? ' on' : ''}`}
                onClick={() => setLevel(l)}
              >
                {l === 'info' ? 'Info' : 'Warning'}
              </button>
            ))}
          </div>
        </div>
        {clean && (
          <div className="adm-preview">
            <span className="muted adm-preview-label">Preview</span>
            <div className={`adm-banner ${level} static`}>
              <span className="adm-banner-label">Announcement</span>
              <span className="adm-banner-text">{clean}</span>
            </div>
          </div>
        )}
        <div className="adm-actions">
          {msg && <span className={msg.ok ? 'adm-ok' : 'error-text'}>{msg.text}</span>}
          <button className="btn primary" disabled={busy || !clean || clean.length > ANN_MAX}>
            {busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Owner dashboard → Database rules: the minified rules the build emits next to index.html
// (rules.min.json, see vite.config.js), with their size against the console's paste limit.
// Fetched only when the panel is opened. The rules hold no secrets.
import { useState } from 'react';
import { CopyButton } from './CopyButton.jsx';

export const RULES_LIMIT = 102400;

export default function RulesPanel() {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState({ loading: false, text: '', error: '' });

  async function load() {
    setSt({ loading: true, text: '', error: '' });
    try {
      const r = await fetch('./rules.min.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      JSON.parse(text); // must be the JSON the console expects
      setSt({ loading: false, text, error: '' });
    } catch {
      setSt({ loading: false, text: '', error: 'Could not load the rules file (rules.min.json) from this site.' });
    }
  }
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !st.text && !st.loading) load();
  }

  const bytes = st.text ? new TextEncoder().encode(st.text).length : 0;
  const pct = Math.min(100, (bytes / RULES_LIMIT) * 100);
  const over = bytes > RULES_LIMIT;
  return (
    <section className="pm-card" aria-labelledby="pm-rules-h">
      <div className="pm-card-head">
        <h3 id="pm-rules-h">Database rules</h3>
        <button type="button" className="btn sm" aria-expanded={open} aria-controls="pm-rules-body" onClick={toggle}>
          {open ? 'Hide' : 'Show rules'}
        </button>
      </div>
      {open && (
        <div id="pm-rules-body" className="pm-rules">
          {st.loading && <div className="spinner" />}
          {st.error && <p className="error-text" role="alert">{st.error}</p>}
          {st.text && (
            <>
              <div className="pm-rules-meta">
                <span>
                  <strong data-testid="rules-bytes">{bytes.toLocaleString('en-US')}</strong> of {RULES_LIMIT.toLocaleString('en-US')} bytes
                  {over ? ' (too big to paste)' : ` · ${(RULES_LIMIT - bytes).toLocaleString('en-US')} left`}
                </span>
                <CopyButton text={st.text} label="Copy rules">Copy rules</CopyButton>
              </div>
              <div className={`pm-meter ${over ? 'over' : ''}`} role="meter" aria-label="Rules size" aria-valuemin={0} aria-valuemax={RULES_LIMIT} aria-valuenow={bytes}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <textarea className="input pm-rules-text" readOnly value={st.text} aria-label="Minified database rules" rows={6} spellCheck={false} />
              <p className="adm-note">
                Paste into Firebase console → Realtime Database → Rules, replacing everything, then Publish. This is the copy built
                with this version of the app.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

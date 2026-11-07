// App-wide "Codehub has been updated" banner (mounted next to <App /> in main.jsx, so it shows on the
// sign-in screen too). State comes from the update watcher in src/lib/appVersion.js. The live region is
// always mounted so screen readers announce the message when it appears; focus is never moved.
import { useSyncExternalStore } from 'react';
import { getUpdateWatcher } from '../../lib/appVersion.js';
import './updateBanner.css';

const IDLE = { kind: null };
const noop = () => () => {};

function message(s) {
  if (s.kind === 'update') return 'Codehub has been updated. Reload to get the latest version.';
  if (s.offline) return "Part of Codehub couldn't load because you're offline. Reload when you're back online.";
  return "Part of Codehub couldn't load. Reload to get the latest version.";
}

export default function UpdateBanner() {
  const w = getUpdateWatcher();
  const s = useSyncExternalStore(w ? w.subscribe : noop, w ? w.getState : () => IDLE, () => IDLE);
  return (
    <div className="upd-dock" role="status" aria-live="polite" aria-label="Codehub update">
      {s.kind && (
        <div className={`upd-card ${s.kind}`} data-kind={s.kind}>
          <svg className="upd-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="upd-text">{message(s)}</p>
          <div className="upd-actions">
            <button type="button" className="btn sm primary" onClick={() => w.reload()}>Reload</button>
            <button type="button" className="btn sm ghost" onClick={() => w.dismiss()}>Later</button>
          </div>
        </div>
      )}
    </div>
  );
}

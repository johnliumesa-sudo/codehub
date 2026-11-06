import { useState } from 'react';
import { getDismissedTs, setDismissedTs, useAnnouncement } from '../../lib/announcements.js';
import './admin.css';

/**
 * Global announcement bar for the top of Workspace. Plain text only (React escapes it);
 * dismissal is remembered per announcement ts in localStorage, so a new one shows again.
 */
export default function AnnouncementBanner() {
  const { ann } = useAnnouncement();
  const [dismissed, setDismissed] = useState(getDismissedTs);
  if (!ann || ann.ts === dismissed) return null;
  const warn = ann.level === 'warn';
  return (
    <div className={`adm-banner ${warn ? 'warn' : 'info'}`} role={warn ? 'alert' : 'status'}>
      <span className="adm-banner-icon" aria-hidden="true">
        {warn ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 2 20h20L12 3ZM12 10v4M12 17h.01" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01" /></svg>
        )}
      </span>
      <span className="adm-banner-label">Announcement</span>
      <span className="adm-banner-text">{ann.text}</span>
      <button
        type="button"
        className="adm-banner-x"
        aria-label="Dismiss announcement"
        title="Dismiss"
        onClick={() => {
          setDismissedTs(ann.ts);
          setDismissed(ann.ts);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

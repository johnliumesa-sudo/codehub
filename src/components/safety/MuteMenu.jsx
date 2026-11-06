import { useCallback, useState } from 'react';
import { MUTE_OPTIONS, activePref, describePref, effectiveLevel, serverScope, setScopePref, useNotifPrefs } from '../../lib/notify.js';
import { Menu, useToast } from '../layout/ui.jsx';
import './safety.css';

function BellIcon({ off, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16ZM10 21h4" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

/**
 * Bell button + dropdown to mute a conversation or a whole server (F19).
 * Props:
 *  - me: uid or { uid } (required)
 *  - scope: '{sid}_{cid}' | 'dm_{dmId}' | 'grp_{gid}' | 'srv_{sid}' (required)
 *  - sid: for channel scopes, the server id (so a muted server shows as inherited)
 *  - label: e.g. 'channel', 'conversation', 'server' (used in item text)
 *  - align: 'right' (default) | 'left'
 *  - className: extra class for the trigger button (e.g. 'chat-icon-btn' to match the chat header)
 */
export default function MuteMenu({ me, scope, sid, label = 'conversation', align = 'right', className = '' }) {
  const prefs = useNotifPrefs(me);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const close = useCallback(() => setOpen(false), []);
  if (!scope) return null;

  const now = Date.now();
  const own = activePref(prefs, scope, now);
  const level = effectiveLevel(prefs, scope, now, { sid });
  const inheritedFromServer = !own && sid && scope !== serverScope(sid) && !!activePref(prefs, serverScope(sid), now);
  const isMutedNow = level === 'none';
  // A channel inside a muted server needs an explicit 'all' to override; clearing would fall back to the server.
  const serverActive = !!sid && scope !== serverScope(sid) && !!activePref(prefs, serverScope(sid), now);

  const apply = async (pref, msg) => {
    try {
      await setScopePref(me, scope, pref);
      if (msg) toast(msg, 'success');
    } catch (e) {
      toast(e?.message || 'Could not update notifications', 'error');
    }
  };

  const status = inheritedFromServer
    ? `Server muted — ${describePref(activePref(prefs, serverScope(sid), now), now).toLowerCase()}`
    : describePref(own, now);

  return (
    <span className="sf-mute">
      <button
        type="button"
        className={`sf-mute-btn ${isMutedNow ? 'muted-on' : ''} ${level === 'mentions' ? 'mentions' : ''} ${className}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Notifications: ${status}`}
      >
        <BellIcon off={isMutedNow} />
      </button>
      <Menu open={open} onClose={close} align={align} className="sf-mute-menu">
        <div className="sf-mute-head">
          <span>Notifications for this {label}</span>
          <span className="sf-mute-status">{status}</span>
        </div>
        {MUTE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="menuitem"
            className="ly-menu-item"
            onClick={() => apply({ level: o.level, ...(o.ms ? { until: Date.now() + o.ms } : {}) }, `Muted ${o.label.toLowerCase()}`)}
          >
            <span>Mute {o.label.toLowerCase()}</span>
            {!o.ms && own?.level === 'none' && !own.until && <span className="sf-check-mark">✓</span>}
          </button>
        ))}
        <div className="ly-menu-sep" />
        <button type="button" role="menuitem" className="ly-menu-item" onClick={() => apply({ level: 'mentions' }, 'Only @mentions will notify')}>
          <span>Mentions only</span>
          {own?.level === 'mentions' && <span className="sf-check-mark">✓</span>}
        </button>
        <button
          type="button"
          role="menuitem"
          className="ly-menu-item"
          onClick={() => apply(serverActive ? { level: 'all' } : null, isMutedNow || level === 'mentions' ? 'Notifications on' : null)}
          title={serverActive ? 'Notify for this channel even though the server is muted' : undefined}
        >
          <span>{serverActive ? 'All messages (override server)' : 'All messages'}</span>
          {level === 'all' && <span className="sf-check-mark">✓</span>}
        </button>
        {sid && scope !== serverScope(sid) && own?.level === 'all' && (
          <button type="button" role="menuitem" className="ly-menu-item" onClick={() => apply(null, 'Following server setting')}>
            <span>Use server setting</span>
          </button>
        )}
      </Menu>
    </span>
  );
}

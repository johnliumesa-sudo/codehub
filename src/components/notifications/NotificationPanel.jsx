// Popover list of notifications with Mark all read. Clicking an item marks it read and calls onNavigate.
import { useEffect, useMemo, useRef } from 'react';
import { KIND_LABEL, markAllRead, markRead, removeNotif, targetOfNotif, timeAgo, clearAll } from '../../lib/notifications.js';
import { useProfiles } from '../../lib/profiles.js';
import { Avatar } from '../layout/ui.jsx';
import './notifications.css';

export default function NotificationPanel({ me, state, onClose, onNavigate, placement = 'down', align = 'right' }) {
  const ref = useRef(null);
  const { items, loading, unread } = state;
  const shown = items.slice(0, 50);
  const profiles = useProfiles(useMemo(() => shown.map((n) => n.from), [shown]));

  useEffect(() => {
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.nf-bell') && onClose();
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const open = (n) => {
    if (!n.read) markRead(me, n.id).catch(() => {});
    onClose();
    onNavigate?.(n, targetOfNotif(n));
  };

  return (
    <div ref={ref} className={`nf-panel ${placement} ${align}`} role="dialog" aria-label="Notifications" data-testid="notif-panel">
      <div className="nf-head">
        <strong>Notifications</strong>
        <span className="nf-head-actions">
          <button type="button" className="btn ghost sm" disabled={!unread} onClick={() => markAllRead(me, items).catch(() => {})}>
            Mark all read
          </button>
          <button type="button" className="btn ghost sm" disabled={!items.length} onClick={() => clearAll(me).catch(() => {})} title="Delete all notifications">
            Clear
          </button>
        </span>
      </div>
      <div className="nf-list">
        {loading && <div className="nf-empty">Loading…</div>}
        {!loading && !items.length && <div className="nf-empty">You're all caught up.</div>}
        {shown.map((n) => {
          const p = profiles[n.from];
          return (
            <div key={n.id} className={`nf-item${n.read ? '' : ' unread'}`}>
              <button type="button" className="nf-main" onClick={() => open(n)}>
                <Avatar profile={p} size={32} ring="var(--bg-2)" />
                <span className="nf-text">
                  <span className="nf-line">
                    <b>{p?.name || 'Someone'}</b> {KIND_LABEL[n.kind]}
                  </span>
                  <span className="nf-time">{timeAgo(n.ts)}</span>
                </span>
                {!n.read && <span className="nf-dot" aria-label="Unread" />}
              </button>
              <button type="button" className="nf-del" aria-label="Dismiss notification" title="Dismiss" onClick={() => removeNotif(me, n.id).catch(() => {})}>
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Bell button with unread badge; opens NotificationPanel. Render in Header and UserPanel (shares one listener).
import { useCallback, useState } from 'react';
import { useNotifications, useNotificationAlerts, useUnreadTitle } from '../../lib/notifications.js';
import NotificationPanel from './NotificationPanel.jsx';
import './notifications.css';

export function BellIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

/**
 * Props: me ({uid,name}), onNavigate(item, target) when an item is clicked, className, placement 'down'|'up',
 * align 'right'|'left', global (true on exactly ONE instance: drives tab title + desktop alerts).
 */
export default function NotificationBell({ me, onNavigate, className = '', placement = 'down', align = 'right', global = false }) {
  const [open, setOpen] = useState(false);
  const state = useNotifications(me);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className={`nf-wrap ${className}`}>
      {global && <GlobalEffects me={me} state={state} onNavigate={onNavigate} />}
      <button
        type="button"
        className={`btn ghost sm ly-icon-btn nf-bell${open ? ' on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={state.unread ? `Notifications, ${state.unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <BellIcon />
        {state.unread > 0 && <span className="nf-badge" data-testid="notif-badge">{state.unread > 99 ? '99+' : state.unread}</span>}
      </button>
      {open && <NotificationPanel me={me} state={state} onClose={close} onNavigate={onNavigate} placement={placement} align={align} />}
    </span>
  );
}

function GlobalEffects({ me, state, onNavigate }) {
  useUnreadTitle(state.unread);
  useNotificationAlerts({ me, state, onOpen: (n) => onNavigate?.(n) });
  return null;
}

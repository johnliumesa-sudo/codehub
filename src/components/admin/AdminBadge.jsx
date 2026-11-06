import { useAdminBadge, useIsAppAdmin } from '../../lib/admin.js';
import './admin.css';

/** Small shield shown next to a name when adminBadges/{uid} is true. Renders nothing otherwise. */
export default function AdminBadge({ uid, size = 13, className = '' }) {
  const on = useAdminBadge(uid);
  if (!on) return null;
  return (
    <span className={`adm-badge ${className}`} title="Codehub app admin" aria-label="App admin" role="img">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" fillOpacity=".22" />
        <path d="m9 12 2 2 4-4" fill="none" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** Shield button for UserPanel: renders only for app admins and calls onOpen. */
export function AdminShieldButton({ onOpen }) {
  const isAdmin = useIsAppAdmin();
  if (!isAdmin) return null;
  return (
    <button className="btn ghost sm ly-icon-btn adm-shield-btn" onClick={onOpen} title="Admin panel" aria-label="Open admin panel">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    </button>
  );
}

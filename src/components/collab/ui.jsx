// Small shared UI bits for the collab module: icons, modal shell, avatar stack.
import { useEffect } from 'react';
import { initials } from '../../lib/profiles.js';

const P = {
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  chevron: 'm9 6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  github: 'M9 19c-4 1.3-4-2-6-2.5m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 3.3 5.8 3.6 5.8 3.6a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 10c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2v3.5',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  pr: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 15V8a2 2 0 0 0-2-2h-4m0 0 3-3m-3 3 3 3M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  issue: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  diff: 'M12 3v8M8 7h8M8 17h8M5 21h14',
  commit: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 12h6M15 12h6',
  copy: 'M9 9h10v12H9zM5 15H4V3h12v1',
  close: 'M6 6l12 12M18 6 6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-5-5',
  code: 'm8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16',
};

export function Icon({ name, size = 16, className = '', title }) {
  return (
    <svg
      className={`cx-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={P[name]} />
    </svg>
  );
}

export function Modal({ title, icon, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal cx-modal ${wide ? 'cx-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="cx-modal-head">
          <h2>
            {icon && <Icon name={icon} size={18} />} {title}
          </h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Avatar({ profile, size = 22, ring }) {
  const name = profile?.name || '…';
  return (
    <span
      className="avatar cx-avatar"
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.42),
        background: profile?.color || '#5b6275',
        boxShadow: ring ? `0 0 0 2px var(--bg-1), 0 0 0 3.5px ${profile?.color || '#5b6275'}` : undefined,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people, size = 20, max = 4, ring = false }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className="cx-stack">
      {shown.map((p) => (
        <Avatar key={p.uid || p.clientID} profile={p} size={size} ring={ring} />
      ))}
      {extra > 0 && (
        <span className="avatar cx-avatar cx-more" style={{ width: size, height: size, fontSize: size * 0.4 }}>
          +{extra}
        </span>
      )}
    </span>
  );
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

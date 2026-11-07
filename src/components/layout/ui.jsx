// Small shared UI primitives for the layout module: icons, avatar, modal, toasts, menu, error boundary.
import { Component, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { initials } from '../../lib/profiles.js';
import { Avatar as MediaAvatar } from '../media/Avatar.jsx';
import { isChunkLoadError, reportLoadError } from '../../lib/appVersion.js';

// ---------- Icons (inline SVG, currentColor) ----------

const P = {
  hash: 'M5 9h14M4 15h14M10 3 8 21M16 3l-2 18',
  code: 'm8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16',
  gamepad: 'M7 8h10a5 5 0 0 1 4.8 6.4l-.6 2.2a2.5 2.5 0 0 1-4.3 1L15 15.5H9l-1.9 2.1a2.5 2.5 0 0 1-4.3-1l-.6-2.2A5 5 0 0 1 7 8ZM8 10.5v3M6.5 12h3M15.5 11h.01M17.5 13h.01',
  plus: 'M12 5v14M5 12h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1',
  users: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15 4.15a3.25 3.25 0 0 1 0 6.2',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  x: 'M6 6l12 12M18 6 6 18',
  chat: 'M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z',
  crown: 'm4 8 4 4 4-6 4 6 4-4-2 10H6L4 8Z',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pencil: 'm4 20 4-1 11-11-3-3L5 16l-1 4ZM14 6l3 3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  chevron: 'm6 9 6 6 6-6',
  message: 'M4 5h16v11H8l-4 4V5Z',
  back: 'M15 6l-6 6 6 6',
  home: 'M8 5 3 12l5 7M16 5l5 7-5 7',
  door: 'M14 4H6v16h8M10 12h10M17 9l3 3-3 3',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  key: 'M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM12 12v9M12 17h3M12 20h2',
  check: 'm5 12 5 5 9-10',
  userPlus: 'M15 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 8v6M16 11h6',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  dot: 'M12 12h0',
};

export function Icon({ name, size = 18, stroke = 1.8, className = '', title }) {
  return (
    <svg
      className={`ly-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={P[name] || P.dot} />
    </svg>
  );
}

// ---------- Avatar ----------

export function Avatar({ profile, size = 32, presence, ring }) {
  if (profile?.uid) return <MediaAvatar uid={profile.uid} size={size} presence={presence} ring={ring} name={profile.name} color={profile.color} />;
  const name = profile?.name || '?';
  const color = profile?.color || '#5b8cff';
  return (
    <span className="ly-avatar" style={{ width: size, height: size, '--ring': ring || 'var(--bg-1)' }}>
      <span className="avatar" style={{ width: size, height: size, background: color, fontSize: Math.max(10, Math.round(size * 0.38)) }}>
        {initials(name)}
      </span>
      {presence && <span className={`ly-presence ${presence}`} title={presence} />}
    </span>
  );
}

export const PRESENCE_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' };

// ---------- Modal ----------

export function Modal({ title, onClose, children, wide, className = '', footer }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement;
    const first = boxRef.current?.querySelector('input,textarea,select,button:not(.ly-modal-x)');
    first?.focus?.();
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="modal-backdrop ly-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={boxRef} className={`modal ly-modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ly-modal-head">
          <h2>{title}</h2>
          {onClose && (
            <button className="btn ghost sm ly-modal-x" onClick={onClose} aria-label="Close">
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        <div className="ly-modal-body">{children}</div>
        {footer && <div className="ly-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Two-step confirm button: first click arms, second click fires.
export function ConfirmButton({ children, confirmLabel = 'Click to confirm', onConfirm, className = 'btn danger sm', disabled }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`${className} ${armed ? 'armed' : ''}`}
      disabled={disabled || busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {busy ? <span className="spinner ly-spinner-sm" /> : armed ? confirmLabel : children}
    </button>
  );
}

// ---------- Toasts ----------

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text: String(text?.message || text), kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="ly-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ly-toast ${t.kind}`}>
            {t.kind === 'success' && <Icon name="check" size={16} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Dropdown menu ----------

export function Menu({ open, onClose, children, align = 'left', className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const onKey = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={`ly-menu ${align} ${className}`} role="menu" onClick={onClose}>
      {children}
    </div>
  );
}

export function MenuItem({ icon, children, danger, onClick }) {
  return (
    <button className={`ly-menu-item ${danger ? 'danger' : ''}`} role="menuitem" onClick={onClick}>
      <span>{children}</span>
      {icon && <Icon name={icon} size={16} />}
    </button>
  );
}

// ---------- Error boundary (isolates feature modules from the frame) ----------

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[layout] view crashed', error, info);
    reportLoadError(error); // a lazy view's chunk is gone after a deploy: offer the reload
  }
  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (isChunkLoadError(this.state.error)) {
      return (
        <div className="ly-empty">
          <div className="ly-empty-icon danger">!</div>
          <h3>This part of Codehub couldn't load</h3>
          <p className="muted">Codehub may have been updated, or the connection dropped. Reload to continue.</p>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return (
      <div className="ly-empty">
        <div className="ly-empty-icon danger">!</div>
        <h3>Something went wrong here</h3>
        <p className="muted">{String(this.state.error?.message || this.state.error)}</p>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

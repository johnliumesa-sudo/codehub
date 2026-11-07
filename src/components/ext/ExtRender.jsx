// Round 3: safe rendering of extension entries. Each entry renders inside its own error boundary, so
// a failing feature hides itself (inline slots) or shows a short notice (panels, tabs) instead of
// taking the chat or the workspace down.
import { Component, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { reportLoadError } from '../../lib/appVersion.js';

export class ExtBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error(`[ext] ${this.props.label || 'extension'} failed`, error);
    reportLoadError(error); // lazy feature chunk missing after a deploy: offer the reload
  }

  componentDidUpdate(prev) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (!this.props.notice) return null;
    return (
      <div className="ext-failed" role="alert">
        {this.props.label ? `“${this.props.label}” ran into a problem and was turned off for now.` : 'This feature ran into a problem.'}
      </div>
    );
  }
}

function Call({ fn, args }) {
  const out = fn(...args);
  return out === undefined ? null : out;
}

/**
 * Render `fn(...args)` (default entry.render) inside an error boundary. Render functions should not
 * call hooks themselves; return an element of your own component instead.
 * notice: show a short message when it fails (panels, tabs) instead of nothing.
 */
export function ExtRender({ entry, fn = entry?.render, args = [], label, notice = false, resetKey }) {
  if (typeof fn !== 'function') return null;
  return (
    <ExtBoundary label={label || entry?.title || entry?.label || entry?.id} notice={notice} resetKey={resetKey}>
      <Call fn={fn} args={args} />
    </ExtBoundary>
  );
}

/** Call an entry predicate safely: a throwing `when`/`visible` hides the entry. */
export function passes(fn, ...args) {
  if (typeof fn !== 'function') return true;
  try {
    return !!fn(...args);
  } catch (e) {
    console.error('[ext] predicate failed', e);
    return false;
  }
}

/** Run an entry action safely; errors go to onError (a toast) instead of being thrown. */
export async function runSafe(fn, args, onError) {
  try {
    return await fn(...args);
  } catch (e) {
    console.error('[ext] action failed', e);
    onError?.(e?.message || 'That action failed');
    return undefined;
  }
}

/** Icon slot: a string (emoji/short text) or a React node. */
export function ExtIcon({ icon }) {
  if (icon === undefined || icon === null || icon === false || icon === '') return null;
  return <span className="ext-icon" aria-hidden="true">{icon}</span>;
}

/**
 * Accessible pop-up menu anchored to a button, rendered in a portal (never clipped by scroll areas).
 * items: [{ id, label, icon?, danger?, run() }]. Arrow keys / Home / End move, Enter runs, Escape closes
 * and returns focus to the anchor, Tab closes.
 */
export function ExtMenu({ anchor, items, label, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    setPos({ top, left });
    el.querySelector('[role="menuitem"]')?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose(false);
    };
    const onScroll = (e) => {
      if (ref.current?.contains(e.target)) return;
      onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e) => {
    const all = [...(ref.current?.querySelectorAll('[role="menuitem"]') || [])];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      all[(i + 1) % all.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      all[(i - 1 + all.length) % all.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      all[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      all[all.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'Tab') {
      onClose(false);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="ext-menu"
      role="menu"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`ext-menu-item${it.danger ? ' danger' : ''}`}
          onClick={() => {
            onClose(true);
            it.run();
          }}
        >
          <ExtIcon icon={it.icon} />
          <span>{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

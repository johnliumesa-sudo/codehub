// Accessible modal dialog in its own portal, safe to open on top of other modals (settings, server
// settings, admin panel): Escape is caught in the capture phase so only the top dialog closes, Tab
// stays inside, focus moves in on open and returns to the opener on close.
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"])';
const stack = [];

export default function Dialog({ title, onClose, children, footer, wide = false, className = '', role = 'dialog', initialFocus }) {
  const boxRef = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const me = {};
    stack.push(me);
    const prev = document.activeElement;
    const box = boxRef.current;
    const first = (initialFocus && box?.querySelector(initialFocus)) || box?.querySelector('[data-autofocus]') || box?.querySelector(FOCUSABLE);
    (first || box)?.focus?.();
    const onKey = (e) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current?.();
      } else if (e.key === 'Tab' && box) {
        const items = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        } else if (!box.contains(document.activeElement)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div
      className="modal-backdrop ad-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={boxRef}
        className={`modal ad-dialog${wide ? ' wide' : ''} ${className}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="ad-dialog-head">
          <h2 id={titleId}>{title}</h2>
          {onClose && (
            <button type="button" className="ad-icon-btn" onClick={onClose} aria-label={`Close ${title}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>
        <div className="ad-dialog-body">{children}</div>
        {footer && <div className="ad-dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

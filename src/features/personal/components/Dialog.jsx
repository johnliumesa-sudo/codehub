// Modal dialog for the personal features: portal, labelled by its title, focus moves in on open and
// back to the opener on close, Tab stays inside, Escape (from inside the dialog) closes. Popovers
// rendered from inside (emoji picker) live outside the dialog's DOM, so their Escape doesn't close it.
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({ title, onClose, children, className = '', describedBy }) {
  const boxRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const prev = document.activeElement;
    const box = boxRef.current;
    (box?.querySelector('[data-autofocus]') || box?.querySelector(FOCUSABLE))?.focus();
    return () => {
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
  }, []);

  const onKeyDown = (e) => {
    const box = boxRef.current;
    if (!box || !box.contains(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      const all = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div className="modal-backdrop pf-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={boxRef}
        className={`modal pf-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
      >
        <div className="pf-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn ghost sm pf-dialog-x" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

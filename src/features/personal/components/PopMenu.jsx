// Accessible pop-up menu in a portal (never clipped by the sidebar), anchored to a button.
// items: [{ id, label, hint?, icon?, checked? (menuitemradio), danger?, separator?, run() }]
// Arrow keys / Home / End move, Enter / Space run, Escape closes and returns focus to the anchor.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function PopMenu({ anchor, items, label, onClose, className = '' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    // Below the anchor when it fits, otherwise above it (the user panel sits at the bottom).
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setPos({ top, left });
    (el.querySelector('[role^="menuitem"][aria-checked="true"]') || el.querySelector('[role^="menuitem"]'))?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e) => {
    const all = [...(ref.current?.querySelectorAll('[role^="menuitem"]') || [])];
    const i = all.indexOf(document.activeElement);
    const go = (n) => {
      e.preventDefault();
      all[(n + all.length) % all.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'Tab') onClose(false);
  };

  return createPortal(
    <div
      ref={ref}
      className={`pf-menu ${className}`}
      role="menu"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {items.map((it) =>
        it.separator ? (
          <div key={it.id} className="pf-menu-sep" role="separator" />
        ) : (
          <button
            key={it.id}
            type="button"
            role={typeof it.checked === 'boolean' ? 'menuitemradio' : 'menuitem'}
            aria-checked={typeof it.checked === 'boolean' ? it.checked : undefined}
            tabIndex={-1}
            className={`pf-menu-item${it.danger ? ' danger' : ''}${it.checked ? ' on' : ''}`}
            onClick={() => {
              onClose(true);
              it.run();
            }}
          >
            {it.icon && <span className="pf-menu-icon" aria-hidden="true">{it.icon}</span>}
            <span className="pf-menu-text">
              <span className="pf-menu-label">{it.label}</span>
              {it.hint && <span className="pf-menu-hint">{it.hint}</span>}
            </span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

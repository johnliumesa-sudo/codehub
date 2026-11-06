// "Preview" toggle for the CollabView extras toolbar.
//
// Props: { ctx, open?, onOpenChange? }
//   Controlled (open + onOpenChange given): only the toggle renders; the host places
//   <LivePreviewPane ctx onClose/> itself (preferred: as a right split next to the editor).
//   Uncontrolled: the button also renders the pane, docked over the right side of the
//   surrounding editor area (.cx-main / .cx-root), tracking its size.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import LivePreviewPane from './LivePreviewPane.jsx';
import { Icon } from './icons.jsx';
import './sandbox.css';

function useAnchorRect(anchorEl, active) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    if (!active || !anchorEl) {
      setRect(null);
      return undefined;
    }
    const measure = () => {
      const r = anchorEl.getBoundingClientRect();
      setRect({ top: r.top, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, width: r.width });
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(anchorEl);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorEl, active]);
  return rect;
}

export default function PreviewButton({ ctx, open: openProp, onOpenChange }) {
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? !!openProp : openState;
  const setOpen = (v) => {
    if (controlled) onOpenChange?.(v);
    else setOpenState(v);
  };

  const btnRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  useEffect(() => {
    if (controlled || !open) return;
    const el = btnRef.current?.closest('.cx-main') || btnRef.current?.closest('.cx-root') || null;
    setAnchor(el);
  }, [controlled, open]);
  const rect = useAnchorRect(anchor, !controlled && open);

  // Close the floating pane on Escape when focus is inside it.
  const paneHost = useRef(null);
  useEffect(() => {
    if (controlled || !open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && paneHost.current?.contains(document.activeElement)) setOpenState(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controlled, open]);

  const disabled = !ctx?.space || !ctx?.key;

  return (
    <>
      <button
        ref={btnRef}
        className={`btn sm ${open ? 'primary' : 'ghost'} sbx-toggle`}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-pressed={open}
        title="Live preview & console (sandboxed, runs only on this device)"
      >
        <Icon name="eye" size={14} /> Preview
      </button>
      {!controlled &&
        open &&
        createPortal(
          <div
            ref={paneHost}
            className="sbx-float"
            style={
              rect
                ? { top: rect.top, right: rect.right, bottom: rect.bottom, maxWidth: rect.width }
                : { top: 56, right: 0, bottom: 0 }
            }
          >
            <LivePreviewPane ctx={ctx} onClose={() => setOpenState(false)} />
          </div>,
          document.body,
        )}
    </>
  );
}

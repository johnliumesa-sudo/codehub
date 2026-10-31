import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

const H = 435;
const GAP = 8;
const CELL = 36; // emoji-mart: 24px emoji + 12px button padding
const CHROME = 28; // picker side padding + scrollbar
// Fewer columns on narrow screens so the picker never spills off-screen.
const perLineFor = (vw) => Math.max(6, Math.min(9, Math.floor((vw - 2 * GAP - CHROME) / CELL)));
const widthFor = (perLine) => perLine * CELL + CHROME;

// emoji-mart's React wrapper builds the picker once; keep its props stable so it isn't re-rendered.
const StablePicker = memo(function StablePicker({ onSelectRef, onOutsideRef, perLine }) {
  return (
    <Picker
      data={data}
      theme="dark"
      set="native"
      previewPosition="none"
      skinTonePosition="search"
      maxFrequentRows={2}
      perLine={perLine}
      autoFocus
      onEmojiSelect={(e) => onSelectRef.current?.(e)}
      onClickOutside={(e) => onOutsideRef.current?.(e)}
    />
  );
});

/**
 * Floating emoji picker anchored to a DOMRect.
 * props: anchorRect, onSelect(native, emoji), onClose(), keepOpen (stay open after a pick; shift-pick always keeps open)
 */
export default function EmojiPopover({ anchorRect, onSelect, onClose, keepOpen = false }) {
  const boxRef = useRef(null);
  const [pos, setPos] = useState(null);
  const onSelectRef = useRef(null);
  const onOutsideRef = useRef(null);
  const [perLine] = useState(() => perLineFor(window.innerWidth));

  onSelectRef.current = (e) => {
    onSelect(e.native, e);
    if (!keepOpen) onClose();
  };
  onOutsideRef.current = (e) => {
    if (boxRef.current && e?.target && boxRef.current.contains(e.target)) return;
    onClose();
  };

  useLayoutEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Clamp the box to the viewport (CSS caps the picker's own size the same way).
    const w = Math.min(widthFor(perLine), vw - 2 * GAP);
    const h = Math.min(H, vh - 2 * GAP);
    let left = Math.min(Math.max(GAP, anchorRect.right - w), vw - w - GAP);
    let top = anchorRect.top - h - GAP;
    if (top < GAP) top = Math.min(anchorRect.bottom + GAP, vh - h - GAP);
    left = Math.max(GAP, left);
    top = Math.max(GAP, top);
    setPos({ left, top });
  }, [anchorRect, perLine]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onResize = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={boxRef}
      className="emoji-popover"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <StablePicker onSelectRef={onSelectRef} onOutsideRef={onOutsideRef} perLine={perLine} />
    </div>,
    document.body,
  );
}

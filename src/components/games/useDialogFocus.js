// Keyboard focus for the Arcade's modal dialogs (publish dialog, game player):
//   - on open, focus the first element matching `initial` (selectors tried in order), else the dialog
//     itself (give it tabIndex -1); nothing when `initial` is null;
//   - Tab / Shift+Tab wrap around inside the dialog instead of reaching the page behind it;
//   - on close, focus goes back to the element that had it when the dialog opened (the opener).
import { useEffect } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Focusable, visible elements inside `root`, in tab order (DOM order; positive tabindex isn't used here). */
export function focusables(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
}

export function useDialogFocus(ref, { initial = ['input, select, textarea', 'button'] } = {}) {
  useEffect(() => {
    const opener = document.activeElement;
    const root = ref.current;
    let t = 0;
    if (root && initial) {
      t = setTimeout(() => {
        if (root.contains(document.activeElement)) return;
        const list = focusables(root);
        for (const sel of [].concat(initial)) {
          const el = [...root.querySelectorAll(sel)].find((x) => list.includes(x));
          if (el) return el.focus();
        }
        return root.focus(); // nothing to focus yet (still loading): the dialog itself (tabIndex -1)
      }, 0);
    }
    const onKey = (e) => {
      if (e.key !== 'Tab' || !root) return;
      const list = focusables(root);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    root?.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      root?.removeEventListener('keydown', onKey);
      // Back to the opener (the Play / Publish button) when it is still on the page.
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') {
        setTimeout(() => {
          if (opener.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus();
        }, 0);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

// "?" opens a keyboard-shortcut cheat sheet. Mount once near the app root (inside ToastProvider not required).
import { useEffect, useState } from 'react';
import { SHORTCUT_GROUPS, isHelpKey, isTypingTarget } from '../../lib/serverx/shortcuts.js';
import { Modal } from '../layout/ui.jsx';
import './serverx.css';

/** Props: { extraGroups? } appended to the built-in list; { enabled=true } to suppress (e.g. locked vault). */
export function ShortcutsOverlay({ extraGroups = [], enabled = true }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing || !isHelpKey(e) || isTypingTarget(e.target)) return;
      if (!open && document.querySelector('.modal-backdrop')) return; // another dialog is up
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, open]);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)}>
      <div className="sx-shortcuts">
        {[...SHORTCUT_GROUPS, ...extraGroups].map((g) => (
          <section key={g.title}>
            <h3 className="sx-h">{g.title}</h3>
            <dl className="sx-dl">
              {g.items.map((it) => (
                <div key={it.label} className="sx-sc-row">
                  <dt>{it.keys.map((k, i) => <kbd key={i} className="sx-kbd">{k}</kbd>)}</dt>
                  <dd>{it.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

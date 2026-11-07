// Workspace-level assistant entry points: the sidebar toggle (sidebarSections) and the app mount that
// owns the Ctrl/⌘+Shift+Y hotkey and switches the in-memory session when the account changes.
import { useEffect, useRef } from 'react';
import { ensureUser, useSession } from '../lib/session.js';
import { togglePanel } from '../lib/actions.js';
import '../assistant.css';

const selectOpen = (s) => s.panelOpen;

function toggleWithNotice(toast) {
  const reached = togglePanel();
  if (!reached && toast) toast('Open a conversation to see the assistant panel.', 'info');
}

/** Compact "Assistant" row at the top of the sidebar; aria-pressed shows whether the panel is on. */
export function SidebarToggle({ ctx }) {
  const open = useSession(selectOpen);
  return (
    <button
      type="button"
      className={`asst-side-toggle${open ? ' on' : ''}`}
      aria-pressed={open}
      title="Claude assistant (Ctrl/⌘ + Shift + Y)"
      onClick={() => toggleWithNotice(ctx?.toast)}
    >
      <span className="asst-side-glyph" aria-hidden="true">✨</span>
      <span>Assistant</span>
    </button>
  );
}

const isHotkey = (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'KeyY' || String(e.key).toLowerCase() === 'y');

/** Mounted once per Workspace. */
export function AssistantMount({ ctx }) {
  const uid = ctx?.me?.uid;
  useEffect(() => {
    ensureUser(uid);
  }, [uid]);
  const toastRef = useRef(ctx?.toast);
  toastRef.current = ctx?.toast;
  useEffect(() => {
    const onKey = (e) => {
      if (e.isComposing || e.repeat || !isHotkey(e)) return;
      if (document.querySelector('.modal-backdrop, [role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      toggleWithNotice(toastRef.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return null;
}

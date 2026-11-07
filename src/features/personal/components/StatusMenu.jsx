// My status in the user panel: the "Set status" button + menu (online / idle / do not disturb /
// invisible, custom status), the status line under my name, and what my own avatar dot shows.
import { useCallback, useRef, useState } from 'react';
import { usePresence } from '../../../lib/presence.js';
import { MODE_HINT, MODE_LABEL, STATUS_MODES } from '../lib/statusCore.js';
import { clearCustomStatus, setStatusMode, useCustomStatus, useMyStatusMode } from '../lib/status.js';
import { openPersonalDialog } from '../lib/uiBus.js';
import { StatusDot } from './StatusBits.jsx';
import PopMenu from './PopMenu.jsx';

/** What my own avatar should show: invisible / dnd / idle / online (presence alone says 'offline' when invisible). */
export function useMyDisplayPresence(uid) {
  const presence = usePresence(uid);
  const { mode } = useMyStatusMode();
  if (mode === 'invisible') return 'invisible';
  if (mode === 'dnd') return 'dnd';
  return presence;
}

/** The line under my name: custom status, else my profile status, else my mode. */
export function MyStatusLine({ me, display }) {
  const cs = useCustomStatus(me.uid);
  if (cs) {
    return (
      <span className="pf-cstatus" title={cs.text || undefined}>
        {cs.emoji && <span className="pf-cstatus-emoji" aria-hidden={cs.text ? true : undefined}>{cs.emoji}</span>}
        {cs.text && <span className="pf-cstatus-text">{cs.text}</span>}
      </span>
    );
  }
  if (me.status) return me.status;
  return MODE_LABEL[display] || MODE_LABEL.offline;
}

/** Button + menu to change my status. `onError(text)` reports failures (a toast). */
export function StatusButton({ me, onError }) {
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  const display = useMyDisplayPresence(me.uid);
  const { mode } = useMyStatusMode();
  const cs = useCustomStatus(me.uid);

  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);

  const fail = (e) => onError?.(e?.message || "Couldn't change your status");
  const items = [
    ...STATUS_MODES.map((m) => ({
      id: m,
      label: MODE_LABEL[m],
      hint: MODE_HINT[m],
      checked: mode === m,
      icon: <StatusDot state={m} label={false} />,
      run: () => setStatusMode(m).catch(fail),
    })),
    { id: 'sep', separator: true },
    {
      id: 'custom',
      label: cs ? 'Edit custom status…' : 'Set a custom status…',
      icon: cs?.emoji || '🙂',
      run: () => openPersonalDialog('status'),
    },
    ...(cs ? [{ id: 'clear', label: 'Clear custom status', icon: '✕', run: () => clearCustomStatus().catch(fail) }] : []),
  ];

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn ghost sm ly-icon-btn pf-status-btn"
        aria-label={`Status: ${MODE_LABEL[display] || 'Online'}. Change status`}
        title="Set status"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusDot state={display} label={false} />
      </button>
      {open && <PopMenu anchor={btn.current} items={items} label="Set status" onClose={close} className="pf-status-menu" />}
    </>
  );
}

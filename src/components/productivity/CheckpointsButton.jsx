// CollabView extras: opens the checkpoints panel for the active file. Props: { ctx }.
import { useState } from 'react';
import CheckpointsPanel from './CheckpointsPanel.jsx';
import { PdIcon } from './icons.jsx';
import './productivity.css';

export default function CheckpointsButton({ ctx }) {
  const [open, setOpen] = useState(false);
  const disabled = !ctx?.activeFid || !ctx?.key;
  return (
    <>
      <button
        type="button"
        className="btn sm ghost pd-tool-btn"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={disabled ? 'Open a file to manage its checkpoints' : 'Named versions of this file'}
      >
        <PdIcon name="history" /> <span className="pd-tool-label">Checkpoints</span>
      </button>
      {open && !disabled && <CheckpointsPanel ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

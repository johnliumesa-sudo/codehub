// "Publish game" button for the CollabView extras toolbar (channel workspaces and codespaces).
// Props: { ctx, onPublished?(gameId) }
import { useState } from 'react';
import { Icon } from '../sandbox/icons.jsx';
import PublishGameModal from './PublishGameModal.jsx';
import './games.css';

export default function PublishGameButton({ ctx, onPublished }) {
  const [open, setOpen] = useState(false);
  const ready = !!ctx?.space && !!ctx?.key && !!ctx?.me?.uid;
  const readOnly = !!ctx?.readOnly;
  return (
    <>
      <button
        type="button"
        className="btn sm ghost gm-publish-toggle"
        onClick={() => setOpen(true)}
        disabled={!ready || readOnly}
        title={readOnly ? 'Read-only workspace' : 'Publish this workspace as a public game in the Arcade (public plaintext)'}
      >
        <Icon name="upload" size={14} /> Publish game
      </button>
      {open && <PublishGameModal ctx={ctx} onClose={() => setOpen(false)} onPublished={onPublished} />}
    </>
  );
}

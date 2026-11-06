import { useState } from 'react';
import { useBlocks } from '../../lib/blocks.js';
import './safety.css';

/**
 * Hides content authored by a user I blocked behind "Blocked message — Show" (F11).
 * Client-side only: in servers and groups the message is still delivered and decryptable; this just
 * keeps it out of sight until I ask for it.
 * Props: me (uid or { uid }), authorUid, children, label? ('message' by default)
 */
export default function BlockedGate({ me, authorUid, children, label = 'message' }) {
  const myUid = typeof me === 'string' ? me : me?.uid;
  const blocked = useBlocks(myUid);
  const [shown, setShown] = useState(false);
  if (!authorUid || authorUid === myUid || !blocked.has(authorUid)) return children;
  if (shown) {
    return (
      <div className="sf-blocked-shown">
        {children}
        <button type="button" className="sf-blocked-hide" onClick={() => setShown(false)}>Hide blocked {label}</button>
      </div>
    );
  }
  return (
    <div className="sf-blocked-msg" role="note">
      <span className="sf-blocked-glyph" aria-hidden="true">⦸</span>
      <span>Blocked {label}</span>
      <span className="sf-blocked-sep">—</span>
      <button type="button" className="sf-link-btn" onClick={() => setShown(true)}>Show</button>
    </div>
  );
}

// Saved-messages panel. Props: me ({uid}), onOpen?(entry) to jump to the conversation, onClose?.
import { useEffect, useState } from 'react';
import { removeBookmark, subscribeBookmarks } from '../../lib/chatx/bookmarks.js';
import './chatx.css';

export default function BookmarksPanel({ me, onOpen, onClose }) {
  const [items, setItems] = useState(null);
  useEffect(() => subscribeBookmarks(me.uid, setItems), [me.uid]);
  return (
    <section className="cx-panel" aria-label="Saved messages">
      <header className="cx-panel-head">
        <h3>Saved messages</h3>
        {onClose && <button type="button" className="btn ghost sm" onClick={onClose}>Close</button>}
      </header>
      {items === null && <div className="cx-empty">Loading</div>}
      {items?.length === 0 && <div className="cx-empty">Nothing saved yet. Use "Save" on a message.</div>}
      <ul className="cx-list" role="list">
        {items?.map((b) => (
          <li key={b.key} className="cx-bm">
            <div className="cx-bm-meta">
              <strong>{b.author || 'Unknown'}</strong> in {b.conv?.kind === 'channel' ? '# ' : ''}{b.conv?.title || 'conversation'}
              <time> · {new Date(b.msgTs).toLocaleString()}</time>
            </div>
            <div className="cx-bm-text">{b.text || b.code?.content || ''}</div>
            <div className="cx-bm-actions">
              {onOpen && <button type="button" className="btn ghost sm" onClick={() => onOpen(b)}>Jump</button>}
              <button type="button" className="btn ghost sm" onClick={() => removeBookmark(me.uid, b.key)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

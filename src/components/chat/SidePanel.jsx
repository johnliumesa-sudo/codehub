import { useEffect, useMemo, useRef, useState } from 'react';
import { decryptMessage, fetchPinned } from '../../lib/messages.js';
import { Avatar, previewText } from './Message.jsx';

function fmt(ts) {
  if (typeof ts !== 'number') return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function SidePanel(props) {
  const { kind, onClose } = props;
  return (
    <aside className="chat-side">
      <div className="chat-side-head">
        <h3>{kind === 'pins' ? 'Pinned messages' : 'Search'}</h3>
        <button type="button" className="chat-icon-btn" onClick={onClose} title="Close">✕</button>
      </div>
      {kind === 'pins' ? <PinsPanel {...props} /> : <SearchPanel {...props} />}
    </aside>
  );
}

function ResultItem({ m, profile, onJump, children, extra }) {
  return (
    <div className="side-item" onClick={() => onJump(m.mid)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJump(m.mid)}>
      <div className="side-item-head">
        <Avatar profile={profile} size={20} />
        <span className="side-item-name" style={{ color: profile?.color }}>{profile?.name || '…'}</span>
        <span className="side-item-time">{fmt(m.ts)}</span>
        {extra}
      </div>
      <div className="side-item-text">{children}</div>
    </div>
  );
}

function Highlighted({ text, q }) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const out = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) { out.push(text.slice(i)); break; }
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={k++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  return out;
}

function snippetAround(text, q, radius = 70) {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(q);
  if (i < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, i + q.length + radius)}${i + q.length + radius < flat.length ? '…' : ''}`;
}

function SearchPanel({ items, profiles, onJump, hasMore, onLoadMore }) {
  const [q, setQ] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); }, []);

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query && !fromFilter) return [];
    const out = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (!m.body || m.deleted) continue;
      if (fromFilter && m.uid !== fromFilter) continue;
      const hay = `${m.body.text || ''}\n${m.body.code?.filename || ''}\n${m.body.code?.content || ''}`;
      if (query && !hay.toLowerCase().includes(query)) continue;
      out.push({ m, hay });
      if (out.length >= 200) break;
    }
    return out;
  }, [items, query, fromFilter]);

  const authors = useMemo(() => [...new Set(items.map((m) => m.uid))].filter(Boolean), [items]);

  return (
    <div className="chat-side-body">
      <div className="side-search">
        <input ref={input} className="input" placeholder="Search messages & code…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={fromFilter} onChange={(e) => setFromFilter(e.target.value)}>
          <option value="">From anyone</option>
          {authors.map((u) => <option key={u} value={u}>{profiles[u]?.name || u.slice(0, 6)}</option>)}
        </select>
      </div>
      <p className="muted small side-note">
        Search runs locally over the {items.length} decrypted message{items.length === 1 ? '' : 's'} loaded on this device —
        the server can&apos;t search encrypted content.
      </p>
      {hasMore && (
        <button type="button" className="btn sm" onClick={onLoadMore} style={{ alignSelf: 'flex-start' }}>Load older history to search</button>
      )}
      <div className="side-list">
        {(query || fromFilter) && results.length === 0 && <div className="side-empty">No matches in loaded messages.</div>}
        {results.map(({ m, hay }) => (
          <ResultItem key={m.mid} m={m} profile={profiles[m.uid]} onJump={onJump}
            extra={m.body.code ? <span className="side-tag">code</span> : null}>
            <Highlighted text={query ? snippetAround(hay, query) : previewText(m)} q={query} />
          </ResultItem>
        ))}
      </div>
    </div>
  );
}

function PinsPanel({ conv, cryptoKey, keyError, items, profiles, onJump, canPinAny, onUnpin }) {
  const [pins, setPins] = useState(null);
  const [error, setError] = useState(null);

  // Refetch whenever the pinned set among loaded messages changes.
  const loadedSig = useMemo(() => items.filter((m) => m.pinned).map((m) => m.mid).join(','), [items]);

  useEffect(() => {
    if (!cryptoKey) return undefined;
    let alive = true;
    (async () => {
      try {
        let list;
        try {
          list = await fetchPinned(conv);
        } catch {
          list = items.filter((m) => m.pinned); // fall back to loaded messages
        }
        const out = await Promise.all(
          list.filter((m) => !m.deleted).map(async (m) => {
            try {
              return { ...m, body: await decryptMessage(cryptoKey, conv, m.mid, m) };
            } catch (e) {
              return { ...m, error: e?.message || 'decrypt failed' };
            }
          }),
        );
        out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        if (alive) { setPins(out); setError(null); }
      } catch (e) {
        if (alive) setError(e?.message || 'Could not load pins');
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cryptoKey, loadedSig]);

  if (keyError) {
    return (
      <div className="chat-side-body">
        <div className="error-text">Pinned messages can&apos;t be shown: {keyError}</div>
      </div>
    );
  }

  return (
    <div className="chat-side-body">
      {error && <div className="error-text">{error}</div>}
      {!pins && !error && <div className="side-empty"><div className="spinner" /></div>}
      {pins && pins.length === 0 && (
        <div className="side-empty">
          <div style={{ fontSize: 28 }}>📌</div>
          No pinned messages yet.
          <span className="muted small">Hover a message and click the pin icon to keep it handy.</span>
        </div>
      )}
      <div className="side-list">
        {pins?.map((m) => (
          <ResultItem key={m.mid} m={m} profile={profiles[m.uid]} onJump={onJump}
            extra={canPinAny ? (
              <button type="button" className="side-unpin" title="Unpin" onClick={(e) => { e.stopPropagation(); onUnpin(m.mid); setPins((p) => p.filter((x) => x.mid !== m.mid)); }}>✕</button>
            ) : null}>
            {previewText(m)}
          </ResultItem>
        ))}
      </div>
    </div>
  );
}

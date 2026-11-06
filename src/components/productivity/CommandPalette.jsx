// Command palette / quick switcher (F18).
// Props: { open, onClose, me, extraItems?, actions?, onNavigate(target) }
//   extraItems: [{ id, kind: 'group'|'codespace'|string, title, subtitle?, keywords?, target }]
//   actions:    [{ id, title, hint?, keywords?, icon? }]  -> target { type: 'action', id }
// Targets: {type:'server',sid} | {type:'channel',sid,cid,channelType} | {type:'dm',dmId}
//          | {type:'group',gid} | {type:'codespace',csid} | {type:'action',id}
import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightRuns, loadRecents, pushRecent, rank, usePaletteSources } from '../../lib/palette.js';
import { PdIcon } from './icons.jsx';
import './productivity.css';

const MAX_SHOWN = 60;

const KIND_META = {
  server: { icon: 'server', label: 'Server' },
  channel: { icon: 'hash', label: 'Channel' },
  dm: { icon: 'message', label: 'DM' },
  group: { icon: 'users', label: 'Group' },
  codespace: { icon: 'box', label: 'Codespace' },
  action: { icon: 'bolt', label: 'Action' },
};

function iconFor(item) {
  if (item.icon) return item.icon;
  if (item.kind === 'channel') return item.channelType === 'code' ? 'code' : 'hash';
  return KIND_META[item.kind]?.icon || 'bolt';
}

function Highlighted({ text, indices }) {
  return highlightRuns(text, indices).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>));
}

export default function CommandPalette({ open, onClose, me, extraItems = [], actions = [], onNavigate }) {
  const { items: loaded, loading, error } = usePaletteSources(me, open);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState(loadRecents);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const prevFocus = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    prevFocus.current = document.activeElement;
    setQuery('');
    setActive(0);
    setRecents(loadRecents());
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(t);
      const el = prevFocus.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, [open]);

  const all = useMemo(() => {
    const list = [...loaded];
    for (const x of extraItems || []) {
      if (x && typeof x.id === 'string' && x.title && x.target?.type) list.push(x);
    }
    for (const a of actions || []) {
      if (!a?.id || !a.title) continue;
      list.push({
        id: `action:${a.id}`,
        kind: 'action',
        title: a.title,
        subtitle: a.hint || 'Action',
        keywords: a.keywords || [],
        icon: a.icon,
        target: { type: 'action', id: a.id },
      });
    }
    return list;
  }, [loaded, extraItems, actions]);

  const results = useMemo(() => rank(all, query, recents).slice(0, MAX_SHOWN), [all, query, recents]);
  const recentSet = useMemo(() => new Set(recents), [recents]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (active >= results.length) setActive(Math.max(0, results.length - 1));
  }, [results.length, active]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (r) => {
    if (!r) return;
    setRecents(pushRecent(r.item.id));
    onClose();
    onNavigate?.(r.item.target);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey && !e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 8));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 8));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const showRecentHeader = !query.trim() && results.some((r) => recentSet.has(r.item.id));
  const activeId = results[active] ? `pd-pal-opt-${active}` : undefined;

  return (
    <div className="modal-backdrop pd-palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pd-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="pd-palette-input">
          <PdIcon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a channel, DM, server, group, codespace or action…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="pd-pal-list"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <span className="spinner pd-spin" aria-label="Loading" />}
          <kbd className="pd-kbd">Esc</kbd>
        </div>
        <ul className="pd-palette-list" id="pd-pal-list" role="listbox" ref={listRef}>
          {results.length === 0 && (
            <li className="pd-palette-empty muted">
              {loading ? 'Loading…' : query ? `No matches for “${query}”` : 'Nothing to show yet'}
            </li>
          )}
          {results.map((r, i) => {
            const it = r.item;
            const isRecent = !query.trim() && recentSet.has(it.id);
            const firstNonRecent = showRecentHeader && !isRecent && (i === 0 || recentSet.has(results[i - 1].item.id));
            return (
              <li key={it.id} role="presentation">
                {showRecentHeader && i === 0 && isRecent && <div className="pd-palette-section">Recent</div>}
                {firstNonRecent && <div className="pd-palette-section">Everything</div>}
                <button
                  type="button"
                  id={`pd-pal-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  className={`pd-palette-item ${i === active ? 'active' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(r)}
                >
                  <span className={`pd-palette-icon k-${it.kind}`} style={it.color ? { color: it.color } : undefined}>
                    <PdIcon name={iconFor(it)} size={16} />
                  </span>
                  <span className="pd-palette-title">
                    <Highlighted text={it.title} indices={r.indices} />
                  </span>
                  {it.subtitle && <span className="pd-palette-sub">{it.subtitle}</span>}
                  <span className="pd-palette-kind">{KIND_META[it.kind]?.label || it.kind}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="pd-palette-foot muted">
          <span><kbd className="pd-kbd">↑</kbd><kbd className="pd-kbd">↓</kbd> navigate</span>
          <span><kbd className="pd-kbd">↵</kbd> open</span>
          <span className="pd-grow" />
          {error ? <span className="error-text">{error}</span> : <span><PdIcon name="lock" size={11} /> decrypted locally, nothing is sent</span>}
        </div>
      </div>
    </div>
  );
}

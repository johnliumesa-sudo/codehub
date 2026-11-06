import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Message from './Message.jsx';
import BlockedGate from '../safety/BlockedGate.jsx';
import { messageTarget } from '../../lib/reports.js';

const GROUP_WINDOW = 7 * 60 * 1000;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today)) return 'Today';
  if (dayKey(ts) === dayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

const MessageList = forwardRef(function MessageList(props, ref) {
  const {
    items, loading, error, hasMore, onLoadOlder, limitReached, me, profiles, conv, byMid, unreadSince,
    memberNames, editingMid, isAdmin, canPinAny, onReply, onEdit, onEditSave, onEditCancel, onDelete, onReact,
    onOpenReactPicker, onPin, onJump, onCopied,
  } = props;

  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const prevRef = useRef({ firstMid: null, count: 0, height: 0 });
  const [showJump, setShowJump] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const loadingOlderRef = useRef(false);
  // First visible message and its offset from the viewport top. Restoring it is idempotent, so it
  // composes with the browser's own scroll anchoring (Chrome/Firefox) instead of doubling it, and
  // covers browsers without anchoring (Safari) and the scrollTop = 0 case anchoring skips.
  const anchorRef = useRef(null);

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll('[data-mid]');
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.bottom > top) {
        anchorRef.current = { mid: row.getAttribute('data-mid'), offset: r.top - top };
        return;
      }
    }
    anchorRef.current = null;
  }, []);

  const restoreAnchor = useCallback(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a) return false;
    const row = el.querySelector(`[data-mid="${CSS.escape(a.mid)}"]`);
    if (!row) return false;
    const diff = row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
    if (Math.abs(diff) >= 1) el.scrollTop += diff;
    return true;
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => requestAnimationFrame(() => scrollToBottom(false)),
    jumpTo(mid) {
      const el = scrollRef.current?.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlight(mid);
      setTimeout(() => setHighlight((h) => (h === mid ? null : h)), 2200);
    },
  }), [scrollToBottom]);

  // Keep position stable when older messages are prepended; stick to bottom otherwise.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstMid = items[0]?.mid || null;
    const prev = prevRef.current;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (prev.firstMid && firstMid !== prev.firstMid && items.length > prev.count) {
      if (!restoreAnchor()) el.scrollTop += el.scrollHeight - prev.height;
    }
    prevRef.current = { firstMid, count: items.length, height: el.scrollHeight };
    loadingOlderRef.current = false;
    if (!atBottomRef.current) captureAnchor();
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Images/fonts/code highlighting can change heights after layout; keep pinned to bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const inner = el.firstElementChild;
    if (!inner) return undefined;
    // Observe the viewport too: a growing composer / reply bar / on-screen keyboard shrinks it
    // without changing the content height or firing a scroll event.
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
      else restoreAnchor(); // rows above the viewport changed height (e.g. finished decrypting)
      prevRef.current.height = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [loading, restoreAnchor]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = dist < 40;
    setShowJump(dist > 600);
    if (!atBottomRef.current) captureAnchor();
    if (el.scrollTop < 120 && hasMore && !loadingOlderRef.current && !limitReached) {
      loadingOlderRef.current = true;
      prevRef.current.height = el.scrollHeight;
      onLoadOlder();
    }
  };

  // Delegate copy buttons inside rendered Markdown.
  const onClick = (e) => {
    const btn = e.target.closest?.('.md-copy');
    if (!btn) return;
    const code = btn.closest('.md-code')?.querySelector('code')?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
    }).catch(() => {});
  };

  // Where to place the "New messages" divider (fixed on first render of this view).
  const unreadMid = useMemo(() => {
    if (!unreadSince) return null;
    const first = items.find((m) => typeof m.ts === 'number' && m.ts > unreadSince && m.uid !== me.uid);
    return first?.mid || null;
    // Only computed against the read marker captured when the conversation opened.
  }, [items, unreadSince, me.uid]);

  const rows = useMemo(() => {
    const out = [];
    let prev = null;
    for (const m of items) {
      const ts = typeof m.ts === 'number' ? m.ts : Date.now();
      if (!prev || dayKey(ts) !== dayKey(typeof prev.ts === 'number' ? prev.ts : Date.now())) {
        out.push({ type: 'day', key: `day-${m.mid}`, label: dayLabel(ts) });
        prev = null;
      }
      if (m.mid === unreadMid) out.push({ type: 'unread', key: 'unread' });
      const grouped = !!prev && prev.uid === m.uid && !m.replyTo && !prev.deleted && !m.deleted
        && ts - (typeof prev.ts === 'number' ? prev.ts : ts) < GROUP_WINDOW && m.mid !== unreadMid;
      out.push({ type: 'msg', key: m.mid, m, grouped });
      prev = m;
    }
    return out;
  }, [items, unreadMid]);

  if (loading) {
    return (
      <div className="chat-scroll">
        <div className="chat-skeletons">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="sk-row" key={i}>
              <div className="sk-avatar" />
              <div className="sk-lines">
                <div className="sk-line" style={{ width: `${18 + ((i * 7) % 12)}%` }} />
                <div className="sk-line" style={{ width: `${40 + ((i * 23) % 45)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const names = memberNames;

  return (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
        <div className="chat-scroll-inner">
          {error && <div className="chat-inline-error">{error}</div>}
          {hasMore && !limitReached ? (
            <div className="chat-load-older">
              <button type="button" className="btn ghost sm" onClick={() => { loadingOlderRef.current = true; onLoadOlder(); }}>
                Load older messages
              </button>
            </div>
          ) : (
            <Beginning conv={conv} empty={items.length === 0} limitReached={limitReached && hasMore} />
          )}
          {rows.map((r) => {
            if (r.type === 'day') {
              return <div key={r.key} className="chat-day"><span>{r.label}</span></div>;
            }
            if (r.type === 'unread') {
              return <div key={r.key} className="chat-unread-divider"><span>New</span></div>;
            }
            const m = r.m;
            const reply = m.replyTo ? byMid[m.replyTo] || { missing: true } : null;
            return (
              <BlockedGate key={r.key} me={me.uid} authorUid={m.uid}>
              <Message
                m={m}
                conv={conv}
                reportTarget={messageTarget(conv, m)}
                grouped={r.grouped}
                author={profiles[m.uid]}
                me={me}
                profiles={profiles}
                reply={reply}
                replyAuthor={reply && !reply.missing ? profiles[reply.uid] : null}
                knownNames={names}
                editing={editingMid === m.mid}
                highlighted={highlight === m.mid}
                canDelete={m.uid === me.uid || isAdmin}
                canEdit={m.uid === me.uid}
                canPin={canPinAny}
                onReply={onReply}
                onEdit={onEdit}
                onEditSave={onEditSave}
                onEditCancel={onEditCancel}
                onDelete={onDelete}
                onReact={onReact}
                onOpenReactPicker={onOpenReactPicker}
                onPin={onPin}
                onJump={onJump}
                onCopied={onCopied}
              />
              </BlockedGate>
            );
          })}
          <div className="chat-bottom-spacer" />
        </div>
      </div>
      {showJump && (
        <button type="button" className="chat-jump-latest" onClick={() => scrollToBottom(true)}>
          Jump to latest ↓
        </button>
      )}
    </div>
  );
});

function Beginning({ conv, empty, limitReached }) {
  if (limitReached) {
    return <div className="chat-beginning small muted">Older history isn&apos;t loaded in this view.</div>;
  }
  return (
    <div className="chat-beginning">
      <div className="chat-beginning-glyph">{conv.kind === 'dm' ? '@' : conv.kind === 'group' ? '⁂' : '#'}</div>
      <h2>{conv.kind === 'dm' ? conv.title : conv.kind === 'group' ? `Welcome to ${conv.title || 'the group'}` : `Welcome to #${conv.title || 'channel'}`}</h2>
      <p className="muted">
        {conv.kind === 'dm'
          ? <>This is the beginning of your direct messages with <b>{conv.title}</b>.</>
          : conv.kind === 'group'
            ? <>This is the start of the private group <b>{conv.title}</b>.</>
            : <>This is the start of the <b>#{conv.title}</b> channel.</>}
        {' '}Messages are end-to-end encrypted — the server only stores ciphertext.
      </p>
      {empty && <p className="muted small">Say hi 👋</p>}
    </div>
  );
}

export default MessageList;

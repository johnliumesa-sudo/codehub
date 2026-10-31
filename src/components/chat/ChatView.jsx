import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import { useProfiles } from '../../lib/profiles.js';
import {
  PAGE_SIZE,
  decryptMessage,
  deleteMessage,
  editMessage,
  getConvKey,
  getLastRead,
  markRead,
  sendMessage,
  setPinned,
  setReaction,
  setTyping,
  subscribeMessages,
  subscribeTyping,
  emojiKey,
  typingPath,
  typingScope,
} from '../../lib/messages.js';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import EmojiPopover from './EmojiPopover.jsx';
import SnippetModal from './SnippetModal.jsx';
import SafetyNumberModal from './SafetyNumberModal.jsx';
import SidePanel from './SidePanel.jsx';
import ConfirmModal from './ConfirmModal.jsx';
import './chat.css';

const MAX_LIMIT = 2000;

export default function ChatView({ conv, me }) {
  if (!conv) {
    return (
      <div className="chat-root">
        <div className="chat-empty-state">
          <div className="chat-empty-glyph">#</div>
          <h3>No conversation selected</h3>
          <p className="muted">Pick a channel or a direct message to start chatting.</p>
        </div>
      </div>
    );
  }
  const k = conv.kind === 'dm' ? `dm:${conv.dmId}` : `ch:${conv.sid}/${conv.cid}`;
  return <ChatInner key={k} conv={conv} me={me} />;
}

function ChatInner({ conv, me }) {
  const scope = typingScope(conv); // read-marker scope
  const tPath = typingPath(conv);
  const [key, setKey] = useState(null);
  const [keyError, setKeyError] = useState(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [raw, setRaw] = useState(null); // null = loading
  const [rawLimit, setRawLimit] = useState(null); // the limit `raw` was loaded with
  const [sendingMids, setSendingMids] = useState(() => new Set()); // queued, not yet acked
  const [hasMore, setHasMore] = useState(false);
  const [listError, setListError] = useState(null);
  const [bodies, setBodies] = useState({}); // mid -> { body } | { error }
  const [members, setMembers] = useState({}); // uid -> { role }
  const [replyTo, setReplyTo] = useState(null); // mid
  const [editingMid, setEditingMid] = useState(null);
  const [panel, setPanel] = useState(null); // 'search' | 'pins' | null
  const [typingUids, setTypingUids] = useState([]);
  const [unreadSince, setUnreadSince] = useState(null);
  const [showSafety, setShowSafety] = useState(false);
  const [showSnippet, setShowSnippet] = useState(false);
  const [reactPicker, setReactPicker] = useState(null); // { mid, rect }
  const [confirmDelete, setConfirmDelete] = useState(null); // mid
  const [toast, setToast] = useState(null);
  const [pendingJump, setPendingJump] = useState(null);
  const listRef = useRef(null);
  const composerRef = useRef(null);

  const flash = useCallback((text, kind = 'error') => {
    setToast({ text, kind, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Conversation key
  useEffect(() => {
    let alive = true;
    getConvKey(conv)
      .then((k) => alive && setKey(k))
      .catch((e) => alive && setKeyError(e?.message || 'Could not load the encryption key'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live messages
  useEffect(() => {
    setListError(null);
    return subscribeMessages(
      conv,
      limit,
      (list, more) => { setRaw(list); setHasMore(more); setRawLimit(limit); },
      (err) => { setListError(err?.message || 'Could not load messages'); setRaw((r) => r || []); setRawLimit(limit); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  // Decrypt
  useEffect(() => {
    if (!key || !raw) return undefined;
    let alive = true;
    Promise.all(
      raw.map((m) =>
        decryptMessage(key, conv, m.mid, m).then(
          (body) => [m.mid, { body, sig: m.iv }],
          (e) => [m.mid, { error: e?.message || 'decrypt failed', sig: m.iv }],
        ),
      ),
    ).then((pairs) => {
      if (!alive) return;
      setBodies((prev) => {
        const next = {};
        for (const [mid, v] of pairs) next[mid] = prev[mid]?.sig === v.sig && prev[mid]?.body === v.body ? prev[mid] : v;
        return next;
      });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, raw]);

  // Members & roles (for mentions, permissions)
  useEffect(() => {
    if (conv.kind === 'dm') {
      setMembers({ [me.uid]: { role: 'member' }, [conv.peerUid]: { role: 'member' } });
      return undefined;
    }
    return onValue(
      ref(db, `servers/${conv.sid}/members`),
      (s) => setMembers(s.val() || {}),
      () => setMembers({}),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Typing
  useEffect(() => subscribeTyping(tPath, me.uid, setTypingUids), [tPath, me.uid]);
  useEffect(() => () => { setTyping(tPath, me.uid, false); }, [tPath, me.uid]);

  // Unread marker: remember where we left off, then mark read while visible.
  useEffect(() => {
    let alive = true;
    getLastRead(me.uid, scope).then((ts) => alive && setUnreadSince(ts)).catch(() => alive && setUnreadSince(0));
    return () => { alive = false; };
  }, [me.uid, scope]);

  const lastMid = raw?.length ? raw[raw.length - 1].mid : null;
  useEffect(() => {
    if (!lastMid) return undefined;
    const doMark = () => { if (document.visibilityState === 'visible') markRead(me.uid, scope); };
    doMark();
    document.addEventListener('visibilitychange', doMark);
    window.addEventListener('focus', doMark);
    return () => {
      document.removeEventListener('visibilitychange', doMark);
      window.removeEventListener('focus', doMark);
    };
  }, [lastMid, me.uid, scope]);

  // Profiles of members + authors
  const uids = useMemo(() => {
    const s = new Set(Object.keys(members));
    raw?.forEach((m) => m.uid && s.add(m.uid));
    s.add(me.uid);
    return [...s];
  }, [members, raw, me.uid]);
  const profiles = useProfiles(uids);

  const myRole = members[me.uid]?.role || 'member';
  const isAdmin = conv.kind === 'channel' && (myRole === 'owner' || myRole === 'admin');
  const canPinAny = conv.kind === 'dm' || isAdmin;

  const items = useMemo(
    () => (raw || []).map((m) => ({
      ...m,
      ...(bodies[m.mid] || { pending: !m.deleted }),
      ...(sendingMids.has(m.mid) ? { sending: true } : null),
    })),
    [raw, bodies, sendingMids],
  );
  const byMid = useMemo(() => Object.fromEntries(items.map((m) => [m.mid, m])), [items]);

  const memberNames = useMemo(
    () => Object.keys(members).map((u) => profiles[u]?.name).filter(Boolean),
    [members, profiles],
  );

  // ---------- Actions ----------

  const loadOlder = useCallback(() => {
    if (!hasMore) return;
    setLimit((l) => Math.min(l + PAGE_SIZE, MAX_LIMIT));
  }, [hasMore]);

  const jumpTo = useCallback((mid) => {
    if (byMid[mid]) {
      listRef.current?.jumpTo(mid);
    } else if (hasMore && limit < MAX_LIMIT) {
      setPendingJump(mid);
      setLimit((l) => Math.min(l + PAGE_SIZE * 4, MAX_LIMIT));
    } else {
      flash('That message is no longer available.');
    }
  }, [byMid, hasMore, limit, flash]);

  useEffect(() => {
    // Only decide once the data for the current limit has arrived; otherwise each render would
    // bump the limit again before the network answers.
    if (!pendingJump || !raw || rawLimit !== limit) return;
    if (byMid[pendingJump]) {
      const mid = pendingJump;
      setPendingJump(null);
      requestAnimationFrame(() => listRef.current?.jumpTo(mid));
    } else if (hasMore && limit < MAX_LIMIT) {
      setLimit((l) => Math.min(l + PAGE_SIZE * 4, MAX_LIMIT));
    } else {
      setPendingJump(null);
      flash('That message is too far back to load.');
    }
  }, [raw, rawLimit, byMid, pendingJump, hasMore, limit, flash]);

  // Resolves once the encrypted write is queued (not on server ack), so a slow or offline
  // connection never blocks the composer. Unacked messages are shown as "sending".
  const handleSend = useCallback(async (body) => {
    const reply = replyTo;
    setReplyTo(null);
    setTyping(tPath, me.uid, false);
    let res;
    try {
      res = await sendMessage(conv, me, body, { replyTo: reply || undefined });
    } catch (e) {
      setReplyTo(reply);
      flash(e?.message || 'Message failed to send');
      return false;
    }
    const { mid, done } = res;
    setSendingMids((s) => new Set(s).add(mid));
    const clear = () => setSendingMids((s) => {
      if (!s.has(mid)) return s;
      const n = new Set(s);
      n.delete(mid);
      return n;
    });
    done.then(clear, (e) => {
      clear();
      const preview = (body.text || body.code?.filename || '').slice(0, 40);
      flash(`Message failed to send${preview ? ` (“${preview}${(body.text || '').length > 40 ? '…' : ''}”)` : ''}: ${e?.message || 'rejected by the server'}`);
    });
    requestAnimationFrame(() => listRef.current?.scrollToBottom());
    return true;
  }, [conv, me, replyTo, tPath, flash]);

  const handleEditSave = useCallback(async (mid, body) => {
    try {
      await editMessage(conv, mid, body, me.uid);
      setEditingMid(null);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (e) {
      flash(e?.message || 'Could not save edit');
    }
  }, [conv, me.uid, flash]);

  const handleDelete = useCallback(async (mid) => {
    setConfirmDelete(null);
    try {
      await deleteMessage(conv, mid);
      if (replyTo === mid) setReplyTo(null);
    } catch (e) {
      flash(e?.message || 'Could not delete message');
    }
  }, [conv, replyTo, flash]);

  const handleReact = useCallback(async (mid, native, on) => {
    try {
      await setReaction(conv, mid, emojiKey(native), me.uid, on);
    } catch (e) {
      flash(e?.message || 'Could not react');
    }
  }, [conv, me.uid, flash]);

  const handlePin = useCallback(async (mid, pinned) => {
    try {
      await setPinned(conv, mid, pinned);
      flash(pinned ? 'Message pinned' : 'Message unpinned', 'ok');
    } catch (e) {
      flash(e?.message || 'Could not change pin');
    }
  }, [conv, flash]);

  const editLast = useCallback(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (m.uid === me.uid && !m.deleted && m.body) { setEditingMid(m.mid); setReplyTo(null); return true; }
    }
    return false;
  }, [items, me.uid]);

  const onReply = useCallback((mid) => { setReplyTo(mid); setEditingMid(null); composerRef.current?.focus(); }, []);
  const onEdit = useCallback((mid) => { setEditingMid(mid); setReplyTo(null); }, []);
  const onEditCancel = useCallback(() => { setEditingMid(null); composerRef.current?.focus(); }, []);
  const onDelete = useCallback((mid, skipConfirm) => (skipConfirm ? handleDelete(mid) : setConfirmDelete(mid)), [handleDelete]);
  const onOpenReactPicker = useCallback((mid, rect) => setReactPicker({ mid, rect }), []);
  const closeReactPicker = useCallback(() => setReactPicker(null), []);
  const onCopied = useCallback(() => flash('Copied to clipboard', 'ok'), [flash]);

  const onTyping = useCallback(() => setTyping(tPath, me.uid, true), [tPath, me.uid]);
  const onStopTyping = useCallback(() => setTyping(tPath, me.uid, false), [tPath, me.uid]);

  const replyItem = replyTo ? byMid[replyTo] : null;
  const typingNames = typingUids.map((u) => profiles[u]?.name || 'Someone');
  const peer = conv.kind === 'dm' ? profiles[conv.peerUid] : null;
  const loading = raw === null;
  const placeholder = conv.kind === 'dm' ? `Message @${conv.title || peer?.name || 'user'}` : `Message #${conv.title || 'channel'}`;

  return (
    <div className="chat-root">
      <header className="chat-header">
        <div className="chat-header-title">
          {conv.kind === 'dm' ? (
            <span className="chat-header-glyph at">@</span>
          ) : (
            <span className="chat-header-glyph">#</span>
          )}
          <span className="chat-title-text">{conv.title || peer?.name || 'Conversation'}</span>
          <button
            type="button"
            className="badge-e2e chat-e2e"
            onClick={() => conv.kind === 'dm' && setShowSafety(true)}
            title={conv.kind === 'dm'
              ? 'End-to-end encrypted. Click to verify the safety number.'
              : 'Messages are end-to-end encrypted with this server’s room key.'}
          >
            <LockIcon /> E2E{conv.kind === 'dm' ? ' · Verify' : ''}
          </button>
        </div>
        <div className="chat-header-actions">
          <button
            type="button"
            className={`chat-icon-btn${panel === 'pins' ? ' active' : ''}`}
            title="Pinned messages"
            onClick={() => setPanel((p) => (p === 'pins' ? null : 'pins'))}
          >
            <PinIcon />
          </button>
          <button
            type="button"
            className={`chat-icon-btn${panel === 'search' ? ' active' : ''}`}
            title="Search loaded messages"
            onClick={() => setPanel((p) => (p === 'search' ? null : 'search'))}
          >
            <SearchIcon />
          </button>
        </div>
      </header>

      <div className="chat-body">
        <div className="chat-main">
          {keyError ? (
            <div className="chat-blocking">
              <div className="chat-blocking-card">
                <LockIcon size={28} />
                <h3>Can&apos;t open this conversation</h3>
                <p className="muted">{keyError}</p>
                <p className="muted small">
                  {conv.kind === 'dm'
                    ? 'The other person may not have finished setting up their encryption keys yet.'
                    : 'Your copy of the server key is missing. Ask an admin for a fresh invite link.'}
                </p>
              </div>
            </div>
          ) : (
            <MessageList
              ref={listRef}
              items={items}
              loading={loading || (!key && !keyError)}
              error={listError}
              hasMore={hasMore}
              onLoadOlder={loadOlder}
              limitReached={limit >= MAX_LIMIT}
              me={me}
              profiles={profiles}
              conv={conv}
              byMid={byMid}
              unreadSince={unreadSince}
              memberNames={memberNames}
              editingMid={editingMid}
              isAdmin={isAdmin}
              canPinAny={canPinAny}
              onReply={onReply}
              onEdit={onEdit}
              onEditSave={handleEditSave}
              onEditCancel={onEditCancel}
              onDelete={onDelete}
              onReact={handleReact}
              onOpenReactPicker={onOpenReactPicker}
              onPin={handlePin}
              onJump={jumpTo}
              onCopied={onCopied}
            />
          )}

          {!keyError && (
            <div className="chat-composer-wrap">
              <Composer
                ref={composerRef}
                disabled={!key}
                placeholder={placeholder}
                onSend={handleSend}
                onTyping={onTyping}
                onStopTyping={onStopTyping}
                replyItem={replyItem}
                replyAuthor={replyItem ? profiles[replyItem.uid]?.name : null}
                onCancelReply={() => setReplyTo(null)}
                onEditLast={editLast}
                onOpenSnippet={() => setShowSnippet(true)}
                members={Object.keys(members).filter((u) => u !== me.uid).map((u) => profiles[u]).filter(Boolean)}
                allowEveryone={conv.kind === 'channel'}
              />
              <TypingIndicator names={typingNames} />
            </div>
          )}
        </div>

        {panel && (
          <SidePanel
            kind={panel}
            conv={conv}
            cryptoKey={key}
            keyError={keyError}
            items={items}
            profiles={profiles}
            me={me}
            hasMore={hasMore && limit < MAX_LIMIT}
            onLoadMore={loadOlder}
            onJump={jumpTo}
            onClose={() => setPanel(null)}
            canPinAny={canPinAny}
            onUnpin={(mid) => handlePin(mid, false)}
          />
        )}
      </div>

      {reactPicker && (
        <EmojiPopover
          anchorRect={reactPicker.rect}
          onClose={closeReactPicker}
          onSelect={(native) => {
            const m = byMid[reactPicker.mid];
            const k = emojiKey(native);
            const already = !!m?.reactions?.[k]?.[me.uid];
            if (!already) handleReact(reactPicker.mid, native, true);
            setReactPicker(null);
          }}
        />
      )}
      {showSnippet && (
        <SnippetModal
          onClose={() => setShowSnippet(false)}
          onSubmit={async (body) => {
            const ok = await handleSend(body);
            if (ok) setShowSnippet(false);
            return ok;
          }}
        />
      )}
      {showSafety && conv.kind === 'dm' && (
        <SafetyNumberModal peerUid={conv.peerUid} peerName={peer?.name || conv.title} onClose={() => setShowSafety(false)} />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Delete message"
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => handleDelete(confirmDelete)}
        >
          <p className="muted">This removes the encrypted message for everyone. This can&apos;t be undone.</p>
          <p className="muted small">Tip: hold Shift while clicking delete to skip this dialog.</p>
        </ConfirmModal>
      )}
      {toast && <div key={toast.id} className={`chat-toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

function TypingIndicator({ names }) {
  let text = '';
  if (names.length === 1) text = <><b>{names[0]}</b> is typing…</>;
  else if (names.length === 2) text = <><b>{names[0]}</b> and <b>{names[1]}</b> are typing…</>;
  else if (names.length === 3) text = <><b>{names[0]}</b>, <b>{names[1]}</b> and <b>{names[2]}</b> are typing…</>;
  else if (names.length > 3) text = 'Several people are typing…';
  return (
    <div className="chat-typing" aria-live="polite">
      {names.length > 0 && (
        <>
          <span className="typing-dots"><i /><i /><i /></span>
          <span>{text}</span>
        </>
      )}
    </div>
  );
}

export function LockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M9 10.76V6h6v4.76l2.5 3.74H6.5z" />
      <path d="M8 3h8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

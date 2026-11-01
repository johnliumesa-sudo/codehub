import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { initials } from '../../lib/profiles.js';
import { isEmojiOnly, mentionsName, renderMarkdown } from '../../lib/markdown.js';
import { QUICK_REACTIONS, emojiFromKey, emojiKey } from '../../lib/messages.js';
import { parseInviteLink } from '../../lib/servers.js';
import CodeSnippet from './CodeSnippet.jsx';

function fmtTime(ts) {
  if (typeof ts !== 'number') return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtFull(ts) {
  if (typeof ts !== 'number') return 'Sending…';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
}

export function Avatar({ profile, size = 40 }) {
  const name = profile?.name || '?';
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: profile?.color || '#4a5266', fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function previewText(m) {
  if (!m) return '';
  if (m.deleted) return 'Message deleted';
  if (m.error) return 'Unable to decrypt';
  if (!m.body) return '…';
  const t = (m.body.text || '').replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
  if (t) return t.length > 140 ? `${t.slice(0, 140)}…` : t;
  if (m.body.code) return `📄 ${m.body.code.filename || 'Code snippet'}`;
  return '';
}

// Server invite links in a message become a card. Joining reuses the app's invite flow: setting
// the hash hands the link to App.jsx, which stashes it for the workspace's join prompt.
function InviteCard({ invite, name, mine }) {
  const join = () => {
    location.hash = `/join/${invite.sid}/${invite.inviteId}/${invite.key}`;
  };
  return (
    <div className="msg-invite">
      <div className="msg-invite-icon">{(name || '?').trim().charAt(0).toUpperCase() || '#'}</div>
      <div className="msg-invite-text">
        <span className="msg-invite-label">{mine ? 'You sent a server invite' : "You've been invited to join a server"}</span>
        <strong>{name || 'Encrypted server'}</strong>
      </div>
      {!mine && <button type="button" className="btn primary sm" onClick={join}>Join</button>}
    </div>
  );
}

function Message(props) {
  const {
    m, grouped, author, me, profiles, reply, replyAuthor, knownNames, editing, highlighted,
    canDelete, canEdit, canPin, onReply, onEdit, onEditSave, onEditCancel, onDelete, onReact,
    onOpenReactPicker, onPin, onJump, onCopied,
  } = props;

  const text = m.body?.text || '';
  const html = useMemo(
    () => (text ? renderMarkdown(text, { selfName: me.name, knownNames }) : ''),
    [text, me.name, knownNames],
  );
  const jumbo = useMemo(() => isEmojiOnly(text) && !m.body?.code, [text, m.body]);
  const invite = useMemo(() => parseInviteLink(text), [text]);
  const mentioned = useMemo(() => m.uid !== me.uid && mentionsName(text, me.name), [text, me.name, m.uid, me.uid]);
  const isReplyToMe = reply && !reply.missing && reply.uid === me.uid && m.uid !== me.uid;

  const reactions = useMemo(() => {
    const r = m.reactions || {};
    return Object.entries(r)
      .map(([key, users]) => ({ key, native: emojiFromKey(key), uids: Object.keys(users || {}) }))
      .filter((x) => x.uids.length > 0);
  }, [m.reactions]);

  const usable = !m.deleted && !m.error && !m.pending;
  const cls = ['msg'];
  if (grouped) cls.push('grouped');
  if (mentioned || isReplyToMe) cls.push('mentioned');
  if (highlighted) cls.push('highlighted');
  if (editing) cls.push('editing');
  const isSending = m.sending || typeof m.ts !== 'number';
  if (isSending) cls.push('sending');
  const jumpToReply = () => !reply?.missing && onJump(m.replyTo);

  return (
    // Focusable so keyboard users (and taps on touch screens) can reach the action toolbar.
    <div className={cls.join(' ')} data-mid={m.mid} tabIndex={0}>
      {reply && (
        <div
          className="msg-reply-ref"
          onClick={jumpToReply}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jumpToReply(); }
          }}
          role="button"
          tabIndex={reply.missing ? -1 : 0}
          aria-label={reply.missing ? undefined : `Jump to replied message by ${replyAuthor?.name || 'Unknown'}`}
        >
          <span className="msg-reply-spine" />
          {reply.missing ? (
            <span className="muted">Original message isn&apos;t loaded</span>
          ) : (
            <>
              <Avatar profile={replyAuthor} size={16} />
              <span className="msg-reply-name" style={{ color: replyAuthor?.color }}>{replyAuthor?.name || 'Unknown'}</span>
              <span className="msg-reply-text">{previewText(reply)}</span>
            </>
          )}
        </div>
      )}
      <div className="msg-row">
        <div className="msg-gutter">
          {grouped ? (
            <span className="msg-hover-time" title={fmtFull(m.ts)}>{fmtTime(m.ts)}</span>
          ) : (
            <Avatar profile={author} />
          )}
        </div>
        <div className="msg-content">
          {!grouped && (
            <div className="msg-meta">
              <span className="msg-author" style={{ color: author?.color || 'var(--text)' }}>{author?.name || '…'}</span>
              <span className="msg-time" title={fmtFull(m.ts)}>{isSending ? 'sending…' : fmtTime(m.ts)}</span>
              {m.pinned && <span className="msg-pin-flag" title="Pinned">📌</span>}
            </div>
          )}

          {m.deleted ? (
            <div className="msg-deleted">Message deleted</div>
          ) : m.error ? (
            <div className="msg-undecryptable" title={m.error}>
              <span>🔒</span> Unable to decrypt this message. It may have been encrypted with a different key or tampered with.
            </div>
          ) : m.pending ? (
            <div className="msg-decrypting"><span className="sk-line" style={{ width: '45%' }} /></div>
          ) : editing ? (
            <EditBox initial={m.body} onSave={(body) => onEditSave(m.mid, body)} onCancel={onEditCancel} />
          ) : (
            <>
              {text && (
                <div
                  className={`msg-text md${jumbo ? ' jumbo' : ''}`}
                  // Sanitized by DOMPurify in renderMarkdown().
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              )}
              {m.body?.code && <CodeSnippet code={m.body.code} onCopied={onCopied} />}
              {invite && <InviteCard invite={invite} name={m.body?.invite?.name} mine={m.uid === me.uid} />}
              {m.editedAt && <span className="msg-edited" title={`Edited ${fmtFull(m.editedAt)}`}>(edited)</span>}
              {grouped && m.pinned && <span className="msg-pin-flag" title="Pinned">📌</span>}
            </>
          )}

          {reactions.length > 0 && !m.deleted && (
            <div className="msg-reactions">
              {reactions.map((r) => {
                const mine = r.uids.includes(me.uid);
                const who = r.uids.map((u) => (u === me.uid ? 'You' : profiles[u]?.name || 'Someone'));
                return (
                  <button
                    type="button"
                    key={r.key}
                    className={`reaction${mine ? ' mine' : ''}`}
                    title={`${who.slice(0, 8).join(', ')}${who.length > 8 ? ` and ${who.length - 8} more` : ''}`}
                    onClick={() => onReact(m.mid, r.native, !mine)}
                  >
                    <span className="reaction-emoji">{r.native}</span>
                    <span className="reaction-count">{r.uids.length}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="reaction add"
                title="Add reaction"
                onClick={(e) => onOpenReactPicker(m.mid, e.currentTarget.getBoundingClientRect())}
              >
                <SmileIcon size={15} />+
              </button>
            </div>
          )}
        </div>
      </div>

      {usable && !editing && (
        <div className="msg-toolbar" role="toolbar">
          {QUICK_REACTIONS.slice(0, 4).map((e) => {
            const mine = !!m.reactions?.[emojiKey(e)]?.[me.uid];
            return (
              <button type="button" key={e} className={`tb-btn emoji${mine ? ' on' : ''}`} title={`React ${e}`} onClick={() => onReact(m.mid, e, !mine)}>
                {e}
              </button>
            );
          })}
          <span className="tb-sep" />
          <button type="button" className="tb-btn" title="Add reaction" onClick={(e) => onOpenReactPicker(m.mid, e.currentTarget.getBoundingClientRect())}>
            <SmileIcon />
          </button>
          <button type="button" className="tb-btn" title="Reply" onClick={() => onReply(m.mid)}>
            <ReplyIcon />
          </button>
          {canEdit && (
            <button type="button" className="tb-btn" title="Edit" onClick={() => onEdit(m.mid)}>
              <EditIcon />
            </button>
          )}
          {canPin && (
            <button type="button" className={`tb-btn${m.pinned ? ' on' : ''}`} title={m.pinned ? 'Unpin' : 'Pin'} onClick={() => onPin(m.mid, !m.pinned)}>
              <PinSmall />
            </button>
          )}
          {canDelete && (
            <button type="button" className="tb-btn danger" title="Delete (Shift-click to skip confirm)" onClick={(e) => onDelete(m.mid, e.shiftKey)}>
              <TrashIcon />
            </button>
          )}
        </div>
      )}
      {m.error && canDelete && (
        <div className="msg-toolbar" role="toolbar">
          <button type="button" className="tb-btn danger" title="Delete" onClick={(e) => onDelete(m.mid, e.shiftKey)}>
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function EditBox({ initial, onSave, onCancel }) {
  const [text, setText] = useState(initial?.text || '');
  const [saving, setSaving] = useState(false);
  const ta = useRef(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [text]);

  const save = async () => {
    if (saving) return;
    if (!text.trim() && !initial?.code) return;
    if (text === (initial?.text || '')) { onCancel(); return; }
    setSaving(true);
    await onSave({ ...initial, text });
    setSaving(false);
  };

  return (
    <div className="msg-editbox">
      <textarea
        ref={ta}
        className="msg-edit-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
        }}
        rows={1}
      />
      <div className="msg-edit-hint">
        escape to <button type="button" className="linkish" onClick={onCancel}>cancel</button> · enter to{' '}
        <button type="button" className="linkish" onClick={save}>{saving ? 'saving…' : 'save'}</button>
        {initial?.code && <span> · attached code is kept</span>}
      </div>
    </div>
  );
}

// ---------- Icons ----------

function SmileIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}
function ReplyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v4" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
function PinSmall() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" /><path d="M9 10.76V6h6v4.76l2.5 3.74H6.5z" /><path d="M8 3h8" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" />
    </svg>
  );
}

export default memo(Message);

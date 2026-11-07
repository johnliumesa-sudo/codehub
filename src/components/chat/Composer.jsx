import PollComposer from '../chatx/PollComposer.jsx';
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { mentionToken, searchEmoji } from '../../lib/markdown.js';
import { MAX_TEXT } from '../../lib/messages.js';
import EmojiPopover from './EmojiPopover.jsx';
import { Avatar, previewText } from './Message.jsx';
import SnippetsButton from '../productivity/SnippetsButton.jsx';
import { fenced } from '../../lib/snippets.js';
import { AttachmentButton, AttachmentTray, useAttachmentDraft, usePasteFiles } from '../media/Attachments.jsx';
import { GifPicker, useGifEnabled } from '../media/GifPicker.jsx';
import { uploadAttachments } from '../../lib/media/attachments.js';
import { useRegistry } from '../../lib/ext/registry.js';
import { MentionStatus } from '../../features/personal/components/StatusBits.jsx';
import { SLASH_GROUPS, commandGroup, commandsFor, matchCommands, parseSlash } from '../../lib/ext/send.js';
import { ComposerExtButtons } from '../ext/ChatExt.jsx';

const TYPING_THROTTLE = 3000;
const STACK_BELOW = 520; // px of composer width

// Find an autocomplete trigger ("/cmd" at the very start, ":sho" or "@na") right before the caret.
function findTrigger(value, caret, slash) {
  const before = value.slice(0, caret);
  if (slash) {
    const s = /^\/([A-Za-z0-9_-]{0,32})$/.exec(before);
    if (s) return { kind: 'slash', query: s[1].toLowerCase(), start: 0 };
  }
  let m = /(^|[\s(]):([a-z0-9_+-]{2,30})$/i.exec(before);
  if (m) return { kind: 'emoji', query: m[2].toLowerCase(), start: caret - m[2].length - 1 };
  m = /(^|[\s(])@([\p{L}\p{N}_.-]{0,30})$/u.exec(before);
  if (m) return { kind: 'mention', query: m[2].toLowerCase(), start: caret - m[2].length - 1 };
  return null;
}

const Composer = forwardRef(function Composer(props, ref) {
  const {
    disabled, placeholder, onSend, onTyping, onStopTyping, replyItem, replyAuthor, onCancelReply,
    onEditLast, onOpenSnippet, members, allowEveryone, me, onLongSnippet, conv, emotes,
  } = props;
  const draft = useAttachmentDraft();
  const onPasteFiles = usePasteFiles(draft.add);
  const gifOn = useGifEnabled();
  const [gifOpen, setGifOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [upErr, setUpErr] = useState('');

  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [trigger, setTrigger] = useState(null);
  const [sel, setSel] = useState(0);
  const [pickerRect, setPickerRect] = useState(null);
  const ta = useRef(null);
  const lastTypingRef = useRef(0);
  const pickerClosedAt = useRef(0);
  const listId = useId();
  const slashCmds = useRegistry('slashCommands');

  // Insert text at the caret on its own line (snippet library), then refocus.
  const insertBlock = useCallback((text) => {
    const el = ta.current;
    const s0 = el ? el.selectionStart : null;
    const e0 = el ? el.selectionEnd : null;
    let caret = 0;
    setValue((v) => {
      const s = Math.min(s0 ?? v.length, v.length);
      const e = Math.min(e0 ?? v.length, v.length);
      const pre = v.slice(0, s);
      const lead = pre && !pre.endsWith('\n') ? '\n' : '';
      const ins = `${lead}${text}\n`;
      caret = s + ins.length;
      return `${pre}${ins}${v.slice(e)}`;
    });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }, []);
  // Insert text at the caret inline (ChatContext.insertText), then refocus.
  const insertInline = useCallback((text) => {
    const el = ta.current;
    const s0 = el ? el.selectionStart : null;
    const e0 = el ? el.selectionEnd : null;
    let caret = 0;
    setValue((v) => {
      const s = Math.min(s0 ?? v.length, v.length);
      const e = Math.min(e0 ?? v.length, v.length);
      caret = s + text.length;
      return `${v.slice(0, s)}${text}${v.slice(e)}`;
    });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }, []);
  // addFiles: images dropped anywhere on the chat pane (ChatView's DropZone) join the draft.
  const addFiles = draft.add;
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), insert: insertBlock, insertText: insertInline, addFiles: conv ? addFiles : () => {} }), [insertBlock, insertInline, addFiles, conv]);

  // A narrow composer (phone, or a side panel open beside the chat) puts the text box on its own row:
  // with every feature's buttons in one row it was squeezed to a few characters.
  const boxRef = useRef(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setStacked(e.contentRect.width < STACK_BELOW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Autosize
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [value]);

  // Keyed on the id: replyItem is rebuilt on every message-list update and must not steal focus.
  const replyMid = replyItem?.mid;
  useEffect(() => { if (replyMid) ta.current?.focus(); }, [replyMid]);

  const suggestions = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === 'slash') {
      // Every matching command (the list scrolls), grouped: built-in, features, this server's bots.
      return matchCommands(trigger.query, conv?.kind || 'channel', slashCmds).map((c) => ({
        id: `slash:${c.name}`,
        slash: true,
        group: commandGroup(c),
        name: c.name,
        label: `/${c.name}`,
        args: typeof c.args === 'string' ? c.args : '',
        hint: typeof c.description === 'string' ? c.description : '',
        insert: `/${c.name}`,
      }));
    }
    if (trigger.kind === 'emoji') {
      // Server emotes first (inserted as :name:, rendered as images), then standard emoji.
      const custom = (emotes || [])
        .filter((e) => e.name.startsWith(trigger.query))
        .slice(0, 4)
        .map((e) => ({ id: `emote:${e.name}`, label: `:${e.name}:`, img: e.src, hint: 'Server emote', insert: `:${e.name}:` }));
      return [...custom, ...searchEmoji(trigger.query, 8 - custom.length).map((e) => ({ id: e.id, label: `:${e.id}:`, icon: e.native, insert: e.native }))];
    }
    const q = trigger.query;
    const list = [];
    if (allowEveryone && 'everyone'.startsWith(q)) list.push({ id: '@everyone', label: '@everyone', hint: 'Notify everyone in this channel', insert: '@everyone' });
    for (const p of members || []) {
      const tok = mentionToken(p.name || '');
      if (!tok) continue;
      if (!q || tok.toLowerCase().startsWith(q) || (p.name || '').toLowerCase().includes(q)) {
        list.push({ id: p.uid, label: p.name, hint: `@${tok}`, profile: p, insert: `@${tok}` });
      }
      if (list.length >= 8) break;
    }
    return list;
  }, [trigger, members, allowEveryone, emotes, conv?.kind, slashCmds]);

  // A fully typed command name starts selected (Enter runs it), else the first entry.
  useEffect(() => {
    const exact = trigger?.kind === 'slash' ? suggestions.findIndex((s) => s.name === trigger.query) : -1;
    setSel(exact > 0 ? exact : 0);
  }, [trigger?.kind, trigger?.query]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the active row visible while arrowing through a long (scrolling) list.
  const suggestOpen = !!trigger && suggestions.length > 0;
  useEffect(() => {
    if (suggestOpen) document.getElementById(`${listId}-${sel}`)?.scrollIntoView({ block: 'nearest' });
  }, [suggestOpen, sel, listId]);

  const updateTrigger = (val, caret) => setTrigger(findTrigger(val, caret, !!conv));

  // "/name …" with a known command: show its usage instead of the keyboard hint.
  const usage = useMemo(() => {
    if (!conv || !/^\/\S+\s/.test(value)) return null;
    const p = parseSlash(value);
    return p ? commandsFor(conv.kind, slashCmds).find((c) => c.name === p.name) || null : null;
  }, [value, conv, slashCmds]);

  const applySuggestion = useCallback((s) => {
    if (!trigger || !s) return;
    const el = ta.current;
    const caret = el?.selectionStart ?? value.length;
    // A command replaces the whole first word; emoji and mentions insert at the caret.
    const rest = trigger.kind === 'slash' ? value.slice(caret).replace(/^\S*\s*/, '') : value.slice(caret);
    const next = `${value.slice(0, trigger.start)}${s.insert} ${rest}`;
    const pos = trigger.start + s.insert.length + 1;
    setValue(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }, [trigger, value]);

  const insertAtCaret = useCallback((text) => {
    const el = ta.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + text.length;
      el?.setSelectionRange(pos, pos);
    });
  }, [value]);

  const submit = async () => {
    const text = value.trim();
    const files = conv ? draft.files : [];
    if ((!text && !files.length) || sending || disabled) return;
    if (text.length > MAX_TEXT) return;
    setSending(true);
    let attachments;
    if (files.length) {
      try {
        setUpErr('');
        attachments = await uploadAttachments(conv, files, { onProgress: (p) => draft.setProgress?.(Object.fromEntries(files.map((_, i) => [i, p]))) });
      } catch (e) {
        setUpErr(e?.message || 'Upload failed');
        setSending(false);
        return;
      }
    }
    const prev = value;
    setValue('');
    setTrigger(null);
    lastTypingRef.current = 0;
    const ok = await onSend(attachments ? { text, attachments } : { text });
    if (ok !== false && attachments) draft.clear();
    setSending(false);
    if (!ok) setValue(prev);
    requestAnimationFrame(() => ta.current?.focus());
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (trigger && suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const s = suggestions[sel];
        // Enter on a fully typed command sends it; Tab (or Enter on a partial name) completes.
        if (e.key === 'Enter' && trigger.kind === 'slash' && s?.name === trigger.query) {
          setTrigger(null);
          submit();
          return;
        }
        applySuggestion(s);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setTrigger(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && replyItem) { e.preventDefault(); onCancelReply(); return; }
    if (e.key === 'ArrowUp' && !value) {
      if (onEditLast()) e.preventDefault();
    }
  };

  const onChange = (e) => {
    const v = e.target.value;
    setValue(v);
    updateTrigger(v, e.target.selectionStart);
    if (!v) {
      lastTypingRef.current = 0;
      onStopTyping();
      return;
    }
    const now = Date.now();
    if (now - lastTypingRef.current > TYPING_THROTTLE) {
      lastTypingRef.current = now;
      onTyping();
    }
  };

  const openPicker = (e) => {
    if (Date.now() - pickerClosedAt.current < 250) return;
    setPickerRect(pickerRect ? null : e.currentTarget.getBoundingClientRect());
  };

  const over = value.trim().length > MAX_TEXT;

  const renderSuggestion = (s, i) => (
    <button
      type="button"
      key={s.id}
      id={`${listId}-${i}`}
      tabIndex={-1}
      role="option"
      aria-selected={i === sel}
      className={`suggest-item${i === sel ? ' active' : ''}`}
      onMouseEnter={() => setSel(i)}
      onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
    >
      {s.slash ? <span className="suggest-slash" aria-hidden="true">/</span> : s.img ? <img className="suggest-emoji md-emote" src={s.img} alt="" width={22} height={22} /> : s.icon ? <span className="suggest-emoji">{s.icon}</span> : s.profile ? <Avatar profile={s.profile} size={22} /> : <span className="suggest-at">@</span>}
      <span className="suggest-label">{s.label}</span>
      {s.profile && <MentionStatus uid={s.id} />}
      {s.slash && s.args && <span className="suggest-args">{s.args}</span>}
      {s.hint && <span className={`suggest-hint${s.slash ? ' slash' : ''}`}>{s.hint}</span>}
    </button>
  );

  return (
    <div className={`composer${disabled ? ' disabled' : ''}`}>
      {conv && <AttachmentTray files={draft.files} progress={draft.progress} onRemove={draft.remove} notice={upErr || draft.notice} busy={sending} />}
      {conv && gifOpen && (
        <GifPicker
          onClose={() => setGifOpen(false)}
          onPick={async (g) => {
            setGifOpen(false);
            if (g?.url) await onSend({ text: '', gif: g });
          }}
        />
      )}
      {conv && pollOpen && (
        <PollComposer
          onClose={() => setPollOpen(false)}
          onCreate={async (poll) => {
            setPollOpen(false);
            await onSend({ text: '', poll });
          }}
        />
      )}
      {trigger && suggestions.length > 0 && (
        <div
          className="composer-suggest"
          role="listbox"
          id={listId}
          aria-label={trigger.kind === 'slash' ? 'Commands' : trigger.kind === 'emoji' ? 'Emoji' : 'Members'}
        >
          <div className="composer-suggest-title">{trigger.kind === 'slash' ? 'Commands' : trigger.kind === 'emoji' ? `Emoji matching :${trigger.query}` : 'Members'}</div>
          {trigger.kind === 'slash'
            ? SLASH_GROUPS.map((g) => {
              const rows = suggestions.map((s, i) => [s, i]).filter(([s]) => s.group === g.id);
              if (!rows.length) return null;
              return (
                <div key={g.id} role="group" aria-labelledby={`${listId}-g-${g.id}`} className="composer-suggest-group">
                  <div id={`${listId}-g-${g.id}`} className="composer-suggest-group-title" role="presentation">{g.label}</div>
                  {rows.map(([s, i]) => renderSuggestion(s, i))}
                </div>
              );
            })
            : suggestions.map((s, i) => renderSuggestion(s, i))}
        </div>
      )}

      {replyItem && (
        <div className="composer-reply">
          <span>
            Replying to <b style={{ color: 'var(--text)' }}>{replyAuthor || 'message'}</b>
            <span className="composer-reply-text"> — {previewText(replyItem)}</span>
          </span>
          <button type="button" className="composer-reply-x" onClick={onCancelReply} title="Cancel reply (Esc)">✕</button>
        </div>
      )}

      <div ref={boxRef} className={`composer-box${replyItem ? ' has-reply' : ''}${stacked ? ' stacked' : ''}`}>
        <button type="button" className="composer-btn" title="Share code snippet" onClick={onOpenSnippet} disabled={disabled}>
          <CodeIcon />
        </button>
        {me && (
          <SnippetsButton
            me={me}
            iconOnly
            className="composer-btn"
            disabled={disabled}
            onInsert={(code, lang) => {
              const block = fenced(code, lang);
              if (block.length <= MAX_TEXT - 200) insertBlock(block);
              else onLongSnippet?.(code, lang); // too long for a message body: share as a code attachment
            }}
          />
        )}
        {conv && <AttachmentButton onFiles={draft.add} />}
        {conv && (
          <button type="button" className="composer-btn" onClick={() => setPollOpen(true)} disabled={disabled} aria-label="Create a poll" title="Poll">📊</button>
        )}
        {conv && gifOn && (
          <button type="button" className="composer-btn" onClick={() => setGifOpen((o) => !o)} aria-label="Send a GIF" title="GIF">GIF</button>
        )}
        {conv && <ComposerExtButtons disabled={disabled} />}
        <textarea
          onPaste={conv ? onPasteFiles : undefined}
          ref={ta}
          className="composer-input"
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? 'Unlocking encryption key…' : placeholder}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onClick={(e) => updateTrigger(value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setTrigger(null), 120)}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={trigger && suggestions.length > 0 ? listId : undefined}
          aria-activedescendant={trigger && suggestions.length > 0 ? `${listId}-${sel}` : undefined}
          spellCheck
        />
        {over && <span className="composer-count over">{value.trim().length}/{MAX_TEXT}</span>}
        {!over && value.length > MAX_TEXT - 500 && <span className="composer-count">{value.trim().length}/{MAX_TEXT}</span>}
        <button type="button" className={`composer-btn${pickerRect ? ' active' : ''}`} title="Emoji" onClick={openPicker} disabled={disabled}>
          <EmojiIcon />
        </button>
        <button
          type="button"
          className="composer-send"
          title="Send (Enter)"
          onClick={submit}
          disabled={disabled || sending || (!value.trim() && !(conv && draft.files.length)) || over}
        >
          <SendIcon />
        </button>
      </div>
      {usage ? (
        <div className="composer-usage" aria-live="polite">
          <code>/{usage.name}{typeof usage.args === 'string' && usage.args ? ` ${usage.args}` : ''}</code>
          {usage.description ? ` — ${usage.description}` : ''}
        </div>
      ) : (
        <div className="composer-hint">
          <span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>↑</kbd> edit last · <kbd>/</kbd> commands · Markdown & <code>```code```</code> supported</span>
        </div>
      )}

      {pickerRect && (
        <EmojiPopover
          anchorRect={pickerRect}
          onClose={() => { pickerClosedAt.current = Date.now(); setPickerRect(null); }}
          onSelect={(value) => insertAtCaret(value)}
          emotes={emotes}
          keepOpen
        />
      )}
    </div>
  );
});

function CodeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 7-5 5 5 5" /><path d="m16 7 5 5-5 5" /><path d="m13.5 4-3 16" />
    </svg>
  );
}
function EmojiIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
    </svg>
  );
}

export default Composer;

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { mentionToken, searchEmoji } from '../../lib/markdown.js';
import { MAX_TEXT } from '../../lib/messages.js';
import EmojiPopover from './EmojiPopover.jsx';
import { Avatar, previewText } from './Message.jsx';
import SnippetsButton from '../productivity/SnippetsButton.jsx';
import { fenced } from '../../lib/snippets.js';
import { AttachmentButton, AttachmentTray, useAttachmentDraft, usePasteFiles } from '../media/Attachments.jsx';
import { GifPicker, useGifEnabled } from '../media/GifPicker.jsx';
import { uploadAttachments } from '../../lib/media/attachments.js';

const TYPING_THROTTLE = 3000;

// Find an autocomplete trigger (":sho" or "@na") right before the caret.
function findTrigger(value, caret) {
  const before = value.slice(0, caret);
  let m = /(^|[\s(]):([a-z0-9_+-]{2,30})$/i.exec(before);
  if (m) return { kind: 'emoji', query: m[2].toLowerCase(), start: caret - m[2].length - 1 };
  m = /(^|[\s(])@([\p{L}\p{N}_.-]{0,30})$/u.exec(before);
  if (m) return { kind: 'mention', query: m[2].toLowerCase(), start: caret - m[2].length - 1 };
  return null;
}

const Composer = forwardRef(function Composer(props, ref) {
  const {
    disabled, placeholder, onSend, onTyping, onStopTyping, replyItem, replyAuthor, onCancelReply,
    onEditLast, onOpenSnippet, members, allowEveryone, me, onLongSnippet, conv,
  } = props;
  const draft = useAttachmentDraft();
  const onPasteFiles = usePasteFiles(draft.add);
  const gifOn = useGifEnabled();
  const [gifOpen, setGifOpen] = useState(false);
  const [upErr, setUpErr] = useState('');

  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [trigger, setTrigger] = useState(null);
  const [sel, setSel] = useState(0);
  const [pickerRect, setPickerRect] = useState(null);
  const ta = useRef(null);
  const lastTypingRef = useRef(0);
  const pickerClosedAt = useRef(0);

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
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), insert: insertBlock }), [insertBlock]);

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
    if (trigger.kind === 'emoji') {
      return searchEmoji(trigger.query, 8).map((e) => ({ id: e.id, label: `:${e.id}:`, icon: e.native, insert: e.native }));
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
  }, [trigger, members, allowEveryone]);

  useEffect(() => { setSel(0); }, [trigger?.kind, trigger?.query]);

  const updateTrigger = (val, caret) => setTrigger(findTrigger(val, caret));

  const applySuggestion = useCallback((s) => {
    if (!trigger || !s) return;
    const el = ta.current;
    const caret = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, trigger.start)}${s.insert} ${value.slice(caret)}`;
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
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySuggestion(suggestions[sel]); return; }
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
      {trigger && suggestions.length > 0 && (
        <div className="composer-suggest" role="listbox">
          <div className="composer-suggest-title">{trigger.kind === 'emoji' ? `Emoji matching :${trigger.query}` : 'Members'}</div>
          {suggestions.map((s, i) => (
            <button
              type="button"
              key={s.id}
              role="option"
              aria-selected={i === sel}
              className={`suggest-item${i === sel ? ' active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
            >
              {s.icon ? <span className="suggest-emoji">{s.icon}</span> : s.profile ? <Avatar profile={s.profile} size={22} /> : <span className="suggest-at">@</span>}
              <span className="suggest-label">{s.label}</span>
              {s.hint && <span className="suggest-hint">{s.hint}</span>}
            </button>
          ))}
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

      <div className={`composer-box${replyItem ? ' has-reply' : ''}`}>
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
        {conv && gifOn && (
          <button type="button" className="composer-btn" onClick={() => setGifOpen((o) => !o)} aria-label="Send a GIF" title="GIF">GIF</button>
        )}
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
          disabled={disabled || sending || !value.trim() || over}
        >
          <SendIcon />
        </button>
      </div>
      <div className="composer-hint">
        <span><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>↑</kbd> edit last · Markdown & <code>```code```</code> supported</span>
      </div>

      {pickerRect && (
        <EmojiPopover
          anchorRect={pickerRect}
          onClose={() => { pickerClosedAt.current = Date.now(); setPickerRect(null); }}
          onSelect={(native) => insertAtCaret(native)}
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

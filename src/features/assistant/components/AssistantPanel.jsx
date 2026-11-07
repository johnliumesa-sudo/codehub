// The assistant chat panel (chatPanels 'assistant'): a private conversation with Claude kept in memory
// for this page session. Replies stream in and render through the app's Markdown renderer. Nothing
// from the chat is included unless the user turns on "Include last N messages" or runs Catch me up,
// Explain code, Summarize thread or /ask.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CATCHUP_SCOPES, CONTEXT_COUNTS, modelLabel } from '../lib/config.js';
import { shareText } from '../lib/prompts.js';
import { keyState, setSession } from '../lib/session.js';
import {
  ask, catchUp, clearConversation, retryTurn, setPrefs, stopTurn,
} from '../lib/actions.js';
import { KeyGate, Markdown, copyToClipboard, fmtNum, useAssistant } from './common.jsx';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import '../assistant.css';

export default function AssistantPanel({ ctx }) {
  const s = useAssistant(ctx.me?.uid);
  if (!s) return <div className="asst-panel"><p className="muted">Loading…</p></div>;
  return <PanelBody ctx={ctx} s={s} />;
}

function PanelBody({ ctx, s }) {
  const ws = useWorkspaceCtx();
  const [input, setInput] = useState('');
  const [scope, setScope] = useState('unread');
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);
  const stick = useRef(true);
  const streaming = s.turns.find((t) => t.status === 'streaming');
  const ready = keyState(s) === 'ready';

  // Keep the newest text in view while it streams, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.turns]);
  const onScroll = () => {
    const el = logRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const run = async (fn) => {
    setBusy(true);
    try {
      stick.current = true;
      await fn();
    } catch (e) {
      ctx.toast(e?.message || 'That didn’t work');
    } finally {
      setBusy(false);
    }
  };

  const send = (e) => {
    e?.preventDefault();
    const q = input.trim();
    if (!q || streaming || !ready) return;
    setInput('');
    run(() => ask(q, ctx));
  };

  return (
    <div className="asst-panel">
      <KeyGate session={s} />

      <div className="asst-toolbar">
        <label className="asst-sr" htmlFor="asst-catchup-scope">Messages to catch up on</label>
        <select id="asst-catchup-scope" className="input asst-select" value={scope} onChange={(e) => setScope(e.target.value)} disabled={!!streaming}>
          {CATCHUP_SCOPES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <button type="button" className="btn sm" disabled={!!streaming || busy || !ready} onClick={() => run(() => catchUp(ctx, scope))}>
          Catch me up
        </button>
        <button type="button" className="btn ghost sm asst-push" onClick={clearConversation} disabled={!s.turns.length} title="Start a new conversation">
          New chat
        </button>
      </div>

      <div
        ref={logRef}
        className="asst-log"
        role="log"
        aria-label="Conversation with Claude"
        aria-busy={!!streaming}
        onScroll={onScroll}
        tabIndex={0}
      >
        {s.turns.length === 0 && (
          <div className="asst-empty">
            <p><strong>Ask Claude anything.</strong> This conversation is private to you and disappears when you reload.</p>
            <p className="muted">Try “Catch me up”, the ✨ button next to the message box, the message menu (Explain code, Translate, Summarize thread) or <code>/ask</code> in the composer.</p>
          </div>
        )}
        {s.turns.map((t) => (t.role === 'user'
          ? <UserTurn key={t.id} t={t} />
          : <ReplyTurn key={t.id} t={t} user={s.turns.find((u) => u.id === t.userId)} ctx={ctx} ws={ws} />))}
      </div>

      <form className="asst-input" onSubmit={send}>
        <label className="asst-sr" htmlFor="asst-question">Ask Claude</label>
        <textarea
          id="asst-question"
          className="input"
          rows={2}
          value={input}
          placeholder={ready ? 'Ask Claude…' : 'Add or unlock your API key to start'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
          }}
        />
        {streaming ? (
          <button type="button" className="btn danger sm" onClick={() => stopTurn(streaming.id)}>Stop</button>
        ) : (
          <button type="submit" className="btn primary sm" disabled={!input.trim() || busy || !ready}>Send</button>
        )}
      </form>

      <div className="asst-context">
        <label className="asst-check">
          <input
            type="checkbox"
            checked={s.includeContext}
            onChange={(e) => setSession({ includeContext: e.target.checked })}
          />
          <span>Include last</span>
        </label>
        <select
          className="input asst-select tiny"
          aria-label="How many recent messages to include"
          value={s.prefs.ctxCount}
          onChange={(e) => setPrefs({ ctxCount: Number(e.target.value) })}
        >
          {CONTEXT_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span>chat messages</span>
      </div>

      <p className="asst-foot">
        Only what you send here goes to Anthropic, under your key · {modelLabel(s.prefs.model)}, {s.prefs.effort} effort · {fmtNum(s.usage.input + s.usage.output)} tokens this session
      </p>
    </div>
  );
}

function UserTurn({ t }) {
  return (
    <div className="asst-turn user">
      <div className="asst-who">You{t.conv?.short ? <span className="muted"> · {t.conv.short}</span> : null}</div>
      <div className="asst-user-text">{t.display}</div>
    </div>
  );
}

function ReplyTurn({ t, user, ctx, ws }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);
  const hasText = !!t.text.trim();
  const finished = t.status !== 'streaming';
  // An answer can only be shared into the conversation it was asked in: it may quote that
  // conversation's messages, which must not leak into another one (the panel follows the open chat).
  const askedIn = user?.conv || null;
  const here = !!askedIn?.scope && askedIn.scope === ctx.conv?.scope;
  const shareable = t.kind === 'ask' && t.status === 'done' && hasText;
  const canShare = shareable && here && ctx.canSend;
  const share = async () => {
    if (!canShare) return;
    const ok = await ctx.send({ text: shareText({ question: user?.question || '', answer: t.text }), extra: { assistant: { v: 1, model: String(t.model || '').slice(0, 64) } } });
    if (ok) ctx.toast('Shared to the conversation', 'ok');
  };
  return (
    <div className={`asst-turn bot ${t.status}`}>
      <div className="asst-who">
        Claude
        {t.fellBack && t.model ? <span className="muted"> · answered by {modelLabel(t.model)}</span> : null}
      </div>
      {hasText ? <Markdown text={t.text} /> : t.status === 'streaming' ? <p className="asst-thinking" aria-label="Claude is writing">Thinking…</p> : null}
      {t.status === 'streaming' && hasText && <span className="asst-caret" aria-hidden="true" />}
      {t.status === 'stopped' && <p className="asst-note">Stopped.</p>}
      {t.note && <p className={`asst-note${t.status === 'refusal' ? ' warn' : ''}`} role={t.status === 'refusal' ? 'alert' : undefined}>{t.note}</p>}
      {t.status === 'error' && t.error && (
        <div className="asst-error" role="alert">
          <strong>{t.error.title}</strong> {t.error.message}
        </div>
      )}
      {finished && (
        <div className="asst-actions">
          {hasText && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={async () => setCopied(await copyToClipboard(t.text))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {hasText && (
            <button type="button" className="btn ghost sm" onClick={() => ctx.insertText(t.text)} disabled={!ctx.canSend}>
              Insert into composer
            </button>
          )}
          {canShare && (
            <button type="button" className="btn ghost sm" onClick={share}>
              Share to {ctx.conv?.kind === 'channel' ? `#${ctx.conv.name || 'channel'}` : 'chat'}
            </button>
          )}
          {shareable && !here && (
            <span className="asst-share-note">
              {askedIn?.short ? `Asked in ${askedIn.short}: open it to share this answer there.` : 'Open the conversation it was asked in to share it.'}
            </span>
          )}
          {(t.status === 'error' || t.status === 'refusal' || t.status === 'stopped') && (
            <button type="button" className="btn ghost sm" onClick={() => retryTurn(t.id)}>Retry</button>
          )}
          {t.status === 'error' && (t.error?.kind === 'auth' || t.error?.kind === 'nokey' || t.error?.kind === 'notFound') && ws?.openSettings && (
            <button type="button" className="btn ghost sm" onClick={() => ws.openSettings('assistant')}>Assistant settings</button>
          )}
        </div>
      )}
    </div>
  );
}

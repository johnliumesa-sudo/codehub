// Composer slot (composerButtons): the ✨ writing-help button and its preview dialog, plus the chat
// bridge that lets workspace-level entry points (palette, sidebar toggle, hotkey) reach the open
// conversation and keeps the assistant panel open while you move between conversations.
import { useEffect, useRef, useState } from 'react';
import { ExtMenu } from '../../../components/ext/ExtRender.jsx';
import { WRITING_MODES, buildTranscript, buildWritingHelp, isReadable, writingMode } from '../lib/prompts.js';
import { describeError, stopInfo } from '../lib/errors.js';
import { streamReply } from '../lib/client.js';
import { addUsage, clearBridge, currentKey, getSession, keyState, setBridge, setSession } from '../lib/session.js';
import { PANEL_ID, captureReadMarker, setPrefs } from '../lib/actions.js';
import { KeyGate, PortalModal, useAssistant } from './common.jsx';
import '../assistant.css';

let bridgeSeq = 0;

/** Publish this conversation's ChatContext and sync the workspace-level panel toggle with it. */
function useChatBridge(ctx) {
  const token = useRef(null);
  if (!token.current) token.current = `b${++bridgeSeq}`;
  const prevPanel = useRef(undefined);
  const scope = ctx.conv?.scope;
  const uid = ctx.me?.uid;

  // Declared first: later effects (and session listeners) must see this render's ctx.
  useEffect(() => {
    setBridge(ctx, token.current);
  });
  useEffect(() => () => clearBridge(token.current), []);

  // The read marker as it was when the conversation opened (ChatView moves it once messages load).
  useEffect(() => {
    captureReadMarker(uid, scope);
  }, [uid, scope]);

  // The panel follows you: open it here if it was open in the last conversation.
  useEffect(() => {
    if (getSession().panelOpen && ctx.panel !== PANEL_ID) ctx.openPanel(PANEL_ID);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Header button / Esc / another panel -> the workspace toggle.
  useEffect(() => {
    const prev = prevPanel.current;
    prevPanel.current = ctx.panel;
    if (ctx.panel === PANEL_ID && !getSession().panelOpen) setSession({ panelOpen: true });
    else if (prev === PANEL_ID && ctx.panel !== PANEL_ID && getSession().panelOpen) setSession({ panelOpen: false });
  }, [ctx.panel]); // eslint-disable-line react-hooks/exhaustive-deps
}

function composerTextarea(el) {
  return el?.closest('.composer')?.querySelector('textarea') || null;
}

export default function ComposerTools({ ctx }) {
  useChatBridge(ctx);
  const [menu, setMenu] = useState(false);
  const [job, setJob] = useState(null); // { mode, draft, key }
  const btn = useRef(null);

  const start = (mode) => {
    const w = writingMode(mode);
    const draft = composerTextarea(btn.current)?.value || '';
    if (w.needsDraft && !draft.trim()) {
      ctx.toast('Write something in the message box first.');
      return;
    }
    setJob({ mode, draft, key: Date.now() });
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`composer-btn ext-composer-btn asst-compose-btn${menu ? ' active' : ''}`}
        title="Writing help (Claude)"
        aria-label="Writing help"
        aria-haspopup="menu"
        aria-expanded={menu}
        disabled={!ctx.canSend}
        onClick={() => setMenu((o) => !o)}
      >
        <span aria-hidden="true">✨</span>
      </button>
      {menu && (
        <ExtMenu
          anchor={btn.current}
          label="Writing help"
          items={WRITING_MODES.map((w) => ({ id: w.id, label: w.label, run: () => start(w.id) }))}
          onClose={(refocus) => {
            setMenu(false);
            // A chosen mode opens the dialog, which takes focus; otherwise focus returns to the button.
            if (refocus) requestAnimationFrame(() => { if (!document.querySelector('.asst-write')) btn.current?.focus(); });
          }}
        />
      )}
      {job && (
        <WritingDialog
          key={job.key}
          ctx={ctx}
          mode={job.mode}
          draft={job.draft}
          anchor={btn.current}
          onClose={(accepted) => {
            setJob(null);
            if (!accepted) requestAnimationFrame(() => btn.current?.focus());
          }}
        />
      )}
    </>
  );
}

function WritingDialog(props) {
  const s = useAssistant(props.ctx.me?.uid);
  return s ? <WritingDialogBody {...props} s={s} /> : null;
}

function WritingDialogBody({ ctx, s, mode, draft, anchor, onClose }) {
  const w = writingMode(mode);
  const [useCtx, setUseCtx] = useState(!!s.prefs.draftContext);
  const [status, setStatus] = useState('idle'); // idle | streaming | done | error
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const ctrl = useRef(null);
  const ready = keyState(s) === 'ready';

  useEffect(() => () => ctrl.current?.abort(), []);

  const run = async (withCtx = useCtx) => {
    ctrl.current?.abort();
    setText('');
    setNote('');
    setError('');
    const apiKey = currentKey();
    if (!apiKey) {
      setStatus('idle');
      return;
    }
    const prefs = getSession().prefs;
    let req;
    try {
      const transcript = w.id === 'reply' && withCtx
        ? buildTranscript(ctx.messages.filter(isReadable).slice(-prefs.ctxCount), { profiles: ctx.profiles, meUid: ctx.me?.uid })
        : null;
      req = buildWritingHelp({ mode, draft, transcript, conv: ctx.conv, meName: ctx.me?.name });
    } catch (e) {
      setStatus('error');
      setError(e?.message || 'Can’t do that here.');
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    setStatus('streaming');
    try {
      const res = await streamReply({
        apiKey,
        model: prefs.model,
        effort: prefs.effort,
        system: req.system,
        messages: [{ role: 'user', content: req.content }],
        signal: c.signal,
        onText: (_d, all) => setText(all),
      });
      if (res.usage) addUsage(res.usage);
      if (c.signal.aborted) return;
      const info = stopInfo(res.stopReason, res.stopDetails);
      setText(info.status === 'refusal' ? '' : res.text.trim());
      setNote(info.note);
      setStatus(info.status === 'refusal' || !res.text.trim() ? 'error' : 'done');
      if (!res.text.trim() && !info.note) setError('Claude returned no text. Try again.');
    } catch (err) {
      if (c.signal.aborted) return;
      setStatus('error');
      setError(describeError(err, err?.sdk || {}).message);
    }
  };

  // Rewrites start right away; "Draft a reply" waits when it has neither notes nor context.
  const autoStart = ready && (w.needsDraft || useCtx || !!draft.trim());
  useEffect(() => {
    if (autoStart) run();
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = () => {
    const ta = composerTextarea(anchor);
    if (!ta) {
      ctx.toast('The message box is gone. Copy the text instead.');
      return;
    }
    ta.setSelectionRange(0, ta.value.length); // replace the whole draft
    ctx.insertText(text);
    onClose(true);
  };

  const streaming = status === 'streaming';
  return (
    <PortalModal
      title={`Writing help: ${w.label}`}
      onClose={() => onClose(false)}
      wide
      className="asst-write"
      footer={(
        <>
          {streaming ? (
            <button type="button" className="btn" onClick={() => { ctrl.current?.abort(); setStatus(text ? 'done' : 'idle'); }}>Stop</button>
          ) : (
            <button type="button" className="btn" onClick={() => run()} disabled={!ready}>{status === 'idle' ? 'Write it' : 'Try again'}</button>
          )}
          <button type="button" className="btn ghost" onClick={() => onClose(false)}>Cancel</button>
          <button type="button" className="btn primary" onClick={accept} disabled={streaming || !text.trim() || status === 'error'}>
            {draft.trim() ? 'Replace my draft' : 'Put in message box'}
          </button>
        </>
      )}
    >
      <div className="asst-write-body">
        <KeyGate session={s} compact />
        {draft.trim() && (
          <details className="asst-draft" open={w.id !== 'reply'}>
            <summary>{w.id === 'reply' ? 'Your notes' : 'Your draft'}</summary>
            <p>{draft}</p>
          </details>
        )}
        {w.id === 'reply' && (
          <label className="asst-check">
            <input
              type="checkbox"
              checked={useCtx}
              onChange={(e) => {
                setUseCtx(e.target.checked);
                setPrefs({ draftContext: e.target.checked });
              }}
            />
            <span>Let Claude read the last {s.prefs.ctxCount} messages here (they are sent to Anthropic)</span>
          </label>
        )}
        <label className="field">
          Suggestion
          <textarea
            className="input asst-write-out"
            rows={7}
            value={text}
            readOnly={streaming}
            aria-busy={streaming}
            placeholder={streaming ? 'Writing…' : status === 'idle' ? 'Choose “Write it” to get a suggestion.' : ''}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {note && <p className="asst-note warn">{note}</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <p className="settings-note">Nothing is sent to the chat until you send it yourself. {w.id === 'reply' && !useCtx ? 'Your notes are sent to Anthropic.' : 'This text is sent to Anthropic with your key.'}</p>
      </div>
    </PortalModal>
  );
}

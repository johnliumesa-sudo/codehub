// The Agent panel beside a collab workspace (collabMounts entry) and its toolbar button (collabTools).
// Premium only: other members see what it does and a link to Settings → Premium. Uses the API key
// from Settings → Assistant (kept only in this browser).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { spaceKey } from '../../../../lib/collab/space.js';
import { loadWorkspaceFiles } from '../../../../lib/collab/read.js';
import { buildPreviewHtml } from '../../../../lib/sandbox.js';
import { renderMarkdown } from '../../../../lib/markdown.js';
import { useWorkspaceCtx } from '../../../../lib/ext/workspaceContext.js';
import SandboxFrame from '../../../../components/sandbox/SandboxFrame.jsx';
import { usePremium } from '../../lib/status.js';
import { KeyGate, Markdown, fmtNum, useAssistant } from '../../../assistant/components/common.jsx';
import { currentKey, keyState } from '../../../assistant/lib/session.js';
import { AGENT_EFFORTS, MAX_TASK_CHARS, MAX_TOOL_CALLS, MODELS, loadAgentPrefs, saveAgentPrefs } from '../lib/config.js';
import { collabWorkspace } from '../lib/collabWorkspace.js';
import {
  PREVIEW_MS, decide, finishPreview, isBusy, makePreview, newTask, setOpen, startRun, stop, toggleOpen, undoRun, useAgent,
} from '../lib/run.js';
import DiffView from './DiffView.jsx';
import '../agent.css';

const PHASES = {
  thinking: 'Thinking…',
  writing: 'Writing…',
  tool: 'Working on the files…',
  waiting: 'Waiting for your approval',
  undoing: 'Undoing…',
};

const pad = (n) => String(n).padStart(2, '0');
const checkpointLabel = (d = new Date()) => `Before agent run ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Toolbar / welcome button: opens and closes the panel. */
export function AgentButton({ ctx, place }) {
  const sk = spaceKey(ctx.space);
  const s = useAgent(sk);
  return (
    <button
      type="button"
      className={`btn ${place === 'welcome' ? '' : 'sm ghost'} ag-btn`}
      aria-pressed={s.open}
      onClick={() => toggleOpen(sk)}
      title="Claude works on this workspace's files (Premium)"
    >
      <span className="ag-btn-icon" aria-hidden="true">🤖</span> Agent{isBusy(s) && <span className="ag-busy-dot" aria-label="running" />}
    </button>
  );
}

/** Mounted once per open workspace: the panel (when open) and the preview runner. Leaving stops the run. */
export function AgentMount({ ctx }) {
  const sk = spaceKey(ctx.space);
  const s = useAgent(sk);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => () => stop(sk), [sk]);
  if (!ctx.key) return null;
  return (
    <>
      {s.open && <AgentPanel ctx={ctx} ctxRef={ctxRef} sk={sk} s={s} />}
      {s.preview && <PreviewRunner sk={sk} job={s.preview} />}
    </>
  );
}

/** Runs one preview bundle in the sandbox and reports its console output after PREVIEW_MS. */
function PreviewRunner({ sk, job }) {
  const lines = useRef([]);
  useEffect(() => {
    lines.current = [];
    const t = setTimeout(() => finishPreview(sk, job.id, lines.current.slice(0, 200)), PREVIEW_MS);
    return () => clearTimeout(t);
  }, [sk, job.id]);
  const onConsole = useCallback(({ level, args }) => {
    if (level === 'clear') lines.current = [];
    else lines.current.push({ level, text: args.join(' ') });
  }, []);
  return (
    <div className="ag-preview-run" role="status">
      <span>Agent is running a preview of <code>{job.entry}</code>…</span>
      <SandboxFrame html={job.html} mode="preview" onConsole={onConsole} title={`Agent preview of ${job.entry}`} className="ag-preview-frame" />
    </div>
  );
}

function Upsell({ ws }) {
  return (
    <div className="ag-upsell">
      <h3>Agent mode is part of Premium</h3>
      <p>Describe a task and Claude works on this workspace for you:</p>
      <ul>
        <li>reads, searches, creates, edits, renames and deletes files;</li>
        <li>runs the live preview in the sandbox to check for console errors;</li>
        <li>shows every change as a diff for you to approve, and saves checkpoints so a run can be undone in one click;</li>
        <li>edits land in the shared files, so collaborators see them live.</li>
      </ul>
      <p className="ag-muted">It uses your own Anthropic API key from Settings → Assistant.</p>
      {ws?.openSettings && <button type="button" className="btn primary sm" onClick={() => ws.openSettings('premium')}>Get Premium</button>}
    </div>
  );
}

function Consent({ onAccept }) {
  return (
    <div className="ag-consent" role="note">
      <strong>Before you start</strong>
      <p>
        The files the agent reads are decrypted in this browser and sent, with your task, to Anthropic under your own API key.
        What you send leaves Codehub’s end-to-end encryption and is handled under your Anthropic account. Nothing is sent until you run a task.
      </p>
      <p>Workspace files may contain text written by others. The agent treats it as data, can only use the tools listed here on this workspace, and every change is shown to you first unless you choose to apply changes automatically.</p>
      <button type="button" className="btn primary sm" onClick={onAccept}>I understand</button>
    </div>
  );
}

const statusText = { pending: 'Waiting for approval', applying: 'Applying…', applied: 'Applied', skipped: 'Skipped', failed: 'Not applied' };

function ChangeCard({ item, sk, waiting }) {
  const { change, stats, status } = item;
  const [open, setOpenState] = useState(status === 'pending');
  useEffect(() => {
    if (status === 'pending') setOpenState(true);
  }, [status]);
  const applyRef = useRef(null);
  useEffect(() => {
    if (waiting) applyRef.current?.focus();
  }, [waiting]);
  return (
    <div className={`ag-change ${status}`}>
      <div className="ag-change-head">
        <button type="button" className="ag-link" aria-expanded={open} onClick={() => setOpenState((o) => !o)}>
          {change.summary}
        </button>
        {change.kind !== 'rename' && (
          <span className="ag-stats" aria-label={`${stats.added} lines added, ${stats.removed} removed`}>
            <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
          </span>
        )}
        <span className={`ag-pill ${status}`}>{statusText[status] || status}</span>
      </div>
      {open && <DiffView change={change} />}
      {item.detail && <p className="ag-error-text">{item.detail}</p>}
      {waiting && (
        <div className="ag-row" role="group" aria-label="Approve this change">
          <button ref={applyRef} type="button" className="btn primary sm" onClick={() => decide(sk, 'apply')}>Apply</button>
          <button type="button" className="btn sm" onClick={() => decide(sk, 'skip')}>Skip</button>
          <button type="button" className="btn sm ghost" onClick={() => decide(sk, 'all')} title="Apply this and every later change of this run without asking">Apply all</button>
        </div>
      )}
    </div>
  );
}

function RunEnd({ item, sk, busy }) {
  const [confirm, setConfirm] = useState(false);
  const res = item.undoResult;
  return (
    <div className="ag-runend">
      <p>
        Changed {item.files} file{item.files === 1 ? '' : 's'}.
        {item.checkpoints ? ` A checkpoint of ${item.checkpoints === 1 ? 'the file' : `each of the ${item.checkpoints} files`} was saved before its first change (Checkpoints → “Before agent run”).` : ''}
      </p>
      {item.undo === 'ready' && !confirm && (
        <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirm(true)}>Undo this run</button>
      )}
      {item.undo === 'ready' && confirm && (
        <div className="ag-row" role="group" aria-label="Confirm undo">
          <span className="ag-muted">Put these files back as they were before the run? Later edits to them are replaced too.</span>
          <button type="button" className="btn danger sm" onClick={() => { setConfirm(false); undoRun(sk, item.runId); }}>Undo changes</button>
          <button type="button" className="btn sm ghost" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
      {item.undo === 'busy' && <p className="ag-muted">Undoing…</p>}
      {item.undo === 'done' && <p className="ag-ok">Undone: the files are back as they were before this run.</p>}
      {item.undo === 'partial' && (
        <p className="ag-error-text">Partly undone. Not restored: {res?.failed?.join('; ')}. Use Checkpoints on those files.</p>
      )}
      {item.undoError && <p className="ag-error-text">{item.undoError}</p>}
    </div>
  );
}

function Item({ item, sk, s, ws }) {
  switch (item.type) {
    case 'user':
      return <div className="ag-user">{item.text}</div>;
    case 'assistant':
      return <div className="ag-bot"><Markdown text={item.text} /></div>;
    case 'tool':
      return (
        <div className={`ag-tool ${item.status}`}>
          <span className="ag-tool-icon" aria-hidden="true">{item.status === 'done' ? '✓' : item.status === 'error' ? '!' : '…'}</span>
          <span>{item.label}</span>
          {item.detail && <span className="ag-tool-detail">{item.detail}</span>}
        </div>
      );
    case 'change':
      return <ChangeCard item={item} sk={sk} waiting={s.phase === 'waiting' && item.status === 'pending'} />;
    case 'note':
      return <p className={`ag-note ${item.tone || ''}`}>{item.text}</p>;
    case 'error':
      return (
        <div className="ag-err" role="alert">
          <strong>{item.title}</strong>
          <p>{item.text}</p>
          {(item.kind === 'auth' || item.kind === 'nokey' || item.kind === 'notFound') && ws?.openSettings && (
            <button type="button" className="btn sm" onClick={() => ws.openSettings('assistant')}>Open Settings → Assistant</button>
          )}
        </div>
      );
    case 'run':
      return <RunEnd item={item} sk={sk} busy={isBusy(s)} />;
    default:
      return null;
  }
}

function AgentPanel({ ctx, ctxRef, sk, s }) {
  const ws = useWorkspaceCtx();
  const me = ctx.me;
  const premium = usePremium(me?.uid);
  const session = useAssistant(me?.uid);
  const [prefs, setPrefsState] = useState(() => loadAgentPrefs(me?.uid));
  useEffect(() => setPrefsState(loadAgentPrefs(me?.uid)), [me?.uid]);
  const setPrefs = (p) => setPrefsState((cur) => saveAgentPrefs(me?.uid, { ...cur, ...p }));
  const [task, setTask] = useState('');
  const [formErr, setFormErr] = useState('');
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const panelRef = useRef(null);
  const ids = { model: useId(), effort: useId(), mode: useId(), task: useId() };
  const busy = isBusy(s);
  const ready = premium.active && session && keyState(session) === 'ready' && prefs.consent;

  useEffect(() => {
    if (ready) inputRef.current?.focus();
    else panelRef.current?.focus();
  }, [ready]);
  // Keep the newest output in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.items]);

  const close = () => setOpen(sk, false);
  const onKeyDown = (e) => {
    // A dialog on top (settings, checkpoints) handles its own Escape.
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) {
      e.preventDefault();
      close();
    }
  };

  const run = () => {
    const text = task.trim();
    if (!text || busy) return;
    if (text.length > MAX_TASK_CHARS) {
      setFormErr(`Keep the task under ${MAX_TASK_CHARS.toLocaleString()} characters.`);
      return;
    }
    setFormErr('');
    const apiKey = currentKey();
    const c = ctxRef.current;
    setTask('');
    startRun(sk, {
      task: text,
      apiKey,
      model: prefs.model,
      effort: prefs.effort,
      auto: prefs.auto,
      fileCount: c.files?.length || 0,
      label: checkpointLabel(),
      makeWs: (signal) => {
        const loadFiles = async () => {
          const files = await loadWorkspaceFiles(c.space, c.key, { maxFiles: 200 });
          const p = ctxRef.current.provider;
          const active = ctxRef.current.activePath;
          if (p && !p.destroyed && active) {
            const i = files.findIndex((f) => f.path === active);
            if (i >= 0) files[i] = { ...files[i], text: p.ytext.toString() };
          }
          return files;
        };
        return collabWorkspace({
          space: c.space,
          key: c.key,
          me: c.me,
          readOnly: c.readOnly,
          activeProvider: () => ctxRef.current.provider,
          preview: makePreview(sk, { loadFiles, buildPreviewHtml, renderMarkdown, signal }),
        });
      },
    });
  };

  const items = s.items;
  const u = s.usage;
  const hasHistory = items.length > 0;

  return (
    <aside ref={panelRef} className="ag-panel" aria-label="Agent" tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="ag-head">
        <span className="ag-title"><span aria-hidden="true">🤖</span> Agent</span>
        <span className="ag-premium">Premium</span>
        <span className="ag-spacer" />
        {premium.active && hasHistory && (
          <button type="button" className="btn sm ghost" onClick={() => newTask(sk)} disabled={busy}>New task</button>
        )}
        <button type="button" className="ag-x" onClick={close} aria-label="Close agent panel">✕</button>
      </header>

      {premium.loading ? (
        <div className="ag-center"><div className="spinner" /></div>
      ) : !premium.active ? (
        <Upsell ws={ws} />
      ) : !session || keyState(session) !== 'ready' ? (
        <div className="ag-pad">{session && <KeyGate session={session} />}</div>
      ) : !prefs.consent ? (
        <Consent onAccept={() => setPrefs({ consent: true })} />
      ) : (
        <>
          {ctx.readOnly && <p className="ag-note warn ag-pad-x">You can only read this workspace, so the agent can read and explain files but not change them.</p>}
          <div ref={logRef} className="ag-log" aria-label="Agent activity" tabIndex={0}>
            {!hasHistory && (
              <div className="ag-empty">
                <p>Describe what you want done in this workspace, for example “Add a dark mode toggle to index.html” or “Find why the counter starts at 1 and fix it”.</p>
                <p className="ag-muted">Claude can list, read, search, create, edit, rename and delete files and run the preview. Up to {MAX_TOOL_CALLS} tool calls per run.</p>
              </div>
            )}
            {items.map((it) => <Item key={it.id} item={it} sk={sk} s={s} ws={ws} />)}
          </div>
          <div className="ag-status" role="status" aria-live="polite">
            {busy || s.phase ? <><span className="ag-spin" aria-hidden="true" /> {PHASES[s.phase] || 'Working…'}</> : null}
          </div>
          <div className="ag-foot">
            <div className="ag-opts">
              <label htmlFor={ids.model}>Model</label>
              <select id={ids.model} className="input ag-select" value={prefs.model} disabled={busy} onChange={(e) => setPrefs({ model: e.target.value })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <label htmlFor={ids.effort}>Effort</label>
              <select id={ids.effort} className="input ag-select" value={prefs.effort} disabled={busy} onChange={(e) => setPrefs({ effort: e.target.value })}>
                {AGENT_EFFORTS.map((e) => <option key={e.id} value={e.id} title={e.hint}>{e.label}</option>)}
              </select>
              {!ctx.readOnly && (
                <>
                  <label htmlFor={ids.mode}>Changes</label>
                  <select id={ids.mode} className="input ag-select" value={prefs.auto ? 'auto' : 'ask'} disabled={busy} onChange={(e) => setPrefs({ auto: e.target.value === 'auto' })}>
                    <option value="ask">Ask before each change</option>
                    <option value="auto">Apply automatically</option>
                  </select>
                </>
              )}
            </div>
            <p className="ag-usage" aria-label="Usage this session">
              {fmtNum(u.input)} in · {fmtNum(u.output)} out{u.cacheRead ? ` · ${fmtNum(u.cacheRead)} cached` : ''} tokens · {s.toolCalls} tool call{s.toolCalls === 1 ? '' : 's'}
            </p>
            <form
              className="ag-input"
              onSubmit={(e) => {
                e.preventDefault();
                run();
              }}
            >
              <label htmlFor={ids.task} className="asst-sr">Task for the agent</label>
              <textarea
                id={ids.task}
                ref={inputRef}
                className="input"
                rows={3}
                value={task}
                maxLength={MAX_TASK_CHARS + 1}
                placeholder={hasHistory ? 'Follow up, or say “continue”…' : 'What should the agent do?'}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    run();
                  }
                }}
              />
              {busy ? (
                <button type="button" className="btn danger sm" onClick={() => stop(sk)}>Stop</button>
              ) : (
                <button type="submit" className="btn primary sm" disabled={!task.trim()}>{hasHistory ? 'Send' : 'Run'}</button>
              )}
            </form>
            {formErr && <p className="ag-error-text" role="alert">{formErr}</p>}
            <p className="ag-fine">Files the agent reads are decrypted and sent to Anthropic under your API key. Ctrl/⌘+Enter runs.</p>
          </div>
        </>
      )}
    </aside>
  );
}

export default AgentPanel;

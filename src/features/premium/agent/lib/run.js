// In-memory agent state, one per open workspace (keyed by spaceKey), and the run orchestration: the
// loop (loop.js) + tools (tools.js) on the collab workspace (collabWorkspace.js), approvals, the
// sandboxed preview hand-off, usage, stop and undo. Nothing here is persisted: a reload, leaving the
// workspace (the run stops), a vault lock or sign-out clears it. Checkpoints saved before a run's
// changes stay in the workspace (encrypted, like every checkpoint).
import { useSyncExternalStore } from 'react';
import { loadSdk, fellBack } from '../../../assistant/lib/client.js';
import { describeError, stopInfo } from '../../../assistant/lib/errors.js';
import { addUsage } from '../../../assistant/lib/session.js';
import { buildAgentParams, MAX_TOOL_CALLS, taskMessage } from './config.js';
import { AgentAborted, closeOpenToolUses, pushUserText, runAgentLoop } from './loop.js';
import { toolDefs, WRITE_TOOLS } from './schema.js';
import { applyChange, changeStats, createRunTracker, planChange, runReadTool, ToolError } from './tools.js';

const PREVIEW_RUN_MS = 3000;
const PREVIEW_TIMEOUT_MS = 15_000;

const blankUsage = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function blank() {
  return {
    open: false,
    status: 'idle', // idle | running | done | error | stopped
    phase: '', // thinking | writing | tool | waiting | undoing
    items: [], // transcript shown in the panel
    usage: blankUsage(),
    toolCalls: 0,
    auto: false, // "Apply all" for the rest of the current run
    preview: null, // { id, html, entry } while a preview runs
  };
}

const states = new Map(); // spaceKey -> state
const hidden = new Map(); // spaceKey -> { messages, abort, decision, trackers: Map, previewDone }
const listeners = new Set();
let itemSeq = 0;
const EMPTY = blank();

function emit() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error('[agent] listener failed', e);
    }
  }
}

export function getAgent(sk) {
  return states.get(sk) || EMPTY;
}

function inner(sk) {
  let h = hidden.get(sk);
  if (!h) {
    h = { messages: [], abort: null, decision: null, trackers: new Map(), previewDone: null };
    hidden.set(sk, h);
  }
  return h;
}

function patch(sk, p) {
  const cur = getAgent(sk);
  const next = typeof p === 'function' ? p(cur) : p;
  states.set(sk, { ...cur, ...next });
  emit();
}

function addItem(sk, item) {
  const it = { id: `i${++itemSeq}`, ...item };
  patch(sk, (s) => ({ items: [...s.items, it] }));
  return it.id;
}

function updateItem(sk, id, p) {
  patch(sk, (s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...(typeof p === 'function' ? p(it) : p) } : it)) }));
}

export function subscribeAgent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAgent(sk) {
  return useSyncExternalStore(subscribeAgent, () => getAgent(sk), () => getAgent(sk));
}

export function setOpen(sk, open) {
  patch(sk, { open: !!open });
}

export function toggleOpen(sk) {
  setOpen(sk, !getAgent(sk).open);
}

export const isBusy = (s) => s.status === 'running';

/** The member's answer to the change waiting for approval: 'apply' | 'skip' | 'all'. */
export function decide(sk, decision) {
  const h = inner(sk);
  const d = h.decision;
  if (!d) return;
  h.decision = null;
  if (decision === 'all') patch(sk, { auto: true });
  d.resolve(decision === 'skip' ? 'skip' : 'apply');
}

function waitDecision(sk, itemId, signal) {
  return new Promise((resolve, reject) => {
    const h = inner(sk);
    const onAbort = () => {
      h.decision = null;
      reject(new AgentAborted());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    h.decision = {
      itemId,
      resolve: (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
    };
  });
}

/** Stop the running agent (the request is aborted; a change waiting for approval is not applied). */
export function stop(sk) {
  inner(sk).abort?.abort();
}

/** Stop and forget everything for every workspace (vault lock, sign-out). */
export function resetAll() {
  for (const h of hidden.values()) h.abort?.abort();
  hidden.clear();
  states.clear();
  emit();
}

/** Clear the conversation of one workspace ("New task"). */
export function newTask(sk) {
  const h = inner(sk);
  if (h.abort) return;
  hidden.delete(sk);
  patch(sk, (s) => ({ ...blank(), open: s.open }));
}

// ---------- preview hand-off (the panel renders the sandbox frame) ----------

/** Called by the panel's preview runner with the console lines once the run window is over. */
export function finishPreview(sk, id, lines) {
  const h = inner(sk);
  if (h.previewDone?.id !== id) return;
  const done = h.previewDone;
  h.previewDone = null;
  patch(sk, { preview: null });
  done.resolve(lines);
}

export const PREVIEW_MS = PREVIEW_RUN_MS;

function runPreview(sk, html, entry, signal) {
  return new Promise((resolve, reject) => {
    const id = `p${++itemSeq}`;
    const h = inner(sk);
    const t = setTimeout(() => {
      if (h.previewDone?.id === id) {
        h.previewDone = null;
        patch(sk, { preview: null });
        reject(new ToolError('The preview did not finish in time.'));
      }
    }, PREVIEW_TIMEOUT_MS);
    const onAbort = () => {
      clearTimeout(t);
      if (h.previewDone?.id === id) h.previewDone = null;
      patch(sk, { preview: null });
      reject(new AgentAborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    h.previewDone = {
      id,
      resolve: (lines) => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve(lines);
      },
    };
    patch(sk, { preview: { id, html, entry } });
  });
}

/** preview(entry) for the workspace interface: bundle with the live preview pipeline, run in the panel. */
export function makePreview(sk, { loadFiles, buildPreviewHtml, renderMarkdown, signal }) {
  return async (entry) => {
    const files = await loadFiles();
    const pick = entry
      || files.find((f) => /(^|\/)index\.html?$/i.test(f.path))?.path
      || files.find((f) => /\.html?$/i.test(f.path))?.path
      || files.find((f) => /\.(m?js|cjs)$/i.test(f.path))?.path;
    if (!pick) return { error: 'There is no HTML or JavaScript file to preview.' };
    const built = buildPreviewHtml(pick, files, { renderMarkdown });
    if (built.error) return { error: built.error };
    const lines = await runPreview(sk, built.html, pick, signal);
    return { entry: pick, lines, missing: built.missing || [] };
  };
}

// ---------- a run ----------

const shortJSON = (v, n = 80) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** A one-line label for a tool call, from its (validated) input. */
export function toolLabel(name, input = {}) {
  switch (name) {
    case 'list_files': return 'Listed files';
    case 'read_file': return `Read ${input.path}${input.start_line ? ` (lines ${input.start_line}–${input.end_line || 'end'})` : ''}`;
    case 'search_files': return `Searched for ${shortJSON(input.query, 60)}${input.regex ? ' (regex)' : ''}${input.path_prefix ? ` in ${input.path_prefix}` : ''}`;
    case 'preview': return `Ran preview${input.entry ? ` of ${input.entry}` : ''}`;
    default: return name;
  }
}

/**
 * Start (or continue) the agent on a task.
 * @param {string} sk  spaceKey
 * @param {object} o   { task, makeWs(signal) -> workspace interface, model, effort, auto, apiKey, fileCount, label }
 */
export async function startRun(sk, { task, makeWs, model, effort, auto, apiKey, fileCount = 0, label }) {
  const h = inner(sk);
  if (h.abort) return;
  const ctrl = new AbortController();
  h.abort = ctrl;
  const ws = makeWs(ctrl.signal);
  const runId = `r${++itemSeq}`;
  const tracker = createRunTracker(ws, label);
  h.trackers.set(runId, tracker);
  const first = h.messages.length === 0;
  addItem(sk, { type: 'user', text: task });
  patch(sk, { status: 'running', phase: 'thinking', auto: !!auto });
  if (first) h.messages.push({ role: 'user', content: taskMessage(task, { files: fileCount }) });
  else pushUserText(h.messages, task);

  const previewable = typeof ws.preview === 'function';
  const { beta, params } = buildAgentParams({ model, effort, tools: toolDefs({ readOnly: ws.readOnly, preview: previewable }), readOnly: ws.readOnly, preview: previewable });
  let textItem = null;
  let Anthropic = null;
  let fell = false;

  const runTool = async (block) => {
    const { name, input } = block;
    textItem = null;
    patch(sk, (s) => ({ phase: 'tool', toolCalls: s.toolCalls + 1 }));
    if (!WRITE_TOOLS.includes(name)) {
      const id = addItem(sk, { type: 'tool', name, label: toolLabel(name, input), status: 'running' });
      try {
        const content = await runReadTool(name, input, ws);
        updateItem(sk, id, { status: 'done' });
        return { content };
      } catch (err) {
        if (err instanceof AgentAborted) throw err;
        const msg = String(err?.message || err);
        updateItem(sk, id, { status: 'error', detail: msg.slice(0, 300) });
        return { content: msg, isError: true };
      }
    }
    let change;
    try {
      change = await planChange(name, input, ws);
    } catch (err) {
      const msg = String(err?.message || err);
      addItem(sk, { type: 'tool', name, label: `Couldn't ${name.replace('_file', '')} ${input.path || ''}`.trim(), status: 'error', detail: msg.slice(0, 300) });
      return { content: msg, isError: true };
    }
    const id = addItem(sk, { type: 'change', change, stats: changeStats(change), status: 'pending' });
    let decision = 'apply';
    if (!getAgent(sk).auto) {
      patch(sk, { phase: 'waiting' });
      decision = await waitDecision(sk, id, ctrl.signal);
      patch(sk, { phase: 'tool' });
    }
    if (decision === 'skip') {
      updateItem(sk, id, { status: 'skipped' });
      return { content: 'The member skipped this change, so it was not applied.', isError: true };
    }
    updateItem(sk, id, { status: 'applying' });
    try {
      const msg = await applyChange(change, ws, tracker);
      updateItem(sk, id, { status: 'applied' });
      return { content: msg };
    } catch (err) {
      const msg = String(err?.message || err);
      updateItem(sk, id, { status: 'failed', detail: msg.slice(0, 300) });
      return { content: msg, isError: true };
    }
  };

  const onEvent = (ev) => {
    if (ev.type === 'text') {
      if (!textItem) textItem = addItem(sk, { type: 'assistant', text: '' });
      const id = textItem;
      updateItem(sk, id, (it) => ({ text: it.text + ev.text }));
      if (getAgent(sk).phase !== 'writing') patch(sk, { phase: 'writing' });
    } else if (ev.type === 'thinking') {
      patch(sk, { phase: 'thinking' });
    } else if (ev.type === 'turn') {
      textItem = null;
      const u = ev.message?.usage;
      if (u) {
        addUsage(u);
        const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
        patch(sk, (s) => ({
          usage: {
            requests: s.usage.requests + 1,
            input: s.usage.input + n(u.input_tokens),
            output: s.usage.output + n(u.output_tokens),
            cacheRead: s.usage.cacheRead + n(u.cache_read_input_tokens),
            cacheWrite: s.usage.cacheWrite + n(u.cache_creation_input_tokens),
          },
        }));
      }
      if (fellBack(ev.message)) fell = true;
      patch(sk, { phase: 'thinking' });
    } else if (ev.type === 'invalid') {
      addItem(sk, { type: 'tool', name: ev.name, label: `Rejected malformed ${ev.name} call`, status: 'error', detail: ev.reason });
    } else if (ev.type === 'retry') {
      textItem = null;
      addItem(sk, { type: 'note', tone: 'warn', text: 'A tool call arrived garbled; asking Claude again.' });
    }
  };

  let status = 'done';
  try {
    if (!apiKey) throw Object.assign(new Error('Add your Anthropic API key in Settings → Assistant first.'), { code: 'nokey' });
    Anthropic = await loadSdk();
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });
    const res = await runAgentLoop({
      client, beta, params, messages: h.messages, APIError: Anthropic.APIError, runTool,
      maxToolCalls: MAX_TOOL_CALLS, signal: ctrl.signal, onEvent,
    });
    if (fell) addItem(sk, { type: 'note', text: 'Part of this run was answered by a fallback model after the selected model declined.' });
    if (res.reason === 'aborted') {
      status = 'stopped';
      addItem(sk, { type: 'note', text: 'Stopped. Nothing else will be changed.' });
    } else if (res.reason === 'refusal') {
      status = 'error';
      addItem(sk, { type: 'note', tone: 'warn', text: stopInfo('refusal', res.message?.stop_details).note });
    } else if (res.reason === 'max_tokens') {
      addItem(sk, { type: 'note', tone: 'warn', text: 'Claude’s reply reached the length limit before it finished; nothing from the cut-off part was run. Ask it to continue in smaller steps.' });
    } else if (res.reason === 'context') {
      status = 'error';
      addItem(sk, { type: 'note', tone: 'warn', text: 'The conversation is too long to continue. Start a new task.' });
    } else if (res.reason === 'cap') {
      addItem(sk, { type: 'note', tone: 'warn', text: `Stopped after ${MAX_TOOL_CALLS} tool calls, the limit for one run. Send “continue” to let it keep going.` });
    } else if (res.reason === 'paused') {
      addItem(sk, { type: 'note', tone: 'warn', text: 'Claude paused this turn several times in a row. Send “continue” to resume.' });
    }
  } catch (err) {
    status = ctrl.signal.aborted ? 'stopped' : 'error';
    // A request that failed mid-run leaves tool_use blocks without results: close them for follow-ups.
    closeOpenToolUses(h.messages, [], 'Not run: the request failed.');
    if (status === 'stopped') addItem(sk, { type: 'note', text: 'Stopped. Nothing else will be changed.' });
    else {
      const d = err?.code === 'nokey' ? { title: 'No API key', message: err.message, kind: 'nokey' } : describeError(err, Anthropic || err?.sdk || {});
      addItem(sk, { type: 'error', title: d.title, text: d.message, kind: d.kind });
    }
  } finally {
    h.abort = null;
    h.decision = null;
    const s = getAgent(sk);
    // Any change still marked pending (aborted while waiting) was not applied.
    patch(sk, {
      status,
      phase: '',
      auto: false,
      items: s.items.map((it) => (it.type === 'change' && (it.status === 'pending' || it.status === 'applying') ? { ...it, status: 'skipped' } : it.type === 'tool' && it.status === 'running' ? { ...it, status: 'error', detail: 'Stopped.' } : it)),
    });
    if (tracker.changed > 0) {
      addItem(sk, { type: 'run', runId, files: tracker.changed, checkpoints: tracker.checkpoints.length, undo: 'ready' });
    } else {
      h.trackers.delete(runId);
    }
  }
}

/** Undo every change of one run (one click), using the run's in-memory record. */
export async function undoRun(sk, runId) {
  const h = inner(sk);
  const tracker = h.trackers.get(runId);
  const item = getAgent(sk).items.find((it) => it.type === 'run' && it.runId === runId);
  if (!tracker || !item || item.undo !== 'ready' || h.abort) return null;
  updateItem(sk, item.id, { undo: 'busy' });
  patch(sk, { phase: 'undoing' });
  try {
    const res = await tracker.undo();
    h.trackers.delete(runId);
    updateItem(sk, item.id, { undo: res.failed.length ? 'partial' : 'done', undoResult: res });
    return res;
  } catch (err) {
    updateItem(sk, item.id, { undo: 'ready', undoError: String(err?.message || err) });
    return null;
  } finally {
    patch(sk, { phase: '' });
  }
}

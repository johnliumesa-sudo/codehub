// Assistant actions: everything that sends something to Claude. Each one runs only when the user asks
// (a click, a palette action, /ask); nothing is sent in the background.
import { getLastRead } from '../../../lib/messages.js';
import { MAX_QUESTION_CHARS, MAX_SUMMARY_MESSAGES } from './config.js';
import { describeError, stopInfo } from './errors.js';
import { streamReply } from './client.js';
import { forgetKey, loadRecord, saveKey, savePrefs, unlockKey } from './keyStore.js';
import {
  buildCatchUp, buildExplainCode, buildHistory, buildQuestion, buildThreadSummary, buildTranscript, buildTranslate,
  catchUpSelection, convShort, isReadable, systemPrompt, threadOf,
} from './prompts.js';
import { addUsage, chatCtx, currentKey, getSession, keyState, setSession } from './session.js';

export const PANEL_ID = 'assistant';

let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(++seq).toString(36)}`;
const controllers = new Map(); // assistant turn id -> AbortController

// ---------- key & prefs ----------

export async function saveApiKey(apiKey, passphrase) {
  const { uid } = getSession();
  const rec = await saveKey(uid, apiKey, { passphrase });
  setSession({ record: rec, apiKey: String(apiKey).trim() });
  return rec;
}

export async function unlock(passphrase) {
  const { uid } = getSession();
  const key = await unlockKey(uid, passphrase);
  setSession({ apiKey: key, record: loadRecord(uid) });
  return true;
}

/** Drop the decrypted key from memory (a locked key then needs the passphrase again). */
export function lockNow() {
  setSession({ apiKey: null });
}

export function forget() {
  const { uid } = getSession();
  forgetKey(uid);
  setSession({ apiKey: null, record: null });
}

export function setPrefs(patch) {
  const s = getSession();
  setSession({ prefs: savePrefs(s.uid, { ...s.prefs, ...patch }, { navLang: typeof navigator !== 'undefined' ? navigator.language : 'en' }) });
}

export function resetUsage() {
  setSession({ usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
}

// ---------- panel visibility (workspace-level toggle) ----------

/** Open the assistant panel in this chat (and keep it open across conversations). */
export function openPanel(ctx = chatCtx()) {
  setSession({ panelOpen: true });
  if (ctx && ctx.panel !== PANEL_ID) ctx.openPanel?.(PANEL_ID);
}

/** Toggle from the palette, the sidebar or the hotkey. Returns false when no conversation is open. */
export function togglePanel() {
  const open = !getSession().panelOpen;
  setSession({ panelOpen: open });
  const ctx = chatCtx();
  if (!ctx) return false;
  if (open && ctx.panel !== PANEL_ID) ctx.openPanel?.(PANEL_ID);
  if (!open && ctx.panel === PANEL_ID) ctx.closePanel?.();
  return true;
}

export function setUnreadSince(scope, ts) {
  if (!scope) return;
  setSession((s) => ({ unreadSince: { ...s.unreadSince, [scope]: Number(ts) || 0 } }));
}

/** Capture a conversation's read marker before ChatView moves it (called when the composer mounts). */
export function captureReadMarker(uid, scope) {
  if (!uid || !scope) return;
  getLastRead(uid, scope).then((ts) => setUnreadSince(scope, ts)).catch(() => {});
}

// ---------- the panel conversation ----------

function patchTurn(id, patch) {
  setSession((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

function errorPatch(err) {
  const d = describeError(err, err?.sdk || {});
  if (d.kind === 'aborted') return { status: 'stopped' };
  return { status: 'error', error: { kind: d.kind, title: d.title, message: d.message, retryAfter: d.retryAfter || null } };
}

/**
 * Add a user turn and stream Claude's reply into the panel.
 * spec = { display, content, kind, conv?, question? } — display is what the panel shows for the user
 * turn, content is what is sent.
 */
export async function runTurn(spec) {
  const s = getSession();
  if (s.turns.some((t) => t.status === 'streaming')) throw new Error('Wait for the current reply to finish, or stop it.');
  const userTurn = {
    id: nextId(),
    role: 'user',
    display: String(spec.display || spec.content || '').slice(0, 2000),
    content: String(spec.content || ''),
    kind: spec.kind || 'chat',
    conv: spec.conv || null,
    question: spec.question || '',
  };
  const history = buildHistory(s.turns);
  const reply = { id: nextId(), role: 'assistant', text: '', status: 'streaming', kind: userTurn.kind, model: s.prefs.model, userId: userTurn.id };
  setSession((st) => ({ turns: [...st.turns, userTurn, reply] }));
  return stream(reply.id, [...history, { role: 'user', content: userTurn.content }]);
}

async function stream(replyId, messages) {
  const s = getSession();
  const apiKey = currentKey();
  if (!apiKey) {
    patchTurn(replyId, {
      status: 'error',
      error: {
        kind: keyState() === 'locked' ? 'locked' : 'nokey',
        title: keyState() === 'locked' ? 'Key locked' : 'No API key',
        message: keyState() === 'locked' ? 'Unlock your API key above, then retry.' : 'Add your Anthropic API key in Settings → Assistant, then retry.',
      },
    });
    return;
  }
  const ctrl = new AbortController();
  controllers.set(replyId, ctrl);
  let pending = '';
  let timer = null;
  const flush = () => {
    timer = null;
    patchTurn(replyId, { text: pending });
  };
  try {
    const res = await streamReply({
      apiKey,
      model: s.prefs.model,
      effort: s.prefs.effort,
      system: systemPrompt({ meName: chatCtx()?.me?.name || '' }),
      messages,
      signal: ctrl.signal,
      onText: (_d, all) => {
        pending = all;
        if (!timer) timer = setTimeout(flush, 40);
      },
    });
    if (timer) clearTimeout(timer);
    if (res.usage) addUsage(res.usage);
    if (res.aborted) {
      patchTurn(replyId, { text: res.text, status: 'stopped' });
      return;
    }
    const info = stopInfo(res.stopReason, res.stopDetails);
    patchTurn(replyId, { text: info.status === 'refusal' ? '' : res.text, status: info.status, note: info.note, model: res.model, fellBack: !!res.fellBack });
  } catch (err) {
    if (timer) clearTimeout(timer);
    patchTurn(replyId, { text: pending, ...errorPatch(err) });
  } finally {
    controllers.delete(replyId);
  }
}

export function stopTurn(id) {
  controllers.get(id)?.abort();
}

export function stopAll() {
  for (const c of controllers.values()) c.abort();
}

/** Retry a failed or refused reply with the same request. */
export function retryTurn(replyId) {
  const s = getSession();
  const i = s.turns.findIndex((t) => t.id === replyId);
  const reply = s.turns[i];
  const user = s.turns[i - 1];
  if (!reply || reply.role !== 'assistant' || user?.role !== 'user' || reply.status === 'streaming') return Promise.resolve();
  if (s.turns.some((t) => t.status === 'streaming')) return Promise.resolve();
  const history = buildHistory(s.turns.slice(0, i - 1));
  patchTurn(replyId, { text: '', status: 'streaming', error: null, note: '', model: s.prefs.model, fellBack: false });
  return stream(replyId, [...history, { role: 'user', content: user.content }]);
}

export function clearConversation() {
  stopAll();
  setSession({ turns: [] });
}

// ---------- features ----------

const convOf = (ctx) => (ctx?.conv ? { scope: ctx.conv.scope, short: convShort(ctx.conv), kind: ctx.conv.kind } : null);

/** A question from the panel box (with recent messages when the toggle is on). */
export function ask(question, ctx, { kind = 'chat' } = {}) {
  const q = String(question ?? '').trim();
  if (!q) return Promise.resolve();
  if (q.length > MAX_QUESTION_CHARS) throw new Error(`That's too long (${q.length}/${MAX_QUESTION_CHARS} characters).`);
  const s = getSession();
  const transcript = s.includeContext && ctx
    ? buildTranscript(ctx.messages.filter(isReadable).slice(-s.prefs.ctxCount), { profiles: ctx.profiles, meUid: ctx.me?.uid })
    : null;
  const display = kind === 'ask' ? `/ask ${q}` : q;
  return runTurn({
    display: transcript?.count ? `${display}\n(with the last ${transcript.count} messages from ${convShort(ctx.conv)})` : display,
    content: buildQuestion({ question: q, transcript, conv: ctx?.conv }),
    kind,
    conv: convOf(ctx),
    question: q,
  });
}

/** /ask <question>: private answer in the panel. */
export function askPrivately(question, ctx) {
  openPanel(ctx);
  return ask(question, ctx, { kind: 'ask' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until cond() is true or the timeout passes. */
async function waitFor(cond, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

/**
 * Page older history in through ChatContext.loadOlder() until `enough(messages)` or nothing older is
 * left (at most 8 pages), then wait for decryption. Reads the live ctx through the chat bridge.
 */
export async function loadUntil(ctx, enough, { pages = 8 } = {}) {
  const live = () => {
    const c = chatCtx();
    return c && c.conv?.scope === ctx.conv?.scope ? c : ctx;
  };
  for (let i = 0; i < pages; i++) {
    const c = live();
    if (enough(c.messages) || !c.hasMore || typeof c.loadOlder !== 'function') break;
    const before = c.messages.length;
    c.loadOlder();
    if (!(await waitFor(() => live().messages.length > before || !live().hasMore))) break;
  }
  await waitFor(() => !live().messages.some((m) => m.pending), 4000);
  return live();
}

/** "Catch me up" on the open conversation: unread (default) or the last 50/100/200. */
export async function catchUp(ctx = chatCtx(), mode = 'unread') {
  if (!ctx) throw new Error('Open a conversation first.');
  openPanel(ctx);
  if (keyState() === 'none') throw new Error('Add your Anthropic API key in Settings → Assistant first.');
  if (keyState() === 'locked' && !currentKey()) throw new Error('Unlock your API key in the assistant panel first.');
  if (getSession().turns.some((t) => t.status === 'streaming')) throw new Error('Wait for the current reply to finish, or stop it.');
  const meUid = ctx.me?.uid;
  const since = getSession().unreadSince[ctx.conv?.scope] ?? 0;
  const want = mode === 'unread' ? 0 : Number(String(mode).replace(/\D/g, '')) || 50;
  const live = await loadUntil(ctx, (msgs) => {
    const usable = msgs.filter(isReadable);
    if (mode === 'unread') {
      const oldest = usable[0];
      return !oldest || (typeof oldest.ts === 'number' && oldest.ts <= since) || usable.filter((m) => m.ts > since).length >= MAX_SUMMARY_MESSAGES;
    }
    return usable.length >= want;
  });
  const sel = catchUpSelection(live.messages, { mode, since, meUid, count: want });
  if (!sel.picked.length) throw new Error('There are no messages to catch up on here yet.');
  const transcript = buildTranscript(sel.picked, { profiles: live.profiles, meUid });
  const label = mode === 'unread' && sel.unread ? `${sel.unread} unread` : `last ${sel.picked.length}`;
  return runTurn({
    display: `Catch me up on ${convShort(ctx.conv)} (${label} message${sel.picked.length === 1 && !sel.unread ? '' : 's'})`,
    content: buildCatchUp({ transcript, conv: ctx.conv, meName: ctx.me?.name, note: sel.note }),
    kind: 'catchup',
    conv: convOf(ctx),
  });
}

/** "Explain code" for a message. */
export function explainCode(m, ctx) {
  openPanel(ctx);
  const author = ctx.profiles?.[m.uid]?.name || 'Someone';
  return runTurn({
    display: `Explain the code in ${author}'s message in ${convShort(ctx.conv)}`,
    content: buildExplainCode({ m, conv: ctx.conv, authorName: author }),
    kind: 'explain',
    conv: convOf(ctx),
  });
}

/** "Summarize thread": the message, its replies and the messages it replies to. */
export async function summarizeThread(m, ctx) {
  openPanel(ctx);
  const thread = threadOf(m, ctx.messages);
  if (thread.length < 2) throw new Error('This message has no replies to summarize.');
  const transcript = buildTranscript(thread, { profiles: ctx.profiles, meUid: ctx.me?.uid });
  return runTurn({
    display: `Summarize the thread in ${convShort(ctx.conv)} (${thread.length} messages)`,
    content: buildThreadSummary({ transcript, conv: ctx.conv }),
    kind: 'thread',
    conv: convOf(ctx),
  });
}

// ---------- inline translation (messageExtras; never sent to the chat) ----------

function patchTranslation(mid, patch) {
  setSession((s) => ({ translations: { ...s.translations, [mid]: { ...(s.translations[mid] || {}), ...patch } } }));
}

export function hideTranslation(mid) {
  controllers.get(`tr:${mid}`)?.abort();
  setSession((s) => {
    const next = { ...s.translations };
    delete next[mid];
    return { translations: next };
  });
}

export async function translate(m, ctx) {
  const text = typeof m?.body?.text === 'string' ? m.body.text : '';
  if (!text.trim()) throw new Error('Nothing to translate in this message.');
  const s = getSession();
  const lang = s.prefs.lang;
  const key = `tr:${m.mid}`;
  controllers.get(key)?.abort();
  patchTranslation(m.mid, { status: 'loading', text: '', lang, error: null, note: '' });
  const apiKey = currentKey();
  if (!apiKey) {
    patchTranslation(m.mid, {
      status: 'error',
      error: { kind: keyState() === 'locked' ? 'locked' : 'nokey', message: keyState() === 'locked' ? 'Unlock your API key in the assistant panel or Settings → Assistant first.' : 'Add your Anthropic API key in Settings → Assistant first.' },
    });
    return;
  }
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  const { system, content } = buildTranslate({ text, lang, meName: ctx?.me?.name });
  let timer = null;
  let pending = '';
  try {
    const res = await streamReply({
      apiKey,
      model: s.prefs.model,
      effort: s.prefs.effort,
      system,
      messages: [{ role: 'user', content }],
      signal: ctrl.signal,
      onText: (_d, all) => {
        pending = all;
        if (!timer) timer = setTimeout(() => { timer = null; patchTranslation(m.mid, { text: pending }); }, 40);
      },
    });
    if (timer) clearTimeout(timer);
    if (res.usage) addUsage(res.usage);
    if (res.aborted) return;
    const info = stopInfo(res.stopReason, res.stopDetails);
    const refused = info.status === 'refusal';
    patchTranslation(m.mid, { status: refused ? 'refusal' : 'done', text: refused ? '' : res.text, note: info.note, model: res.model });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const d = describeError(err, err?.sdk || {});
    if (d.kind !== 'aborted') patchTranslation(m.mid, { status: 'error', error: { kind: d.kind, message: d.message } });
  } finally {
    controllers.delete(key);
  }
}

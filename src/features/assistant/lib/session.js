// In-memory assistant session for the signed-in user: the unlocked key, preferences, the panel
// conversation, inline translations, the session token counter and the workspace-level panel toggle.
// Nothing here is persisted except prefs and the key record (localStorage, see keyStore.js); a reload
// or a vault lock clears it all.
import { useSyncExternalStore } from 'react';
import { loadPrefs, loadRecord } from './keyStore.js';

const navLang = () => (typeof navigator !== 'undefined' ? navigator.language : 'en');

function blank(uid = null) {
  return {
    uid,
    record: uid ? loadRecord(uid) : null, // { mode: 'plain'|'locked', hint } or null
    apiKey: null, // usable key in memory (plain, or unlocked for this session)
    prefs: loadPrefs(uid, { navLang: navLang() }),
    usage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turns: [], // panel conversation: [{ id, role: 'user', display, content, kind, conv }, { id, role: 'assistant', text, status, ... }]
    translations: {}, // mid -> { status: 'loading'|'done'|'error'|'refusal', text, lang, error }
    panelOpen: false, // workspace-level toggle: the panel follows you between conversations
    includeContext: false, // panel: "Include last N messages" (off by default, per session)
    unreadSince: {}, // conversation scope -> read marker captured when it was opened
  };
}

let state = blank();
const listeners = new Set();

export function getSession() {
  return state;
}

export function setSession(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  if (!next || next === state) return;
  state = { ...state, ...next };
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (e) {
      console.error('[assistant] listener failed', e);
    }
  }
}

export function subscribeSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Switch to (or keep) this account's session. */
export function ensureUser(uid) {
  if (!uid || state.uid === uid) return;
  state = blank(uid);
  setSession({});
}

/** Forget everything in memory (vault lock, sign-out). The key record stays in localStorage. */
export function resetSession() {
  state = blank(null);
  setSession({});
}

/** The usable key: in memory, or a plain key from storage. null when missing or locked. */
export function currentKey() {
  if (state.apiKey) return state.apiKey;
  const rec = state.uid ? loadRecord(state.uid) : null;
  if (rec?.mode === 'plain') {
    setSession({ apiKey: rec.key, record: rec });
    return rec.key;
  }
  return null;
}

/** 'none' | 'locked' | 'ready' */
export function keyState(s = state) {
  if (s.apiKey) return 'ready';
  if (s.record?.mode === 'plain') return 'ready';
  if (s.record?.mode === 'locked') return 'locked';
  return 'none';
}

export function addUsage(usage) {
  if (!usage || typeof usage !== 'object') return;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  setSession((s) => ({
    usage: {
      requests: s.usage.requests + 1,
      input: s.usage.input + n(usage.input_tokens),
      output: s.usage.output + n(usage.output_tokens),
      cacheRead: s.usage.cacheRead + n(usage.cache_read_input_tokens),
      cacheWrite: s.usage.cacheWrite + n(usage.cache_creation_input_tokens),
    },
  }));
}

/** React: a slice of the session (selector result compared with Object.is). */
export function useSession(selector = (s) => s) {
  return useSyncExternalStore(subscribeSession, () => selector(state), () => selector(state));
}

// ---------- Chat bridge: the open conversation's ChatContext, for palette actions and hotkeys ----------

const bridge = { ctx: null, token: null };

export function setBridge(ctx, token) {
  bridge.ctx = ctx;
  bridge.token = token;
}

export function clearBridge(token) {
  if (bridge.token === token) {
    bridge.ctx = null;
    bridge.token = null;
  }
}

/** The ChatContext of the conversation on screen, or null. */
export function chatCtx() {
  return bridge.ctx;
}

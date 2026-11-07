// The add-on bridge (pure: no Firebase, no React).
//
// An add-on runs in SandboxFrame (sandbox="allow-scripts", opaque origin, CSP connect-src 'none').
// Before its code, the frame runs `addonSdk` (below), which defines `window.codehub` and opens a
// private MessageChannel: it posts ONE hello { __addon: token, hello: 1 } with the channel's second
// port to the parent. The host accepts the hello only when e.source is this exact iframe's window and
// the per-frame token matches, and only the first one; every later call and reply goes over that port.
// If the frame navigates away, its document (and the port) is gone, so a page it navigates to can
// never reach the bridge, even if it learned the token. The host also stops a frame that navigates.
//
// Frame -> host (port):  { id, method, args }            host -> frame: { re: id, ok, result | error }
// Host -> frame events:  { event: 'init' | 'theme' | 'context' | 'messages', data }
// Preview mode only:     frame -> host { log: level, args: [string] } (console output for the builder)

import { LIMITS, PERM_INFO, normalizePerms, utf8Length } from './manifest.js';

// ---------- in-frame SDK ----------

/**
 * Runs inside the sandboxed frame (serialized with Function.prototype.toString, so it must not use
 * anything from this module's scope). Defines window.codehub:
 *   ready() -> Promise<{ context, theme, perms }>     getContext() -> Promise<context>
 *   getMessages(n) -> Promise<[{ id, author, text, ts }]>   (perm readMessages)
 *   insertText(text) (perm composer)   sendMessage(text) (perm send; the user confirms)
 *   storage.get(key) / set(key, value) / remove(key) / keys()   (perm storage)
 *   theme / perms / context (latest values), getTheme(), on(event, fn) -> off(), off(event, fn)
 *   events: 'theme', 'context', 'messages' ({ count } when the conversation changes)
 */
export function addonSdk(win, token, opts) {
  'use strict';
  var P = win.parent;
  var ch = new win.MessageChannel();
  var port = ch.port1;
  var seq = 0;
  var pending = {};
  var listeners = { theme: [], context: [], messages: [] };
  var state = { theme: null, context: null, perms: [], scope: '' };
  var inited = false;
  var waiters = [];

  function applyTheme(t) {
    try {
      var root = win.document && win.document.documentElement;
      if (!t || !root) return;
      var mode = t.mode === 'light' ? 'light' : 'dark';
      root.setAttribute('data-theme', mode);
      root.style.colorScheme = mode;
      var tk = t.tokens || {};
      for (var k in tk) {
        if (Object.prototype.hasOwnProperty.call(tk, k) && typeof tk[k] === 'string') root.style.setProperty('--ch-' + k, tk[k]);
      }
    } catch (e) {
      /* a page without a document element: nothing to style */
    }
  }

  function emit(name, data) {
    var list = listeners[name];
    if (!list) return;
    list.slice().forEach(function (fn) {
      try {
        fn(data);
      } catch (e) {
        setTimeout(function () {
          throw e;
        });
      }
    });
  }

  port.onmessage = function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (typeof d.re === 'number') {
      var p = pending[d.re];
      if (!p) return;
      delete pending[d.re];
      if (d.ok) p.resolve(d.result);
      else {
        var err = new Error((d.error && d.error.message) || 'Request failed');
        err.code = (d.error && d.error.code) || 'FAILED';
        p.reject(err);
      }
      return;
    }
    var data = d.data;
    if (d.event === 'init' && data && typeof data === 'object') {
      state.perms = Array.isArray(data.perms) ? data.perms.slice() : [];
      state.theme = data.theme || null;
      state.context = data.context || null;
      state.scope = data.scope || '';
      applyTheme(state.theme);
      inited = true;
      waiters.splice(0).forEach(function (w) {
        w();
      });
    } else if (d.event === 'theme') {
      state.theme = data;
      applyTheme(data);
      emit('theme', data);
    } else if (d.event === 'context') {
      state.context = data;
      emit('context', data);
    } else if (d.event === 'messages') {
      emit('messages', data);
    }
  };

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        port.postMessage({ id: id, method: method, args: args || [] });
      } catch (e) {
        delete pending[id];
        var err = new Error('That value cannot be sent to Codehub (' + ((e && e.message) || 'not cloneable') + ')');
        err.code = 'INVALID_ARGUMENT';
        reject(err);
      }
    });
  }

  function whenInit() {
    return inited
      ? Promise.resolve()
      : new Promise(function (r) {
          waiters.push(r);
        });
  }

  var storage = Object.freeze({
    get: function (key) {
      return call('storage.get', [key]);
    },
    set: function (key, value) {
      return call('storage.set', [key, value]);
    },
    remove: function (key) {
      return call('storage.remove', [key]);
    },
    keys: function () {
      return call('storage.keys', []);
    },
  });

  var api = {
    version: 1,
    ready: function () {
      return call('ready', [])
        .then(whenInit)
        .then(function () {
          return { context: state.context, theme: state.theme, perms: state.perms.slice() };
        });
    },
    getContext: function () {
      return call('getContext', []);
    },
    getTheme: function () {
      return call('getTheme', []);
    },
    getMessages: function (n) {
      return call('getMessages', [n]);
    },
    insertText: function (text) {
      return call('insertText', [text]);
    },
    sendMessage: function (text) {
      return call('sendMessage', [text]);
    },
    storage: storage,
    on: function (name, fn) {
      if (listeners[name] && typeof fn === 'function') listeners[name].push(fn);
      return function () {
        api.off(name, fn);
      };
    },
    off: function (name, fn) {
      var list = listeners[name];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  Object.defineProperty(api, 'theme', { enumerable: true, get: function () { return state.theme; } });
  Object.defineProperty(api, 'context', { enumerable: true, get: function () { return state.context; } });
  Object.defineProperty(api, 'perms', { enumerable: true, get: function () { return state.perms.slice(); } });
  Object.freeze(api);
  Object.defineProperty(win, 'codehub', { value: api, writable: false, configurable: false, enumerable: true });

  if (opts && opts.console) {
    // Builder preview only: console output and uncaught errors go to the preview's console pane.
    var sent = 0;
    var windowStart = Date.now();
    var fmt = function (v) {
      try {
        if (typeof v === 'string') return v;
        if (v instanceof Error) return v.name + ': ' + v.message;
        if (v === undefined) return 'undefined';
        var s = JSON.stringify(v);
        return s === undefined ? String(v) : s;
      } catch (e) {
        return String(v);
      }
    };
    var log = function (level, list) {
      var now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        sent = 0;
      }
      if (++sent > 50) return;
      var out = [];
      for (var i = 0; i < list.length && i < 10; i++) out.push(fmt(list[i]).slice(0, 2000));
      try {
        port.postMessage({ log: level, args: out });
      } catch (e) {
        /* closed */
      }
    };
    ['log', 'info', 'warn', 'error'].forEach(function (level) {
      var orig = win.console && win.console[level];
      if (!win.console) return;
      win.console[level] = function () {
        log(level, Array.prototype.slice.call(arguments));
        if (orig) {
          try {
            return orig.apply(win.console, arguments);
          } catch (e) {
            /* ignore */
          }
        }
        return undefined;
      };
    });
    win.addEventListener('error', function (e) {
      log('error', ['Uncaught ' + ((e && e.message) || 'error') + (e && e.lineno ? ' (line ' + e.lineno + ')' : '')]);
    });
    win.addEventListener('unhandledrejection', function (e) {
      log('error', ['Unhandled rejection: ' + fmt(e && e.reason)]);
    });
  }

  P.postMessage({ __addon: token, hello: 1 }, '*', [ch.port2]);
}

/**
 * The document handed to SandboxFrame: the SDK first, then the add-on's own HTML. SandboxFrame
 * prepends the CSP meta before all of it.
 */
export function addonDocument(code, token, { console: withConsole = false } = {}) {
  const t = JSON.stringify(String(token || ''));
  const o = JSON.stringify({ console: !!withConsole });
  return `<script>(${addonSdk.toString()})(window,${t},${o});</script>\n${String(code ?? '')}`;
}

/** True if a window message is this frame's hello (the caller has already checked e.source). */
export const isHello = (data, token) =>
  !!data && typeof data === 'object' && data.hello === 1 && typeof token === 'string' && token.length >= 16 && data.__addon === token;

// ---------- host side ----------

/** Token bucket: `capacity` calls at once, refilled at `perSec` per second. */
export function createRateLimiter({ capacity = 30, perSec = 10 } = {}) {
  let tokens = capacity;
  let last = null;
  return {
    take(now = Date.now()) {
      if (last !== null) tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSec);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MAX_ARGS_CHARS = 70000;
const STORAGE_KEY_RE = /^[\s\S]{1,128}$/;

function needString(v, what, max) {
  if (typeof v !== 'string') throw new BridgeError('INVALID_ARGUMENT', `${what} must be a string.`);
  if (!v.trim()) throw new BridgeError('INVALID_ARGUMENT', `${what} is empty.`);
  if (v.length > max) throw new BridgeError('INVALID_ARGUMENT', `${what} is longer than ${max} characters.`);
  return v;
}

function storageKey(k) {
  if (typeof k !== 'string' || !STORAGE_KEY_RE.test(k)) throw new BridgeError('INVALID_ARGUMENT', 'Storage keys are strings of 1 to 128 characters.');
  return k;
}

/** A JSON copy of a value (rejects undefined, functions, cycles, non-finite numbers become null). */
export function jsonValue(v) {
  if (v === undefined) throw new BridgeError('INVALID_ARGUMENT', 'Storage values cannot be undefined; use storage.remove().');
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    throw new BridgeError('INVALID_ARGUMENT', 'Storage values must be JSON (no cycles).');
  }
  if (s === undefined) throw new BridgeError('INVALID_ARGUMENT', 'Storage values must be JSON.');
  return JSON.parse(s);
}

/** Bridge methods: permission needed and argument parsing. */
export const METHODS = Object.freeze({
  ready: { perm: null, parse: () => [] },
  getContext: { perm: null, parse: () => [] },
  getTheme: { perm: null, parse: () => [] },
  getMessages: {
    perm: 'readMessages',
    parse: ([n]) => {
      if (n === undefined || n === null) return [20];
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new BridgeError('INVALID_ARGUMENT', 'getMessages(n) needs a number.');
      return [Math.max(1, Math.min(LIMITS.messages, Math.floor(n)))];
    },
  },
  insertText: { perm: 'composer', parse: ([t]) => [needString(t, 'The text', LIMITS.text)] },
  sendMessage: {
    perm: 'send',
    parse: ([t]) => {
      const text = needString(t, 'The message', LIMITS.text);
      if (/^\s*\//.test(text)) throw new BridgeError('INVALID_ARGUMENT', 'Add-ons cannot run slash commands; messages may not start with “/”.');
      return [text];
    },
  },
  'storage.get': { perm: 'storage', parse: ([k]) => [storageKey(k)] },
  'storage.set': { perm: 'storage', parse: ([k, v]) => [storageKey(k), jsonValue(v)] },
  'storage.remove': { perm: 'storage', parse: ([k]) => [storageKey(k)] },
  'storage.keys': { perm: 'storage', parse: () => [] },
});

/**
 * Host-side dispatcher. handlers: { ready(), context(), theme(), messages(n), insertText(text),
 * sendMessage(text), storage(op, key, value) } (sync or async). Returns { handle(msg) } where
 * handle resolves to the reply to post back, or null for messages that aren't calls.
 * Calls are rate-limited (token bucket) and sendMessage additionally to one per `sendGapMs`.
 */
export function createBridgeHost({ perms, handlers, limiter = createRateLimiter(), sendGapMs = 3000, now = () => Date.now() }) {
  const granted = new Set(normalizePerms(perms));
  let lastSend = -Infinity;
  const fail = (id, code, message) => ({ re: id, ok: false, error: { code, message } });

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || !Number.isInteger(msg.id) || msg.id < 1 || typeof msg.method !== 'string') return null;
    const { id, method } = msg;
    const spec = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
    if (!spec) return fail(id, 'UNKNOWN_METHOD', `codehub has no method “${String(method).slice(0, 40)}”.`);
    if (!limiter.take(now())) return fail(id, 'RATE_LIMITED', 'Too many requests. Slow down and try again.');
    if (spec.perm && !granted.has(spec.perm)) {
      return fail(id, 'PERMISSION_DENIED', `This add-on doesn’t have the “${PERM_INFO[spec.perm].label}” permission.`);
    }
    const args = Array.isArray(msg.args) ? msg.args : [];
    let parsed;
    try {
      if (JSON.stringify(args).length > MAX_ARGS_CHARS) throw new BridgeError('INVALID_ARGUMENT', 'That request is too large.');
      parsed = spec.parse(args);
    } catch (e) {
      return fail(id, e instanceof BridgeError ? e.code : 'INVALID_ARGUMENT', e?.message || 'Invalid arguments.');
    }
    if (method === 'sendMessage') {
      const t = now();
      if (t - lastSend < sendGapMs) return fail(id, 'RATE_LIMITED', 'Add-ons can send at most one message every few seconds.');
      lastSend = t;
    }
    try {
      let result;
      switch (method) {
        case 'ready': result = await handlers.ready?.(); break;
        case 'getContext': result = await handlers.context(); break;
        case 'getTheme': result = await handlers.theme(); break;
        case 'getMessages': result = await handlers.messages(parsed[0]); break;
        case 'insertText': result = await handlers.insertText(parsed[0]); break;
        case 'sendMessage': result = await handlers.sendMessage(parsed[0]); break;
        default: result = await handlers.storage(method.slice(8), ...parsed); break;
      }
      return { re: id, ok: true, result: result === undefined ? null : result };
    } catch (e) {
      return fail(id, typeof e?.code === 'string' && /^[A-Z_]{2,40}$/.test(e.code) ? e.code : 'FAILED', String(e?.message || 'Request failed').slice(0, 300));
    }
  }
  return { handle };
}

// ---------- storage model ----------

/** Plaintext size of a storage map (UTF-8 JSON). */
export const storageSize = (map) => utf8Length(JSON.stringify(map || {}));

/**
 * Apply one storage op to a map. Returns { map, result, changed }. Throws BridgeError('QUOTA_EXCEEDED')
 * when a set would grow the map past LIMITS.storageBytes.
 */
export function applyStorageOp(map, op, key, value) {
  const cur = map && typeof map === 'object' ? map : {};
  const has = Object.prototype.hasOwnProperty.call(cur, key ?? '');
  if (op === 'get') return { map: cur, result: has ? cur[key] : null, changed: false };
  if (op === 'keys') return { map: cur, result: Object.keys(cur).sort(), changed: false };
  if (op === 'remove') {
    if (!has) return { map: cur, result: false, changed: false };
    const next = { ...cur };
    delete next[key];
    return { map: next, result: true, changed: true };
  }
  if (op === 'set') {
    const next = { ...cur, [key]: value };
    const size = storageSize(next);
    if (size > LIMITS.storageBytes) {
      throw new BridgeError('QUOTA_EXCEEDED', `Storage is limited to ${LIMITS.storageBytes / 1024} KB per add-on (this would use ${Math.ceil(size / 1024)} KB).`);
    }
    return { map: next, result: true, changed: true };
  }
  throw new BridgeError('UNKNOWN_METHOD', 'Unknown storage operation.');
}

// ---------- data the bridge hands out ----------

/**
 * Chat messages (ChatContext.messages) -> the add-on's view: the last `n` visible, decrypted
 * messages as { id, author, text, ts }. Deleted, pending and undecryptable messages are skipped.
 */
export function toAddonMessages(messages, profiles, n = 20) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of list) {
    if (!m || m.deleted || m.error || m.pending || !m.body || typeof m.body !== 'object') continue;
    let text = typeof m.body.text === 'string' ? m.body.text : '';
    const code = m.body.code;
    if (code && typeof code.content === 'string' && code.content) {
      const lang = typeof code.lang === 'string' ? code.lang.replace(/[^\w+-]/g, '').slice(0, 20) : '';
      text = `${text ? `${text}\n` : ''}\`\`\`${lang}\n${code.content}\n\`\`\``;
    }
    if (!text) continue;
    const p = profiles && typeof profiles === 'object' ? profiles[m.uid] : null;
    out.push({
      id: String(m.mid || ''),
      author: typeof p?.name === 'string' && p.name ? p.name : 'Unknown',
      text: text.slice(0, 8000),
      ts: typeof m.ts === 'number' ? m.ts : 0,
    });
  }
  return out.slice(-Math.max(1, Math.min(LIMITS.messages, n)));
}

/** The conversation as an add-on sees it: { kind, name, me: { name }, scope }. */
export function toAddonContext(conv, me, scope) {
  return {
    kind: ['channel', 'dm', 'group'].includes(conv?.kind) ? conv.kind : 'preview',
    name: typeof conv?.name === 'string' ? conv.name.slice(0, 100) : '',
    me: { name: typeof me?.name === 'string' ? me.name.slice(0, 64) : '' },
    scope: scope === 'server' ? 'server' : scope === 'preview' ? 'preview' : 'personal',
  };
}

/** App design tokens exposed to add-ons as --ch-<name> (e.g. --ch-bg-2, --ch-accent). */
export const THEME_TOKENS = Object.freeze([
  'bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-hover', 'border', 'text', 'text-dim', 'text-faint',
  'accent', 'accent-2', 'ok', 'warn', 'danger',
]);

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\))$/;

/** { mode, tokens } from a getPropertyValue(name) function; only plain colors pass. */
export function readTheme(getValue, mode) {
  const tokens = {};
  for (const name of THEME_TOKENS) {
    let v = '';
    try {
      v = String(getValue(`--${name}`) || '').trim();
    } catch {
      v = '';
    }
    if (COLOR_RE.test(v)) tokens[name] = v;
  }
  return { mode: mode === 'light' ? 'light' : 'dark', tokens };
}

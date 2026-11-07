// The "play" sandbox profile: games (Arcade player, publish test run), the codespace live preview and
// chat "Run" snippets. See src/lib/sandbox.js for the shared model and the "strict" profile that
// add-ons keep.
//
// Same opaque-origin iframe (sandbox="allow-scripts …", srcdoc, no allow-same-origin), but the CSP
// lets games do what ordinary web games do:
//   - load libraries from pinned public CDN paths that serve fixed package files and cannot proxy an
//     arbitrary origin (jsDelivr /npm/ and /pyodide/, cdnjs /ajax/libs/, unpkg) and Google Fonts;
//   - eval / new Function / WebAssembly (no new capability inside an opaque origin, needed by
//     Babel-in-the-browser, Alpine, Pyodide …);
//   - fetch data:/blob: URLs and the CDN paths above; nothing else on the network.
// A small compatibility runtime runs before any user script (playRuntime): working
// localStorage/sessionStorage/document.cookie (in memory; persisted per Arcade game through the
// parent), non-blocking alert/confirm/prompt, and error/CSP-violation reports to the parent.

export const PLAY_SANDBOX = 'allow-scripts allow-pointer-lock';
// "*": Firefox and WebKit don't match a srcdoc frame against the default 'src' allowlist.
export const PLAY_ALLOW = 'fullscreen *; gamepad *; autoplay *';

/** URL prefixes a play document may load code, styles, images, fonts and media from. */
export const CDN_PREFIXES = ['https://cdn.jsdelivr.net/npm/', 'https://cdnjs.cloudflare.com/ajax/libs/', 'https://unpkg.com/'];
export const PYODIDE_PREFIX = 'https://cdn.jsdelivr.net/pyodide/';
export const FONT_CSS_URLS = ['https://fonts.googleapis.com/css', 'https://fonts.googleapis.com/css2'];
export const FONT_FILES_PREFIX = 'https://fonts.gstatic.com/s/';

const CDN = CDN_PREFIXES.join(' ');

export const PLAY_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: ${CDN} ${PYODIDE_PREFIX}`,
  `style-src 'unsafe-inline' blob: data: ${CDN} ${FONT_CSS_URLS.join(' ')}`,
  `img-src data: blob: ${CDN}`,
  `font-src data: blob: ${CDN} ${FONT_FILES_PREFIX}`,
  `media-src data: blob: ${CDN}`,
  `connect-src data: blob: ${CDN} ${PYODIDE_PREFIX}`,
  'worker-src blob: data:',
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** Per-game localStorage (and sessionStorage) budget, in characters of keys + values. */
export const SAVE_MAX_CHARS = 512 * 1024;
export const SAVE_MAX_KEYS = 5000;

/**
 * Would the play CSP let a document load `url` as a script ('script') or stylesheet ('style')?
 * Mirrors the CSP source lists above (scheme + host + path prefix; exact path for the font CSS).
 */
export function isAllowedUrl(url, kind = 'script') {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'https:') return false;
  const bare = `${u.origin}${u.pathname}`;
  if (CDN_PREFIXES.some((p) => bare.startsWith(p))) return true;
  if (kind === 'script') return bare.startsWith(PYODIDE_PREFIX);
  if (kind === 'style') return FONT_CSS_URLS.includes(bare);
  if (kind === 'font') return bare.startsWith(FONT_FILES_PREFIX);
  return false;
}

// esm.sh / Skypack build packages on their servers (esm.sh can build from any GitHub repo or URL),
// so they are not on the allowlist. Their plain "package@version[/subpath]" URLs have an exact
// jsDelivr equivalent, which the bundler substitutes.
const ESM_HOST = /^https?:\/\/(?:esm\.sh|cdn\.skypack\.dev)\/((?:@[\w.-]+\/)?[\w.-]+)(?:@([\w.^~<>=*-]+))?(\/[^?#]*)?(?:[?#].*)?$/i;
const JQUERY = /^https?:\/\/code\.jquery\.com\/jquery-(\d+\.\d+\.\d+)((?:\.slim)?(?:\.min)?)\.js(?:[?#].*)?$/i;

/** The allowed equivalent of a well-known CDN URL, or the URL unchanged. */
export function rewriteCdnUrl(url) {
  const s = String(url || '').trim();
  let m = ESM_HOST.exec(s);
  if (m) {
    const [, name, ver, sub] = m;
    // esm.sh build paths (/v135/…, /es2022/…, *.mjs bundles) have no npm equivalent: leave them.
    if (/^v\d+$/.test(name) || (sub && /^\/(?:es20\d\d|esnext|denonext|deno|node)\//.test(sub))) return s;
    const path = sub && sub !== '/' ? sub.replace(/\/+$/, '') : '';
    return `https://cdn.jsdelivr.net/npm/${name}${ver ? `@${ver}` : ''}${path}/+esm`;
  }
  m = JQUERY.exec(s);
  if (m) return `https://cdn.jsdelivr.net/npm/jquery@${m[1]}/dist/jquery${m[2] || ''}.js`;
  // http:// on an allowed CDN (mixed content would be blocked anyway).
  if (/^http:\/\//i.test(s)) {
    const https = `https://${s.slice(7)}`;
    if (isAllowedUrl(https, 'script') || isAllowedUrl(https, 'style')) return https;
  }
  return s;
}

/** JSON that is safe inside <script>…</script> (no "</script", "<!--", U+2028/9). */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Validate a storage snapshot a frame sent ({ key: value } of strings). Returns a clean copy, or null
 * when it isn't a plain object of strings or exceeds the budget.
 */
export function cleanStorageSnapshot(data, max = SAVE_MAX_CHARS) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  let used = 0;
  let count = 0;
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (typeof v !== 'string') return null;
    used += k.length + v.length;
    count += 1;
    if (used > max || count > SAVE_MAX_KEYS) return null;
    out[k] = v;
  }
  return out;
}

/** The string entries of `data` that fit the budget (initial contents handed to a frame). */
function stringEntries(data, max = SAVE_MAX_CHARS) {
  const out = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  let used = 0;
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (typeof v !== 'string' || used + k.length + v.length > max) continue;
    used += k.length + v.length;
    out[k] = v;
  }
  return out;
}

/** Characters used by a snapshot (keys + values). */
export function snapshotChars(data) {
  let n = 0;
  for (const k of Object.keys(data || {})) n += k.length + String(data[k]).length;
  return n;
}

// ---------- the in-frame runtime ----------

// Runs inside the sandboxed frame, before any user script. ES5 only and self-contained: it is
// serialised with Function.prototype.toString and must not reference anything outside itself.
/* eslint-disable no-var, prefer-arrow-callback, func-names, object-shorthand */
function playRuntime(C) {
  'use strict';
  var W = window;
  var D = document;
  var P = W.parent;
  var MAX = C.max;
  var inst = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function post(m) {
    m.__sbx = C.t;
    try {
      P.postMessage(m, '*');
    } catch (e) {
      /* parent gone */
    }
  }
  function str(v) {
    try {
      return String(v);
    } catch (e) {
      return '[unprintable]';
    }
  }
  post({ kind: 'hello', inst: inst });

  // ---- notices: non-blocking stand-ins for alert / confirm / prompt ----
  var host = null;
  var root = null;
  function notice(label, text) {
    text = str(text);
    if (text.length > 600) text = text.slice(0, 600) + '\u2026';
    try {
      console.info('[' + label + '] ' + text);
    } catch (e) {
      /* console replaced */
    }
    try {
      if (!host) {
        host = D.createElement('codehub-notice');
        root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
        var st = D.createElement('style');
        st.textContent =
          ':host{all:initial;position:fixed;z-index:2147483647;top:10px;left:50%;transform:translateX(-50%);display:flex;' +
          'flex-direction:column;gap:6px;width:max-content;max-width:min(92vw,520px);pointer-events:none}' +
          '.n{pointer-events:auto;cursor:pointer;padding:9px 13px;border-radius:9px;background:rgba(17,20,28,.95);color:#f3f5f9;' +
          'font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4);white-space:pre-wrap;' +
          'overflow-wrap:anywhere;unicode-bidi:plaintext;text-align:start}' +
          '.k{display:block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#9aa3b5;margin-bottom:2px}';
        root.appendChild(st);
      }
      if (!host.isConnected) (D.body || D.documentElement).appendChild(host);
      var el = D.createElement('div');
      el.className = 'n';
      el.setAttribute('role', 'status');
      var k = D.createElement('span');
      k.className = 'k';
      k.textContent = label;
      el.appendChild(k);
      el.appendChild(D.createTextNode(text));
      el.onclick = function () {
        el.remove();
      };
      root.appendChild(el);
      var items = root.querySelectorAll('.n');
      if (items.length > 3) items[0].remove();
      setTimeout(function () {
        el.remove();
      }, 5000);
    } catch (e) {
      /* no DOM yet or a hostile page: the console line is enough */
    }
  }
  W.alert = function (m) {
    notice('Message', m === undefined ? '' : m);
  };
  W.confirm = function (m) {
    notice('Confirmed automatically (OK)', m === undefined ? '' : m);
    return true;
  };
  W.prompt = function (m, d) {
    var v = d === undefined || d === null ? '' : str(d);
    notice(v ? 'Prompt answered with its default: ' + v : 'Prompt skipped (no text input here)', m === undefined ? '' : m);
    return v;
  };
  W.print = function () {};

  // ---- storage: an in-memory Storage per area, persisted through the parent when C.persist ----
  function quota() {
    try {
      return new DOMException('This game used up its ' + Math.round(MAX / 1024) + ' KB of storage.', 'QuotaExceededError');
    } catch (e) {
      var err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      return err;
    }
  }
  function makeStorage(area, init) {
    var m = new Map();
    var used = 0;
    var timer = 0;
    var lastPost = 0;
    var dirty = false;
    if (init && typeof init === 'object') {
      Object.keys(init).forEach(function (key) {
        if (typeof init[key] === 'string') {
          m.set(key, init[key]);
          used += key.length + init[key].length;
        }
      });
    }
    function flush() {
      timer = 0;
      if (!dirty) return;
      dirty = false;
      lastPost = Date.now();
      var o = {};
      m.forEach(function (v, key) {
        o[key] = v;
      });
      post({ kind: 'storage', area: area, data: o });
    }
    function changed() {
      if (!C.persist) return;
      dirty = true;
      if (!timer) timer = setTimeout(flush, Math.max(0, 100 - (Date.now() - lastPost)));
    }
    if (C.persist) {
      W.addEventListener('pagehide', flush);
    }
    var api = {
      getItem: function (key) {
        key = str(key);
        return m.has(key) ? m.get(key) : null;
      },
      setItem: function (key, value) {
        key = str(key);
        value = str(value);
        var prev = m.has(key) ? key.length + m.get(key).length : 0;
        var next = used - prev + key.length + value.length;
        if (next > MAX || (!prev && m.size >= C.maxKeys)) throw quota();
        used = next;
        m.set(key, value);
        changed();
      },
      removeItem: function (key) {
        key = str(key);
        if (!m.has(key)) return;
        used -= key.length + m.get(key).length;
        m.delete(key);
        changed();
      },
      clear: function () {
        if (!m.size) return;
        m.clear();
        used = 0;
        changed();
      },
      key: function (i) {
        var a = Array.from(m.keys());
        i = Math.floor(Number(i)) || 0;
        return i >= 0 && i < a.length ? a[i] : null;
      },
    };
    // Named-property access like the real Storage: localStorage.best, localStorage['best'] = 3,
    // 'best' in localStorage, delete localStorage.best, Object.keys / JSON.stringify(localStorage).
    return new Proxy(api, {
      get: function (t, p) {
        if (p === 'length') return m.size;
        if (typeof p !== 'string' || p in t) return t[p];
        return m.has(p) ? m.get(p) : undefined;
      },
      set: function (t, p, v) {
        if (typeof p === 'string' && p !== 'length' && !(p in t)) api.setItem(p, v);
        return true;
      },
      has: function (t, p) {
        return (typeof p === 'string' && m.has(p)) || p in t;
      },
      deleteProperty: function (t, p) {
        if (typeof p === 'string') api.removeItem(p);
        return true;
      },
      ownKeys: function () {
        return Array.from(m.keys());
      },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === 'string' && m.has(p)) return { value: m.get(p), writable: true, enumerable: true, configurable: true };
        return undefined;
      },
    });
  }
  function install(name, value) {
    var works = false;
    try {
      works = !!W[name] && typeof W[name].getItem === 'function';
    } catch (e) {
      works = false;
    }
    if (works) return;
    try {
      Object.defineProperty(W, name, { value: value(), configurable: true, enumerable: true, writable: false });
    } catch (e) {
      /* can't shadow it: the game sees the browser's own error */
    }
  }
  install('localStorage', function () {
    return makeStorage('local', C.local);
  });
  install('sessionStorage', function () {
    return makeStorage('session', C.session);
  });
  // document.cookie throws in an opaque origin; keep an in-memory jar for this run.
  var cookieWorks = true;
  try {
    D.cookie = D.cookie; // eslint-disable-line no-self-assign
  } catch (e) {
    cookieWorks = false;
  }
  if (!cookieWorks) {
    try {
      var jar = new Map();
      Object.defineProperty(D, 'cookie', {
        configurable: true,
        get: function () {
          var a = [];
          jar.forEach(function (v, key) {
            a.push(key ? key + '=' + v : v);
          });
          return a.join('; ');
        },
        set: function (v) {
          var s = str(v);
          var first = s.split(';')[0];
          var i = first.indexOf('=');
          var key = i < 0 ? '' : first.slice(0, i).trim();
          var val = i < 0 ? first.trim() : first.slice(i + 1).trim();
          var age = /;\s*max-age\s*=\s*(-?\d+)/i.exec(s);
          var exp = /;\s*expires\s*=\s*([^;]+)/i.exec(s);
          if ((age && Number(age[1]) <= 0) || (exp && Date.parse(exp[1]) < Date.now())) jar.delete(key);
          else jar.set(key, val);
        },
      });
    } catch (e) {
      /* leave the browser's behaviour */
    }
  }

  // ---- errors and blocked loads ----
  var sent = 0;
  var seen = {};
  function report(kind, o) {
    if (sent >= 20) return;
    var id = kind + '|' + (o.url || o.message);
    if (seen[id]) return;
    seen[id] = 1;
    sent += 1;
    if (C.preview) {
      try {
        console.error(o.message || '');
      } catch (e) {
        /* ignore */
      }
      return;
    }
    o.kind = kind;
    post(o);
  }
  D.addEventListener('securitypolicyviolation', function (e) {
    var u = str(e.blockedURI || '');
    var d = str(e.effectiveDirective || e.violatedDirective || '');
    report('blocked', {
      url: u.slice(0, 500),
      directive: d.slice(0, 60),
      message: 'Blocked by the sandbox (' + d + '): ' + (u || 'inline code'),
    });
  });
  W.addEventListener(
    'error',
    function (e) {
      var t = e && e.target;
      if (t && t !== W && t.nodeType === 1) {
        var u = str(t.src || t.href || '').slice(0, 500);
        // A load the CSP refused also fires a securitypolicyviolation event (more precise): wait for it.
        if (u) {
          setTimeout(function () {
            report('blocked', { url: u, directive: 'load', message: 'Could not load ' + u });
          }, 60);
        }
        return;
      }
      if (C.preview) return; // the console bridge reports script errors
      var m = (e && e.message) || 'Script error';
      if (e && e.lineno) m += ' (line ' + e.lineno + (e.colno ? ':' + e.colno : '') + ')';
      report('error', { message: str(m).slice(0, 1000) });
    },
    true,
  );
  if (!C.preview) {
    W.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      var m = r && typeof r === 'object' && 'message' in r ? (r.name || 'Error') + ': ' + r.message : str(r);
      report('error', { message: ('Unhandled promise rejection: ' + m).slice(0, 1000) });
    });
  }

  // A small, stable hook for runtimes built on top (language runners): show a notice in the frame.
  try {
    Object.defineProperty(W, '__codehub', {
      value: Object.freeze({ version: 1, persistent: !!C.persist, notice: notice }),
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (e) {
    /* ignore */
  }
}
/* eslint-enable no-var, prefer-arrow-callback, func-names, object-shorthand */

export const RUNTIME_SOURCE = playRuntime.toString();

/**
 * The <script> injected first into every play document.
 *   token    per-render token (messages to the parent carry it)
 *   mode     'game' (errors posted to the parent) | 'preview' (errors go to the console bridge)
 *   storage  { persist: bool, local: {k: v}, session: {k: v} } initial contents
 */
export function playRuntimeScript({ token, mode = 'game', storage = null } = {}) {
  const cfg = {
    t: String(token || ''),
    preview: mode === 'preview',
    persist: !!storage?.persist,
    max: SAVE_MAX_CHARS,
    maxKeys: SAVE_MAX_KEYS,
    local: stringEntries(storage?.local),
    session: stringEntries(storage?.session),
  };
  return `<script>(${RUNTIME_SOURCE})(${jsonForScript(cfg)});</` + 'script>';
}

/**
 * Parse a runtime message from a play frame (already checked for source + token by the caller).
 * Returns { kind: 'hello', inst } | { kind: 'storage', area, data } | { kind: 'error', message } |
 * { kind: 'blocked', url, directive, message } | null.
 */
export function readRuntimeMessage(d) {
  if (!d || typeof d !== 'object' || typeof d.kind !== 'string') return null;
  const s = (v, n) => String(v ?? '').slice(0, n);
  if (d.kind === 'hello') return { kind: 'hello', inst: s(d.inst, 64) };
  if (d.kind === 'storage') {
    if (d.area !== 'local' && d.area !== 'session') return null;
    const data = cleanStorageSnapshot(d.data);
    return data ? { kind: 'storage', area: d.area, data } : null;
  }
  if (d.kind === 'error') return { kind: 'error', message: s(d.message, 1000) };
  if (d.kind === 'blocked') return { kind: 'blocked', url: s(d.url, 500), directive: s(d.directive, 60), message: s(d.message, 700) };
  return null;
}

// The add-on runtime (version 2): add-on code never runs in a document.
//
// Why: a sandboxed frame can always navigate itself, and CSP can't stop that, so code running in a
// document that holds decrypted messages could leak them in a URL. Workers have no DOM and can't
// navigate, and a worker started from a blob: URL inherits the frame's Content-Security-Policy.
//
// Layout:
//   app page ── SandboxFrame (sandbox="allow-scripts", opaque origin, CSP connect-src 'none')
//                 └─ frame document: ONLY our scripts (DOMPurify + hostScript below), pinned by
//                    sha256 hashes in a second CSP meta that also sets worker-src blob:.
//                      └─ dedicated Worker (blob:): workerSdk + the add-on's code
// The add-on draws by calling codehub.ui.render(html); hostScript sanitizes that HTML (no scripts,
// links, forms that submit, frames, meta/base/link, URL attributes) and patches it into the frame.
// Elements with data-on="click|input|change|submit" and data-id forward those events to the worker.
//
// Messages:
//   app ⇄ host (private MessageChannel, bound by the hello {__addon: token, hello: 1}):
//     app → host  { event: 'start', src, offset }  then { event: 'init'|'theme'|'context'|'messages', data }
//                 and call replies { re, ok, result|error }
//     host → app  calls { id, method, args } (relayed from the worker), preview logs { log, args }
//   host ⇄ worker (worker.postMessage):
//     worker → host  { up: 1 } | { render: html } | { id, method, args } | { log, args }
//     host → worker  everything the app sent except 'start', plus { event: 'ui', data: {type, id, value?, checked?} }
// The app side (AddonFrame + createBridgeHost in bridge.js) checks permissions, validates and
// rate-limits every call exactly as before; the host only relays.

import { RUNTIME_VERSION } from './manifest.js';

export { RUNTIME_VERSION };

/** Largest HTML string one codehub.ui.render() call may pass (characters). */
export const MAX_UI_HTML = 262144;

// ---------- in-frame host (runs in the sandboxed document) ----------

/**
 * Runs inside the sandboxed frame after DOMPurify (serialized with Function.prototype.toString, so
 * it must not use anything from this module's scope). Reads its token from
 * <meta name="codehub-addon">, opens the private channel to the app, starts the add-on worker once
 * the app sends its code, renders sanitized UI and forwards UI events.
 */
export function hostScript() {
  'use strict';
  var doc = document;
  var meta = doc.querySelector('meta[name="codehub-addon"]');
  var token = meta ? String(meta.getAttribute('content') || '') : '';
  if (meta) meta.parentNode.removeChild(meta);
  var purify = window.DOMPurify;
  var root = doc.createElement('div');
  root.className = 'ch-root';
  doc.body.appendChild(root);

  var MAX_HTML = 262144;
  var ch = new MessageChannel();
  var port = ch.port1;
  var worker = null;
  var started = false;
  var stopped = false;
  var rendered = false;
  var queue = [];
  var lineOffset = 0;
  var pendingHtml = null;
  var frameQueued = false;
  var states = new WeakMap();

  // Declarative UI only: no scripts or event handler attributes (DOMPurify's defaults), nothing that
  // navigates, submits, embeds or loads another document, and no URL attributes except data:/blob:
  // images and media (the CSP blocks any network load anyway).
  var CONFIG = {
    RETURN_DOM_FRAGMENT: true,
    FORCE_BODY: true,
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['a', 'area', 'base', 'link', 'meta', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe', 'script', 'noscript', 'template'],
    FORBID_ATTR: ['href', 'xlink:href', 'action', 'formaction', 'formtarget', 'target', 'ping', 'srcset', 'imagesrcset', 'srcdoc', 'background', 'poster', 'longdesc', 'usemap', 'codebase', 'data', 'manifest', 'autofocus'],
    ALLOWED_URI_REGEXP: /^(?:blob:|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  };

  function message(text, isError) {
    root.textContent = '';
    var p = doc.createElement('p');
    p.className = isError ? 'ch-msg err' : 'ch-msg';
    if (isError) p.setAttribute('role', 'alert');
    p.textContent = text;
    root.appendChild(p);
  }

  function toApp(msg) {
    try {
      port.postMessage(msg);
    } catch (e) {
      /* closed */
    }
  }

  function stop(text) {
    stopped = true;
    if (worker) {
      try {
        worker.terminate();
      } catch (e) {
        /* already gone */
      }
      worker = null;
    }
    message(text, true);
    toApp({ log: 'error', args: [text] });
  }

  // ----- theme: --ch-* variables and data-theme on <html> -----
  function applyTheme(t) {
    if (!t || typeof t !== 'object') return;
    var el = doc.documentElement;
    var mode = t.mode === 'light' ? 'light' : 'dark';
    el.setAttribute('data-theme', mode);
    el.style.colorScheme = mode;
    var tk = t.tokens && typeof t.tokens === 'object' ? t.tokens : {};
    for (var k in tk) {
      if (Object.prototype.hasOwnProperty.call(tk, k) && /^[a-z0-9-]{1,24}$/.test(k) && typeof tk[k] === 'string') el.style.setProperty('--ch-' + k, tk[k]);
    }
  }

  // ----- rendering: sanitize, then patch the live tree so focus, caret and typed input survive -----
  var USER_STATE = { value: 1, checked: 1, selected: 1, open: 1 };

  function snap(el) {
    return {
      value: el.getAttribute('value'),
      checked: el.hasAttribute('checked'),
      selected: el.hasAttribute('selected'),
      open: el.hasAttribute('open'),
      text: el.nodeName === 'TEXTAREA' ? el.textContent : null,
    };
  }

  function remember(node) {
    if (node.nodeType !== 1) return;
    states.set(node, snap(node));
    var all = node.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) states.set(all[i], snap(all[i]));
  }

  function keyOf(n) {
    return n.nodeType === 1 ? n.getAttribute('data-key') || n.getAttribute('id') || '' : '';
  }

  function same(a, b) {
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
  }

  function setFlag(el, name, on) {
    if (on) el.setAttribute(name, '');
    else el.removeAttribute(name);
  }

  function syncAttributes(from, to) {
    var i, a;
    for (i = from.attributes.length - 1; i >= 0; i--) {
      a = from.attributes[i];
      if (USER_STATE[a.name] && !a.namespaceURI) continue;
      if (a.namespaceURI ? !to.hasAttributeNS(a.namespaceURI, a.localName) : !to.hasAttribute(a.name)) {
        if (a.namespaceURI) from.removeAttributeNS(a.namespaceURI, a.localName);
        else from.removeAttribute(a.name);
      }
    }
    for (i = 0; i < to.attributes.length; i++) {
      a = to.attributes[i];
      if (USER_STATE[a.name] && !a.namespaceURI) continue;
      if (a.namespaceURI) {
        if (from.getAttributeNS(a.namespaceURI, a.localName) !== a.value) from.setAttributeNS(a.namespaceURI, a.name, a.value);
      } else if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
    }
  }

  function patch(from, to) {
    if (from.nodeType !== 1) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    var prev = states.get(from) || snap(from);
    var next = snap(to);
    syncAttributes(from, to);
    // What the user can change (typed value, ticks, open <details>) is only overwritten when the
    // add-on renders a different value than it rendered last time.
    if (prev.value !== next.value) {
      if (next.value === null) from.removeAttribute('value');
      else from.setAttribute('value', next.value);
      if (from.nodeName === 'INPUT') from.value = next.value === null ? '' : next.value;
    }
    if (prev.checked !== next.checked) {
      setFlag(from, 'checked', next.checked);
      if (from.nodeName === 'INPUT') from.checked = next.checked;
    }
    if (prev.selected !== next.selected) {
      setFlag(from, 'selected', next.selected);
      if (from.nodeName === 'OPTION') from.selected = next.selected;
    }
    if (prev.open !== next.open) setFlag(from, 'open', next.open);
    states.set(from, next);
    if (from.nodeName === 'TEXTAREA') {
      if (prev.text !== next.text) {
        from.textContent = next.text;
        from.value = next.text;
      }
      return;
    }
    patchChildren(from, to);
  }

  function patchChildren(from, to) {
    var next = Array.prototype.slice.call(to.childNodes);
    var i = 0;
    for (var j = 0; j < next.length; j++) {
      var t = next[j];
      var cur = from.childNodes[i] || null;
      if (cur && same(cur, t)) {
        patch(cur, t);
        i++;
        continue;
      }
      var match = null;
      if (keyOf(t)) {
        for (var m = i + 1; m < from.childNodes.length; m++) {
          if (same(from.childNodes[m], t)) {
            match = from.childNodes[m];
            break;
          }
        }
      }
      if (match) {
        from.insertBefore(match, cur);
        patch(match, t);
      } else {
        remember(t);
        from.insertBefore(t, cur);
      }
      i++;
    }
    while (from.childNodes.length > i) from.removeChild(from.lastChild);
  }

  function flushRender() {
    frameQueued = false;
    if (stopped || pendingHtml === null) return;
    var html = pendingHtml;
    pendingHtml = null;
    var frag;
    try {
      frag = purify.sanitize(html, CONFIG);
    } catch (e) {
      toApp({ log: 'error', args: ['codehub.ui.render: could not render that HTML (' + ((e && e.message) || 'error') + ')'] });
      return;
    }
    if (!rendered) root.textContent = '';
    rendered = true;
    patchChildren(root, frag);
  }

  function render(html) {
    if (html.length > MAX_HTML) {
      toApp({ log: 'error', args: ['codehub.ui.render: the HTML is longer than ' + MAX_HTML + ' characters.'] });
      return;
    }
    pendingHtml = html;
    if (frameQueued) return;
    frameQueued = true;
    // At most one render per frame: a busy add-on can't keep the page's main thread rendering.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushRender);
    else setTimeout(flushRender, 16);
  }

  // ----- UI events -> worker -----
  function formValues(form) {
    var out = {};
    var els = form.elements;
    for (var i = 0; i < els.length && i < 200; i++) {
      var el = els[i];
      var name = el.name;
      if (!name || el.disabled) continue;
      var type = String(el.type || '').toLowerCase();
      if (/^(submit|button|reset|image|file)$/.test(type)) continue;
      if (type === 'checkbox') out[name] = !!el.checked;
      else if (type === 'radio') {
        if (el.checked) out[name] = String(el.value).slice(0, 20000);
        else if (!Object.prototype.hasOwnProperty.call(out, name)) out[name] = null;
      } else out[name] = String(el.value == null ? '' : el.value).slice(0, 20000);
    }
    return out;
  }

  function forward(type, el) {
    if (!worker || stopped) return;
    var data = { type: type, id: String(el.getAttribute('data-id') || '').slice(0, 128) };
    if (type === 'submit' && el.nodeName === 'FORM') data.value = formValues(el);
    else if (/^(INPUT|SELECT|TEXTAREA|BUTTON|OPTION)$/.test(el.nodeName)) data.value = String(el.value == null ? '' : el.value).slice(0, 20000);
    var kind = String(el.type || '').toLowerCase();
    if (el.nodeName === 'INPUT' && (kind === 'checkbox' || kind === 'radio')) data.checked = !!el.checked;
    try {
      worker.postMessage({ event: 'ui', data: data });
    } catch (err) {
      /* gone */
    }
  }

  function wants(el, type) {
    return String(el.getAttribute('data-on') || '').split(/\s+/).indexOf(type) >= 0;
  }

  // A sandboxed frame never submits forms (no allow-forms) and so never fires 'submit'; a submit
  // button click or Enter in a text field is turned into a 'submit' UI event for the form instead.
  function submitForm(form) {
    if (form && root.contains(form) && wants(form, 'submit')) forward('submit', form);
  }

  function onUiEvent(e) {
    var type = e.type;
    if (type === 'submit') e.preventDefault();
    var el = e.target;
    while (el && el !== root && el.nodeType === 1 && !wants(el, type)) el = el.parentNode;
    if (el && el !== root && el.nodeType === 1) forward(type, el);
    if (type !== 'click') return;
    for (var b = e.target; b && b !== root && b.nodeType === 1; b = b.parentNode) {
      var kind = String(b.type || '').toLowerCase();
      if ((b.nodeName === 'BUTTON' || b.nodeName === 'INPUT') && (kind === 'submit' || kind === 'image')) {
        e.preventDefault();
        submitForm(b.form);
        return;
      }
    }
  }

  function onKey(e) {
    var t = e.target;
    if (e.key !== 'Enter' || e.isComposing || !t || t.nodeName !== 'INPUT' || !t.form) return;
    if (/^(checkbox|radio|button|submit|reset|image|file|range|color)$/.test(String(t.type || '').toLowerCase())) return;
    e.preventDefault();
    submitForm(t.form);
  }

  ['click', 'input', 'change', 'submit'].forEach(function (type) {
    root.addEventListener(type, onUiEvent, true);
  });
  root.addEventListener('keydown', onKey, true);

  // ----- worker -----
  function fromWorker(e) {
    var d = e.data;
    if (stopped || !d || typeof d !== 'object') return;
    if (typeof d.render === 'string') render(d.render);
    else if (typeof d.id === 'number' && typeof d.method === 'string') toApp({ id: d.id, method: d.method, args: Array.isArray(d.args) ? d.args : [] });
    else if (typeof d.log === 'string') {
      var args = [];
      if (Array.isArray(d.args)) for (var i = 0; i < d.args.length && i < 10; i++) args.push(String(d.args[i]).slice(0, 2000));
      toApp({ log: d.log, args: args });
    }
  }

  function startWorker(src) {
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    try {
      worker = new Worker(url, { name: 'codehub-addon' });
    } catch (e) {
      URL.revokeObjectURL(url);
      stop('This add-on could not start: ' + ((e && e.message) || 'the worker was refused') + '.');
      return;
    }
    var revoked = false;
    var revoke = function () {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
    };
    worker.onmessage = function (e) {
      if (e.data && e.data.up === 1) revoke();
      else fromWorker(e);
    };
    // Uncaught errors (including syntax errors, before the SDK even runs): the app shows them in the
    // builder's console; before the first render they also replace the empty panel.
    worker.onerror = function (e) {
      e.preventDefault();
      revoke();
      if (stopped) return;
      var line = e.lineno ? e.lineno - lineOffset : 0;
      var text = String(e.message || 'Script error').replace(/^Uncaught /, '') + (line > 0 ? ' (line ' + line + ')' : '');
      toApp({ log: 'error', args: ['Uncaught ' + text] });
      if (!rendered) message('This add-on stopped with an error: ' + text, true);
    };
    var q = queue;
    queue = null;
    for (var i = 0; i < q.length; i++) worker.postMessage(q[i]);
  }

  // The frame's CSP must reach the worker: it is what blocks the network there. A browser that
  // doesn't apply it to blob: workers would let add-on code talk to the network, so check first,
  // with a worker that runs only this probe (eval is blocked by the same policy).
  function probe(done) {
    var url = URL.createObjectURL(new Blob(['try{(0,eval)("0");postMessage("open")}catch(e){postMessage("guarded")}'], { type: 'text/javascript' }));
    var w = null;
    var over = false;
    var timer = 0;
    var finish = function (ok) {
      if (over) return;
      over = true;
      clearTimeout(timer);
      try {
        if (w) w.terminate();
      } catch (e) {
        /* gone */
      }
      URL.revokeObjectURL(url);
      done(ok);
    };
    timer = setTimeout(function () {
      finish(false);
    }, 8000);
    try {
      w = new Worker(url);
    } catch (e) {
      finish(false);
      return;
    }
    w.onmessage = function (e) {
      finish(e.data === 'guarded');
    };
    w.onerror = function (e) {
      e.preventDefault();
      finish(false);
    };
  }

  port.onmessage = function (e) {
    var d = e.data;
    if (stopped || !d || typeof d !== 'object') return;
    if (d.event === 'start') {
      if (started || typeof d.src !== 'string') return;
      started = true;
      lineOffset = typeof d.offset === 'number' ? d.offset : 0;
      var src = d.src;
      probe(function (ok) {
        if (stopped) return;
        if (!ok) stop('Add-ons can\u2019t run in this browser: it doesn\u2019t apply Codehub\u2019s network block to add-on code.');
        else startWorker(src);
      });
      return;
    }
    if (d.event === 'init' && d.data) applyTheme(d.data.theme);
    else if (d.event === 'theme') applyTheme(d.data);
    if (worker) worker.postMessage(d);
    else if (queue && queue.length < 200) queue.push(d);
  };

  if (!purify || !purify.isSupported) {
    stop('Add-ons can\u2019t run in this browser (the HTML sanitizer is unavailable).');
    return;
  }
  window.parent.postMessage({ __addon: token, hello: 1 }, '*', [ch.port2]);
}

// ---------- in-worker SDK ----------

/**
 * Runs first inside the add-on's worker (serialized with toString: no module scope). Defines the
 * global `codehub`:
 *   ready() -> Promise<{ context, theme, perms, scope }>     (context is null without the perm)
 *   getContext() (perm context)  getTheme()  getMessages(n) (perm readMessages)
 *   insertText(text) (perm composer)   sendMessage(text) (perm send; the user confirms)
 *   storage.get(key) / set(key, value) / remove(key) / keys()   (perm storage)
 *   ui.render(html), ui.on(fn) -> off(), ui.off(fn), ui.escape(text)
 *   theme / perms / context / scope (latest values), on(event, fn) -> off(), off(event, fn)
 *   events: 'theme', 'context' (perm context), 'messages' ({ count }, perm readMessages)
 */
export function workerSdk(self, opts) {
  'use strict';
  var post = self.postMessage.bind(self);
  var MAX_HTML = 262144;
  var seq = 0;
  var pending = {};
  var listeners = { theme: [], context: [], messages: [] };
  var uiListeners = [];
  var state = { theme: null, context: null, perms: [], scope: '' };
  var inited = false;
  var waiters = [];

  function emit(list, data) {
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

  self.addEventListener('message', function (e) {
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
      state.scope = typeof data.scope === 'string' ? data.scope : '';
      inited = true;
      waiters.splice(0).forEach(function (w) {
        w();
      });
    } else if (d.event === 'theme') {
      state.theme = data;
      emit(listeners.theme, data);
    } else if (d.event === 'context') {
      state.context = data;
      emit(listeners.context, data);
    } else if (d.event === 'messages') {
      emit(listeners.messages, data);
    } else if (d.event === 'ui' && data && typeof data === 'object') {
      emit(uiListeners, data);
    }
  });

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        post({ id: id, method: method, args: args || [] });
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

  function remove(list, fn) {
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  var ui = Object.freeze({
    render: function (html) {
      if (typeof html !== 'string') throw new TypeError('codehub.ui.render(html) needs a string of HTML.');
      if (html.length > MAX_HTML) throw new RangeError('codehub.ui.render: the HTML is longer than ' + MAX_HTML + ' characters.');
      post({ render: html });
    },
    on: function (fn) {
      if (typeof fn === 'function') uiListeners.push(fn);
      return function () {
        remove(uiListeners, fn);
      };
    },
    off: function (fn) {
      remove(uiListeners, fn);
    },
    escape: function (text) {
      return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
        return ESC[c];
      });
    },
  });

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
    version: 2,
    ready: function () {
      return call('ready', [])
        .then(whenInit)
        .then(function () {
          return { context: state.context, theme: state.theme, perms: state.perms.slice(), scope: state.scope };
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
    ui: ui,
    on: function (name, fn) {
      if (listeners[name] && typeof fn === 'function') listeners[name].push(fn);
      return function () {
        api.off(name, fn);
      };
    },
    off: function (name, fn) {
      if (listeners[name]) remove(listeners[name], fn);
    },
  };
  Object.defineProperty(api, 'theme', { enumerable: true, get: function () { return state.theme; } });
  Object.defineProperty(api, 'context', { enumerable: true, get: function () { return state.context; } });
  Object.defineProperty(api, 'perms', { enumerable: true, get: function () { return state.perms.slice(); } });
  Object.defineProperty(api, 'scope', { enumerable: true, get: function () { return state.scope; } });
  Object.freeze(api);
  Object.defineProperty(self, 'codehub', { value: api, writable: false, configurable: false, enumerable: true });

  if (opts && opts.console) {
    // Builder preview only: console output and unhandled rejections go to the preview's console pane
    // (uncaught errors reach it through the host, which sees them on the Worker object).
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
        post({ log: level, args: out });
      } catch (e) {
        /* closed */
      }
    };
    var con = self.console;
    if (con) {
      ['log', 'info', 'warn', 'error'].forEach(function (level) {
        var orig = con[level];
        con[level] = function () {
          log(level, Array.prototype.slice.call(arguments));
          if (orig) {
            try {
              return orig.apply(con, arguments);
            } catch (e) {
              /* ignore */
            }
          }
          return undefined;
        };
      });
    }
    self.addEventListener('unhandledrejection', function (e) {
      log('error', ['Unhandled rejection: ' + fmt(e && e.reason)]);
    });
  }

  post({ up: 1 });
}

/**
 * The worker's script: the SDK, then the add-on's code in its own function scope (its top-level
 * declarations can't replace what the SDK captured). Returns { src, offset } where `offset` is the
 * number of lines before the add-on's first line (for error line numbers).
 */
export function workerSource(code, { console: withConsole = false } = {}) {
  const sdk = `(${workerSdk.toString()})`;
  const offset = sdk.split('\n').length;
  const opts = JSON.stringify({ console: !!withConsole });
  return { src: `${sdk}(self,${opts});(function(){\n${String(code ?? '')}\n}).call(self);`, offset };
}

// ---------- the frame document ----------

const BASE_CSS =
  'html{color-scheme:dark}html[data-theme=light]{color-scheme:light}' +
  'body{margin:0;padding:12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
  'background:var(--ch-bg-1,#11141b);color:var(--ch-text,#e6e9f0)}' +
  '.ch-msg{margin:0;font-size:13px;color:var(--ch-text-dim,#9aa3b5)}.ch-msg.err{color:var(--ch-danger,#ff5c7a)}';

const normalize = (s) => String(s).replace(/\r\n?/g, '\n');

/** DOMPurify's UMD build, ready to inline (no source-map comment, LF line ends). */
export function cleanPurifySource(src) {
  const s = normalize(src).replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, '\n');
  if (/<\/?script/i.test(s)) throw new Error('The sanitizer source cannot be inlined.');
  return s;
}

/** The second CSP of the add-on frame: only our two scripts (by hash) and blob: workers. */
export function addonCsp(hashes) {
  const scripts = hashes.map((h) => `'sha256-${h}'`).join(' ');
  return (
    `default-src 'none'; script-src ${scripts}; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; ` +
    "font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; " +
    "form-action 'none'; base-uri 'none'"
  );
}

async function sha256Base64(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

let assetsPromise = null;
let assetsValue = null;

/**
 * { purify, host, csp } for frameDocument: the inlined scripts and the CSP pinning them by hash.
 * Computed once per page (hashing is async) and cached.
 */
export function runtimeAssets(purifySource) {
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const purify = cleanPurifySource(purifySource);
      const host = normalize(`(${hostScript.toString()})();`);
      const csp = addonCsp([await sha256Base64(purify), await sha256Base64(host)]);
      assetsValue = { purify, host, csp };
      return assetsValue;
    })();
    assetsPromise.catch(() => {
      assetsPromise = null;
    });
  }
  return assetsPromise;
}

/** The cached assets, or null before runtimeAssets() resolved. */
export const peekRuntimeAssets = () => assetsValue;

/**
 * The (unwrapped) frame document handed to SandboxFrame, which puts its own CSP meta in front
 * (both policies apply; this one is stricter). Contains nothing of the add-on's.
 */
export function frameDocument(assets, token) {
  const t = String(token || '').replace(/[^0-9a-f]/gi, '');
  return (
    `<meta http-equiv="Content-Security-Policy" content="${assets.csp}">` +
    `<meta name="codehub-addon" content="${t}">` +
    `<style>${BASE_CSS}</style>` +
    `<body><script>${assets.purify}</script><script>${assets.host}</script>`
  );
}

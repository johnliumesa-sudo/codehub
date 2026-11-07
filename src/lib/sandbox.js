// Sandboxed execution of untrusted HTML/JS (public games, the live preview, chat "Run", add-ons).
//
// Model: every document runs in <iframe sandbox="allow-scripts…" srcdoc=…>. Without
// allow-same-origin the frame gets an opaque origin, so it cannot reach the app's IndexedDB auth
// session, the in-memory keys, cookies, the app's localStorage or the parent DOM. A CSP <meta> is
// prepended before the user's markup; a CSP the user adds later can only tighten it.
//
// Two profiles (SandboxFrame `profile` prop, buildSrcdoc `profile` option):
//   'strict' (default)  add-ons. Exactly the original policy: sandbox="allow-scripts", allow="",
//                       STRICT_CSP with connect-src 'none' and no external sources at all. The add-on
//                       Worker inherits this CSP; a security fix depends on it. Never loosen it.
//   'play'              games, the live preview and chat "Run" snippets (src/lib/sandboxPlay.js):
//                       the same opaque origin plus pointer lock, fullscreen/gamepad/autoplay, eval and
//                       wasm, a pinned public-CDN allowlist, and a compatibility runtime (storage,
//                       dialogs, error reports) injected before any user script.
//
// Never add allow-same-origin, allow-popups, allow-top-navigation, allow-forms or allow-modals to
// either profile (allow-modals would let a game draw native dialogs over Codehub).
// Known residual: a frame can still navigate *itself* to an external URL. It still has no access to
// anything of the user's; anything typed into a game should be treated as public.
import { applyEdits, looksLikeModule, scanModule } from './esmScan.js';
import { PLAY_ALLOW, PLAY_CSP, PLAY_SANDBOX, isAllowedUrl, jsonForScript, playRuntimeScript, rewriteCdnUrl } from './sandboxPlay.js';

export { PLAY_ALLOW, PLAY_CSP, PLAY_SANDBOX, isAllowedUrl, rewriteCdnUrl } from './sandboxPlay.js';

export const SANDBOX = 'allow-scripts';

export const GAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
/** The strict profile's CSP (add-ons). Same string as the original GAME_CSP; kept under both names. */
export const STRICT_CSP = GAME_CSP;

export const PROFILES = ['strict', 'play'];

/** iframe attributes for a profile: { sandbox, allow, csp }. Unknown profiles get 'strict'. */
export function frameAttrs(profile = 'strict') {
  if (profile === 'play') return { sandbox: PLAY_SANDBOX, allow: PLAY_ALLOW, csp: PLAY_CSP };
  return { sandbox: SANDBOX, allow: '', csp: STRICT_CSP };
}

export const MAX_GAME_CHARS = 262144; // gameCode/{id}/html limit enforced by the rules
export const MAX_PREVIEW_CHARS = 2 * 1024 * 1024; // live preview bundle limit (client-only)
export const MAX_CONSOLE_LINES = 200;

/** Random per-render token for the preview console bridge. */
export function newToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- console bridge (preview mode only) ----------

// Runs inside the sandboxed frame. It forwards console output and uncaught errors to the parent
// as {__sbx: token, level, args: [string]}. The parent accepts a message only when it comes from
// this exact frame's window and carries the token, and renders it as plain text.
function consoleBridge(token) {
  const t = JSON.stringify(String(token || ''));
  return (
    '<script>(function(){' +
    'var T=' + t + ',P=window.parent,LIM=200,sent=0,dropped=0,winStart=Date.now();' +
    'function post(level,args){try{P.postMessage({__sbx:T,level:level,args:args},"*");}catch(e){}}' +
    'function tick(){var n=Date.now();if(n-winStart>=1000){if(dropped){post("warn",["[preview] "+dropped+" console message(s) dropped (rate limit)"]);}winStart=n;sent=0;dropped=0;}}' +
    'function fmt(v,depth,seen){' +
    'try{' +
    'if(typeof v==="string")return v;' +
    'if(v===undefined)return "undefined";' +
    'if(v===null)return "null";' +
    'if(typeof v==="function")return "\\u0192 "+(v.name||"anonymous")+"()";' +
    'if(typeof v==="symbol"||typeof v==="bigint")return String(v)+(typeof v==="bigint"?"n":"");' +
    'if(typeof v!=="object")return String(v);' +
    'if(v instanceof Error)return v.stack&&v.stack.indexOf(v.message)>=0?String(v.stack):(v.name+": "+v.message);' +
    'if(typeof Element!=="undefined"&&v instanceof Element){return "<"+v.tagName.toLowerCase()+(v.id?"#"+v.id:"")+(typeof v.className==="string"&&v.className?"."+v.className.trim().split(/\\s+/).join("."):"")+">";}' +
    'return JSON.stringify(v,function(k,x){' +
    'if(typeof x==="bigint")return String(x)+"n";' +
    'if(typeof x==="function")return "\\u0192 "+(x.name||"anonymous")+"()";' +
    'if(x===undefined)return "undefined";' +
    'if(x&&typeof x==="object"){if(seen.indexOf(x)>=0)return "[Circular]";seen.push(x);}' +
    'return x;},2);' +
    '}catch(e){try{return Object.prototype.toString.call(v);}catch(e2){return "[unprintable]";}}' +
    '}' +
    'function send(level,list){tick();if(sent>=LIM){dropped++;return;}sent++;' +
    'var out=[];for(var i=0;i<list.length&&i<20;i++){var s=fmt(list[i],0,[]);if(typeof s!=="string")s=String(s);if(s.length>4000)s=s.slice(0,4000)+"\\u2026";out.push(s);}' +
    'post(level,out);}' +
    '["log","info","warn","error","debug"].forEach(function(l){var o=console[l];console[l]=function(){' +
    'try{send(l==="debug"?"log":l,Array.prototype.slice.call(arguments));}catch(e){}' +
    'if(o)try{return o.apply(console,arguments);}catch(e){}};});' +
    'var oc=console.clear;console.clear=function(){post("clear",[]);if(oc)try{oc.call(console);}catch(e){}};' +
    'window.addEventListener("error",function(e){var m=(e&&e.message)||"Script error";' +
    'if(e&&e.error&&e.error.stack&&String(e.error.stack).indexOf(m)<0)m+="\\n"+e.error.stack;' +
    'if(e&&e.lineno)m+=" (line "+e.lineno+(e.colno?":"+e.colno:"")+")";send("error",["Uncaught "+m]);});' +
    'window.addEventListener("unhandledrejection",function(e){var r=e&&e.reason;send("error",["Unhandled promise rejection: "+fmt(r,0,[])]);});' +
    '})();</' +
    'script>'
  );
}

/**
 * Wrap untrusted HTML into the srcdoc we hand the sandbox. The CSP meta comes first so it applies
 * before any user markup is parsed; in preview mode the console bridge runs before user scripts, and
 * in the play profile the compatibility runtime runs right after it (still before user scripts).
 *   profile  'strict' (default; output identical to the original) | 'play'
 *   mode     'game' | 'preview' (console bridge)
 *   token    per-render token for messages from the frame
 *   storage  play only: { persist, local, session } initial storage contents (see sandboxPlay.js)
 */
export function buildSrcdoc(html, { mode = 'game', token, profile = 'strict', storage = null } = {}) {
  const play = profile === 'play';
  const head =
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    (play ? PLAY_CSP : GAME_CSP).replace(/"/g, '&quot;') +
    '"><meta name="referrer" content="no-referrer">';
  const bridge = mode === 'preview' ? consoleBridge(token) : '';
  const runtime = play ? playRuntimeScript({ token, mode, storage }) : '';
  return head + bridge + runtime + String(html ?? '');
}

// ---------- paths ----------

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Strip leading slashes / "./" and collapse "." segments: the workspace stores "dir/file.ext". */
export function cleanPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
    .join('/');
}

export function extOf(path) {
  const base = String(path || '').split('/').pop().toLowerCase();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
}

export const isHtmlPath = (p) => /^(html?|xhtml)$/.test(extOf(p));

/**
 * Resolve a reference from inside `fromPath` (a workspace file) to a workspace path.
 * Returns null for external URLs (http:, data:, //host, #frag) and for paths escaping the root.
 */
export function resolveRef(fromPath, refValue) {
  const raw = String(refValue || '').trim();
  if (!raw || EXTERNAL.test(raw)) return null;
  let r = raw.split(/[?#]/)[0];
  try {
    r = decodeURIComponent(r);
  } catch {
    /* keep as-is */
  }
  if (!r) return null;
  const parts = r.startsWith('/') ? [] : cleanPath(fromPath).split('/').slice(0, -1);
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/') || null;
}

// ---------- tiny HTML attribute helpers ----------

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`=<]+)))?/g;

function parseAttrs(src) {
  const out = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(src || ''))) {
    const value = m[2] ?? m[3] ?? m[4];
    out.push({ name: m[1].toLowerCase(), value: value === undefined ? null : decodeEntities(value) });
  }
  return out;
}

function decodeEntities(s) {
  return s.replace(/&(amp|quot|apos|#39|lt|gt);/g, (_, e) => ({ amp: '&', quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>' })[e]);
}

const getAttr = (attrs, name) => attrs.find((a) => a.name === name)?.value ?? null;
const hasAttr = (attrs, name) => attrs.some((a) => a.name === name);

function serializeAttrs(attrs) {
  return attrs
    .map((a) => (a.value === null ? ` ${a.name}` : ` ${a.name}="${String(a.value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`))
    .join('');
}

/** Make text safe to embed inside <script>…</script>. */
export function escapeScript(code) {
  return String(code).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function escapeStyle(css) {
  return String(css).replace(/<\/(style)/gi, '<\\/$1');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function utf8Base64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- bundler ----------

function fileMap(files) {
  const map = new Map();
  for (const f of files || []) {
    if (f && typeof f.text === 'string' && f.path) map.set(cleanPath(f.path), f.text);
  }
  return map;
}

/** Import-map key prefix of workspace modules ("@codehub-ws/src/player.js"). */
export const WS_PREFIX = '@codehub-ws/';

const MODULE_EXTS = ['js', 'mjs', 'cjs', 'json'];
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const RELATIVE = /^(?:\.{1,2}\/|\/)/;
const VERSION_OK = /^[0-9A-Za-z.^~<>=| *-]{1,40}$/;
const MIME = {
  json: 'application/json', svg: 'image/svg+xml', xml: 'application/xml', csv: 'text/csv', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', html: 'text/html', htm: 'text/html',
};
const mimeOf = (path) => MIME[extOf(path)] || 'text/plain';

/** "three/addons/x.js" -> { name: "three", sub: "addons/x.js" }; scoped names keep their scope. */
function splitBare(spec) {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, n).join('/'), sub: parts.slice(n).join('/') };
}

/** jsDelivr ES-module URL for a bare import. `version` from package.json, or null (latest). */
export function npmModuleUrl(spec, version) {
  const { name, sub } = splitBare(spec);
  const v = version && VERSION_OK.test(version) && version.trim() !== '*' ? `@${encodeURI(version.replace(/\s+/g, ''))}` : '';
  return `https://cdn.jsdelivr.net/npm/${name}${v}${sub ? `/${sub}` : ''}/+esm`;
}

function readPackageJson(map) {
  try {
    const pkg = JSON.parse(map.get('package.json') || '{}');
    return { ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}), ...(pkg.dependencies || {}) };
  } catch {
    return {};
  }
}

function parseImportMap(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const imports = v.imports && typeof v.imports === 'object' && !Array.isArray(v.imports) ? v.imports : {};
    const scopes = v.scopes && typeof v.scopes === 'object' && !Array.isArray(v.scopes) ? v.scopes : {};
    return { imports, scopes };
  } catch {
    return null;
  }
}

// Runs inside the sandboxed frame (bundled games only), before the first module script: turns the
// workspace module sources into blob: URLs, installs one import map (the page's own entries win),
// and serves the workspace files the code reads (fetch, XMLHttpRequest, img/script src, Worker).
// ES5, self-contained: serialised with Function.prototype.toString.
/* eslint-disable no-var, prefer-arrow-callback, func-names, object-shorthand, prefer-rest-params */
function bundleBoot(B) {
  'use strict';
  var W = window;
  var D = document;
  var mk = function (text, type) {
    return URL.createObjectURL(new Blob([text], { type: type }));
  };
  var urls = {};
  Object.keys(B.m || {}).forEach(function (p) {
    urls[B.k + p] = mk(B.m[p], /\.json$/i.test(p) ? 'application/json' : 'text/javascript');
  });
  if (B.map) {
    var im = B.map;
    var fix = function (o) {
      Object.keys(o || {}).forEach(function (k) {
        var v = o[k];
        if (typeof v === 'string' && v.indexOf(B.k) === 0 && urls[v]) o[k] = urls[v];
      });
    };
    im.imports = im.imports || {};
    Object.keys(urls).forEach(function (k) {
      im.imports[k] = urls[k];
    });
    fix(im.imports);
    Object.keys(im.scopes || {}).forEach(function (sc) {
      fix(im.scopes[sc]);
    });
    var s = D.createElement('script');
    s.type = 'importmap';
    s.textContent = JSON.stringify(im);
    var cur = D.currentScript;
    if (cur && cur.parentNode) cur.parentNode.insertBefore(s, cur.nextSibling);
    else (D.head || D.documentElement).appendChild(s);
  }
  var A = B.a || {};
  if (!Object.keys(A).length) return;
  var base = (B.base || '').split('/').filter(Boolean);
  var docBase = '';
  var origin = '';
  try {
    docBase = new URL('.', D.baseURI).href;
    origin = new URL(D.baseURI).origin;
  } catch (e) {
    /* opaque base */
  }
  var aurl = {};
  var blobFor = function (p) {
    return aurl[p] || (aurl[p] = mk(A[p][1], A[p][0]));
  };
  var wsPath = function (u) {
    if (u && typeof u === 'object') u = u.url || u.href || '';
    if (typeof u !== 'string') return null;
    var s2 = u.trim();
    var parts;
    if (docBase && s2.indexOf(docBase) === 0) s2 = s2.slice(docBase.length);
    else if (origin && origin !== 'null' && s2.indexOf(origin + '/') === 0) s2 = s2.slice(origin.length);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(s2) || s2.slice(0, 2) === '//') return null;
    s2 = s2.split('#')[0].split('?')[0];
    try {
      s2 = decodeURIComponent(s2);
    } catch (e) {
      /* keep */
    }
    parts = s2.charAt(0) === '/' ? [] : base.slice();
    var segs = s2.split('/');
    for (var i = 0; i < segs.length; i++) {
      if (!segs[i] || segs[i] === '.') continue;
      if (segs[i] === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(segs[i]);
    }
    var p = parts.join('/');
    return Object.prototype.hasOwnProperty.call(A, p) ? p : null;
  };
  var of = W.fetch;
  if (of) {
    W.fetch = function (input) {
      var p = wsPath(input);
      if (p !== null) return Promise.resolve(new Response(A[p][1], { status: 200, headers: { 'Content-Type': A[p][0] } }));
      return of.apply(W, arguments);
    };
  }
  var XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
  if (XP && XP.open) {
    var xo = XP.open;
    XP.open = function () {
      var args = Array.prototype.slice.call(arguments);
      var p = wsPath(args[1]);
      if (p !== null) args[1] = blobFor(p);
      return xo.apply(this, args);
    };
  }
  var patchSrc = function (proto) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, 'src');
    if (!d || !d.set) return;
    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function (v) {
        var p = wsPath(String(v));
        d.set.call(this, p !== null ? blobFor(p) : v);
      },
    });
  };
  patchSrc(W.HTMLImageElement && W.HTMLImageElement.prototype);
  patchSrc(W.HTMLScriptElement && W.HTMLScriptElement.prototype);
  var OW = W.Worker;
  if (OW) {
    var Wk = function (url, opts) {
      var p = wsPath(url);
      return new OW(p !== null ? blobFor(p) : url, opts);
    };
    Wk.prototype = OW.prototype;
    W.Worker = Wk;
  }
}
/* eslint-enable no-var, prefer-arrow-callback, func-names, object-shorthand, prefer-rest-params */

const BOOT_SOURCE = bundleBoot.toString();

/**
 * Inline everything an HTML entry needs from the workspace, so it runs from one self-contained
 * document (the published game, the live preview):
 *   <link rel="stylesheet" href="x.css">     -> <style>…</style> (url() of workspace SVGs and
 *                                               @import of workspace CSS inlined too)
 *   <script src="x.js"></script>             -> <script>…</script> (</script and <!-- escaped)
 *   <script src="x.js" defer|async>          -> <script defer src="data:text/javascript;base64,…">
 *   <img src="x.svg">                        -> data:image/svg+xml URL
 *   <script type="module" src="main.js">     -> ES modules: every workspace module reachable through
 *                                               relative imports (static and import("…")) is embedded;
 *                                               a boot script makes them blob: URLs and installs one
 *                                               import map (the page's own import maps are merged in;
 *                                               its entries win). Bare imports ("three") map to
 *                                               jsDelivr "+esm" URLs, pinned to package.json versions.
 *   fetch('levels.json'), XMLHttpRequest, new Image().src, script.src, new Worker('w.js')
 *                                            -> workspace files named by string literals in the code
 *                                               are embedded and served from memory.
 * esm.sh / Skypack / code.jquery.com URLs are rewritten to their jsDelivr equivalents; other external
 * references are left alone and reported with whether the play CSP allows them.
 * References resolve relative to the referring file ("/x" = workspace root).
 *
 * Options: html (use this markup instead of the entry file's text), transform(path, text) -> JS for
 * other module languages (with extensions in `moduleExts`, e.g. ['ts','tsx','jsx']).
 * Returns { html, inlined, missing, modules, assets, external: [{ url, kind, allowed, from? }],
 *           unpinned: [package], errors: [string] }.
 */
export function bundle(entryPath, files, { html: htmlOverride, transform = null, moduleExts = [] } = {}) {
  const map = fileMap(files);
  const entry = cleanPath(entryPath);
  if (htmlOverride === undefined && !map.has(entry)) throw new Error(`Entry file not found: ${entryPath}`);
  const inlined = new Set();
  const missing = new Set();
  const external = new Map(); // final url -> { url, kind, allowed, from? }
  const modules = new Map(); // path -> rewritten source ('' while being processed)
  const assets = new Map(); // path -> [mime, text]
  const bare = new Map(); // specifier -> url
  const unpinned = new Set();
  const errors = [];
  const deps = readPackageJson(map);
  const codeExts = new Set([...MODULE_EXTS, ...(transform ? moduleExts.map((e) => String(e).toLowerCase()) : [])]);
  const userMap = { imports: {}, scopes: {} };
  let userMaps = 0; // import map elements taken out of the page (replaced by placeholders)

  const lookup = (refValue, from = entry) => {
    if (!refValue) return null;
    const p = resolveRef(from, refValue);
    if (p === null) return null;
    if (!map.has(p)) {
      missing.add(refValue);
      return null;
    }
    inlined.add(p);
    return { path: p, text: map.get(p) };
  };

  const noteExternal = (original, kind) => {
    const url = rewriteCdnUrl(original);
    if (/^https?:|^\/\//i.test(url) && !external.has(url)) {
      external.set(url, { url, kind, allowed: isAllowedUrl(url, kind), ...(url !== original ? { from: original } : {}) });
    }
    return url;
  };

  // ---- modules ----
  const resolveModule = (from, spec) => {
    const p = resolveRef(from, spec);
    if (p === null) return null;
    const cands = [p];
    for (const e of codeExts) if (e !== 'json') cands.push(`${p}.${e}`);
    for (const e of codeExts) if (e !== 'json') cands.push(`${p}/index.${e}`);
    // TypeScript convention: import "./a.js" that is really a.ts.
    const m = /^(.*)\.(m?)js(x?)$/.exec(p);
    if (m && transform) cands.push(`${m[1]}.${m[2]}ts${m[3]}`, `${m[1]}.${m[2]}tsx`);
    return cands.find((c) => map.has(c) && codeExts.has(extOf(c))) || null;
  };

  const coveredByUserMap = (spec) =>
    Object.prototype.hasOwnProperty.call(userMap.imports, spec) ||
    Object.keys(userMap.imports).some((k) => k.endsWith('/') && spec.startsWith(k));

  const addBare = (spec) => {
    if (bare.has(spec) || coveredByUserMap(spec)) return;
    const { name } = splitBare(spec);
    const v = typeof deps[name] === 'string' && VERSION_OK.test(deps[name]) && deps[name].trim() !== '*' ? deps[name] : null;
    if (!v) unpinned.add(name);
    const url = npmModuleUrl(spec, v);
    bare.set(spec, url);
    noteExternal(url, 'script');
  };

  // Workspace files named by string literals in code (fetch('levels.json'), 'sprites/' + name…).
  const docDir = entry.split('/').slice(0, -1).join('/');
  const addAssetRefs = (strings, skip) => {
    for (const st of strings) {
      if (skip.has(st.start)) continue;
      const v = st.value.trim();
      if (!v || v.length > 300 || URL_LIKE.test(v) || /[\s<>{}]/.test(v)) continue;
      const p = resolveRef(entry, v);
      if (p === null) continue;
      if (map.has(p)) {
        if (p !== entry && !assets.has(p)) {
          assets.set(p, [mimeOf(p), map.get(p)]);
          inlined.add(p);
        }
      } else if (v.endsWith('/') || st.template) {
        // A folder prefix ("levels/" or `levels/${n}.json`): embed the text files in it.
        const dir = `${p.replace(/\/+$/, '')}/`;
        if (dir === '/' || (docDir && dir === `${docDir}/`)) continue;
        let n = 0;
        for (const [fp, text] of map) {
          if (n >= 100) break;
          if (fp.startsWith(dir) && fp !== entry && !assets.has(fp)) {
            assets.set(fp, [mimeOf(fp), text]);
            inlined.add(fp);
            n += 1;
          }
        }
      }
    }
  };

  const rewriteModule = (code, from) => {
    let scan;
    try {
      scan = scanModule(code);
    } catch (err) {
      errors.push(`${from}: ${err?.message || err}`);
      return code;
    }
    const edits = [];
    const skip = new Set();
    for (const sp of scan.specifiers) {
      skip.add(sp.start);
      const spec = sp.spec;
      if (RELATIVE.test(spec)) {
        const target = resolveModule(from, spec);
        if (!target) {
          missing.add(spec);
          continue;
        }
        // eslint-disable-next-line no-use-before-define
        edits.push({ start: sp.start, end: sp.end, text: JSON.stringify(addModule(target)) });
      } else if (URL_LIKE.test(spec)) {
        if (/^(?:https?:)?\/\//i.test(spec)) {
          const to = noteExternal(spec, 'script');
          if (to !== spec) edits.push({ start: sp.start, end: sp.end, text: JSON.stringify(to) });
        }
      } else if (spec) addBare(spec);
    }
    addAssetRefs(scan.strings, skip);
    return applyEdits(code, edits);
  };

  function addModule(path) {
    const key = WS_PREFIX + path;
    if (modules.has(path)) return key;
    modules.set(path, '');
    inlined.add(path);
    let code = map.get(path);
    const ext = extOf(path);
    if (ext === 'json') {
      modules.set(path, code);
      return key;
    }
    if (!MODULE_EXTS.includes(ext) && transform) {
      try {
        code = String(transform(path, code) ?? '');
      } catch (err) {
        errors.push(`${path}: ${err?.message || err}`);
        code = `throw new SyntaxError(${JSON.stringify(`${path}: ${err?.message || err}`)});`;
      }
    }
    modules.set(path, rewriteModule(code, path));
    return key;
  }

  let html = htmlOverride ?? map.get(entry);

  // The page's own import maps: merged into ours (its entries win) and removed from the markup.
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attrSrc, body) => {
    const attrs = parseAttrs(attrSrc);
    if ((getAttr(attrs, 'type') || '').trim().toLowerCase() !== 'importmap' || getAttr(attrs, 'src')) return whole;
    const parsed = parseImportMap(body);
    if (!parsed) return whole; // invalid JSON: leave it, the browser reports it
    const fixTarget = (v) => {
      if (typeof v !== 'string') return v;
      if (RELATIVE.test(v) && !v.endsWith('/')) {
        const target = resolveModule(entry, v);
        if (target) return addModule(target);
        missing.add(v);
        return v;
      }
      return URL_LIKE.test(v) ? noteExternal(v, 'script') : v;
    };
    for (const [k, v] of Object.entries(parsed.imports)) userMap.imports[k] = fixTarget(v);
    for (const [scope, entries] of Object.entries(parsed.scopes)) {
      if (!entries || typeof entries !== 'object') continue;
      userMap.scopes[scope] = { ...(userMap.scopes[scope] || {}) };
      for (const [k, v] of Object.entries(entries)) userMap.scopes[scope][k] = fixTarget(v);
    }
    return `\u0000codehub-importmap-${userMaps++}\u0000`;
  });

  const skipNone = new Set();
  // Scripts: workspace sources are inlined (classic) or become modules; inline module scripts get
  // their imports rewritten; external sources are reported (and rewritten when there's an allowed twin).
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attrSrc, body) => {
    const attrs = parseAttrs(attrSrc);
    const src = getAttr(attrs, 'src');
    const type = (getAttr(attrs, 'type') || '').trim().toLowerCase();
    const isModule = type === 'module';
    if (type && !isModule && !/^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(type) && type !== 'text/babel') return whole;
    if (!src) {
      if (!body.trim()) return whole;
      if (isModule) {
        const code = rewriteModule(body, entry);
        return `<script${serializeAttrs(attrs)}>${escapeScript(code)}</script>`;
      }
      try {
        addAssetRefs(scanModule(body).strings, skipNone);
      } catch {
        /* not JavaScript (e.g. a template): nothing to embed */
      }
      return whole;
    }
    if (body.trim()) return whole;
    if (URL_LIKE.test(src.trim())) {
      const to = noteExternal(src.trim(), 'script');
      if (to === src.trim()) return whole;
      const next = attrs.filter((a) => !['integrity', 'crossorigin'].includes(a.name)).map((a) => (a.name === 'src' ? { name: 'src', value: to } : a));
      // jsDelivr "+esm" URLs are ES modules.
      if (/\/\+esm$/.test(to) && !isModule) next.push({ name: 'type', value: 'module' });
      return `<script${serializeAttrs(next)}></script>`;
    }
    const file = lookup(src);
    if (!file) return whole;
    const rest = attrs.filter((a) => !['src', 'integrity', 'crossorigin', 'nonce'].includes(a.name));
    // A plain <script src> whose file uses import/export can only work as a module.
    if (isModule || (MODULE_EXTS.includes(extOf(file.path)) && looksLikeModule(file.text))) {
      const key = addModule(file.path);
      const kept = rest.filter((a) => !['type', 'defer', 'async'].includes(a.name));
      return `<script type="module"${serializeAttrs(kept)}>import ${JSON.stringify(key)};</script>`;
    }
    try {
      addAssetRefs(scanModule(file.text).strings, skipNone);
    } catch {
      /* ignore */
    }
    if (hasAttr(attrs, 'defer') || hasAttr(attrs, 'async')) {
      const dataUrl = `data:text/javascript;base64,${utf8Base64(file.text)}`;
      return `<script${serializeAttrs([...rest, { name: 'src', value: dataUrl }])}></script>`;
    }
    const kept = rest.filter((a) => a.name !== 'defer' && a.name !== 'async');
    return `<script${serializeAttrs(kept)}>\n${escapeScript(file.text)}\n</script>`;
  });

  // Stylesheets, module preloads and other <link>s.
  html = html.replace(/<link\b([^>]*)>/gi, (whole, attrSrc) => {
    const attrs = parseAttrs(attrSrc);
    const rel = (getAttr(attrs, 'rel') || '').toLowerCase().split(/\s+/);
    const href = getAttr(attrs, 'href');
    if (rel.includes('modulepreload') && href && !URL_LIKE.test(href.trim())) return '';
    if (!rel.includes('stylesheet')) return whole;
    if (href && URL_LIKE.test(href.trim())) {
      const to = noteExternal(href.trim(), 'style');
      if (to === href.trim()) return whole;
      return `<link${serializeAttrs(attrs.map((a) => (a.name === 'href' ? { name: 'href', value: to } : a)))}>`;
    }
    const file = lookup(href);
    if (!file) return whole;
    const media = getAttr(attrs, 'media');
    // eslint-disable-next-line no-use-before-define
    const css = inlineCss(file.text, file.path, 0);
    return `<style${media ? serializeAttrs([{ name: 'media', value: media }]) : ''}>\n${escapeStyle(css)}\n</style>`;
  });

  // url() of workspace SVGs and @import of workspace CSS (the workspace holds text files only).
  function inlineCss(css, fromPath, depth) {
    let out = String(css).replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?([^;]*);/gi, (whole, q, ref, media) => {
      if (URL_LIKE.test(ref)) {
        noteExternal(ref, 'style');
        const to = rewriteCdnUrl(ref);
        return to === ref ? whole : `@import url("${to}")${media};`;
      }
      if (depth >= 5) return whole;
      const file = lookup(ref, fromPath);
      if (!file) return whole;
      const inner = inlineCss(file.text, file.path, depth + 1);
      return media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
    });
    out = out.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, q, ref) => {
      const r = ref.trim();
      if (URL_LIKE.test(r) || r.startsWith('#')) return whole;
      if (extOf(r.split(/[?#]/)[0]) !== 'svg') {
        const p = resolveRef(fromPath, r);
        if (p !== null && !map.has(p)) missing.add(r);
        return whole;
      }
      const file = lookup(r, fromPath);
      return file ? `url("data:image/svg+xml;base64,${utf8Base64(file.text)}")` : whole;
    });
    return out;
  }
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (whole, open, css, close) => `${open}${inlineCss(css, entry, 0)}${close}`);

  // SVG images.
  html = html.replace(/<img\b([^>]*)>/gi, (whole, attrSrc) => {
    const attrs = parseAttrs(attrSrc);
    const src = getAttr(attrs, 'src');
    if (!src || extOf(src.split(/[?#]/)[0]) !== 'svg') return whole;
    const file = lookup(src);
    if (!file) return whole;
    const next = attrs.map((a) => (a.name === 'src' ? { name: 'src', value: `data:image/svg+xml;base64,${utf8Base64(file.text)}` } : a));
    return `<img${serializeAttrs(next)}>`;
  });

  // One import map. With workspace modules or npm imports it is built at run time by the boot script
  // (blob: URLs); otherwise the page's own map stays a static element where the first one was.
  const needMap = modules.size > 0 || bare.size > 0;
  const scopes = Object.keys(userMap.scopes).length ? { scopes: userMap.scopes } : {};
  html = html.replace(/\u0000codehub-importmap-(\d+)\u0000/g, (whole, n) =>
    !needMap && n === '0' ? `<script type="importmap">${jsonForScript({ imports: userMap.imports, ...scopes })}</script>` : '',
  );
  // Boot: modules + import map + served files, before anything else in the page.
  if (needMap || assets.size) {
    const imports = {};
    for (const [spec, url] of bare) imports[spec] = url;
    Object.assign(imports, userMap.imports);
    const data = {
      k: WS_PREFIX,
      m: Object.fromEntries(modules),
      map: needMap ? { imports, ...scopes } : null,
      a: Object.fromEntries(assets),
      base: docDir ? `${docDir}/` : '',
    };
    html = `<script>(${BOOT_SOURCE})(${jsonForScript(data)});</script>\n${html}`;
  }

  return {
    html,
    inlined: [...inlined],
    missing: [...missing],
    modules: [...modules.keys()],
    assets: [...assets.keys()],
    external: [...external.values()],
    unpinned: [...unpinned],
    errors,
  };
}

/** bundleHtml(entryPath, files) -> string (see bundle()). */
export function bundleHtml(entryPath, files) {
  return bundle(entryPath, files).html;
}

// ---------- preview documents ----------

const SHELL_STYLE =
  'html{color-scheme:dark}body{margin:0;padding:24px 28px;background:#161a23;color:#e6e9f0;' +
  "font:15px/1.6 Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  'a{color:#5b8cff}code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}' +
  'code{background:#1d2230;padding:1px 5px;border-radius:4px}pre{background:#1d2230;padding:12px;border-radius:8px;overflow:auto}' +
  'pre code{background:none;padding:0}blockquote{margin:0;padding:2px 14px;border-left:3px solid #262d3d;color:#9aa3b5}' +
  'table{border-collapse:collapse}th,td{border:1px solid #262d3d;padding:5px 9px}img{max-width:100%}' +
  'h1,h2{border-bottom:1px solid #262d3d;padding-bottom:.3em}hr{border:0;border-top:1px solid #262d3d}' +
  '.md-code{margin:10px 0}.md-code-head{display:flex;justify-content:space-between;font-size:11px;color:#9aa3b5;padding:2px 4px}' +
  '.md-copy{display:none}.mention{color:#5b8cff}' +
  '.hljs-keyword,.hljs-built_in{color:#c792ea}.hljs-string{color:#c3e88d}.hljs-number{color:#f78c6c}.hljs-comment{color:#6b7487}' +
  '.hljs-title{color:#82aaff}.hljs-attr{color:#ffcb6b}';

function shell(title, bodyHtml, extraHead = '') {
  return (
    `<html><head><title>${escapeHtml(title)}</title><style>${SHELL_STYLE}</style>${extraHead}</head>` +
    `<body>${bodyHtml}</body></html>`
  );
}

/**
 * HTML files in the workspace that load `path`: through <script src> / <link href> / <img src>, or
 * (for a JS module) through a chain of imports from a module such a page loads.
 */
export function htmlFilesReferencing(path, files) {
  const target = cleanPath(path);
  const direct = (p) => {
    const out = [];
    for (const f of files || []) {
      if (!isHtmlPath(f.path) || typeof f.text !== 'string') continue;
      const re = /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      let m;
      while ((m = re.exec(f.text))) {
        if (resolveRef(f.path, decodeEntities(m[1] ?? m[2] ?? m[3])) === p) {
          out.push(cleanPath(f.path));
          break;
        }
      }
    }
    return out;
  };
  const found = direct(target);
  if (found.length || !/^(?:m?js|cjs)$/.test(extOf(target))) return found;
  // Walk importers upwards (breadth first, bounded) until a page that loads one of them.
  const code = (files || []).filter((f) => typeof f.text === 'string' && /^(?:m?js|cjs)$/.test(extOf(f.path)) && f.text.includes(target.split('/').pop().replace(/\.[^.]+$/, '')));
  const seen = new Set([target]);
  let frontier = [target];
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const next = [];
    for (const f of code) {
      const fp = cleanPath(f.path);
      if (seen.has(fp)) continue;
      let specs;
      try {
        specs = scanModule(f.text).specifiers;
      } catch {
        continue;
      }
      if (specs.some((sp) => RELATIVE.test(sp.spec) && frontier.some((t) => [t, t.replace(/\.m?js$/, '')].includes(resolveRef(fp, sp.spec))))) {
        seen.add(fp);
        next.push(fp);
      }
    }
    for (const fp of next) {
      const pages = direct(fp);
      if (pages.length) return pages;
    }
    frontier = next;
  }
  return [];
}

/**
 * Pick the document to render for `activePath` when the user hasn't pinned an entry:
 * HTML / Markdown / SVG render themselves; a CSS or JS file renders through the HTML page that
 * includes it (or index.html); a lone JS file runs in a blank shell.
 */
export function autoEntry(activePath, files) {
  if (!activePath) return null;
  const ext = extOf(activePath);
  if (isHtmlPath(activePath) || ['md', 'markdown', 'svg'].includes(ext)) return cleanPath(activePath);
  if (['css', 'js', 'mjs', 'cjs'].includes(ext)) {
    const refs = htmlFilesReferencing(activePath, files);
    if (refs.length) return refs[0];
    if (ext === 'css') {
      const index = (files || []).find((f) => /(^|\/)index\.html?$/i.test(f.path));
      if (index) return cleanPath(index.path);
    }
  }
  return cleanPath(activePath);
}

/**
 * Build the (unwrapped) HTML for previewing `entryPath` with the given workspace files.
 * Returns { html, missing, error }. `renderMarkdown` is injected to keep this module DOM-free.
 */
export function buildPreviewHtml(entryPath, files, { renderMarkdown } = {}) {
  const path = cleanPath(entryPath);
  const file = (files || []).find((f) => cleanPath(f.path) === path);
  if (!file || typeof file.text !== 'string') return { html: '', missing: [], error: `Can't read ${entryPath}` };
  const ext = extOf(path);
  const name = path.split('/').pop();
  let result;
  try {
    if (isHtmlPath(path)) {
      const b = bundle(path, files);
      result = { html: b.html, missing: b.missing, external: b.external, error: null };
    } else if (ext === 'md' || ext === 'markdown') {
      const body = renderMarkdown ? renderMarkdown(file.text) : `<pre>${escapeHtml(file.text)}</pre>`;
      result = { html: shell(name, `<article>${body}</article>`), missing: [], error: null };
    } else if (ext === 'js' || ext === 'cjs' || ext === 'mjs') {
      const note =
        `<p style="color:#6b7487;font-size:12px;margin:0 0 12px">Running <code>${escapeHtml(name)}</code>. ` +
        'Output appears in the console below; <code>document.body</code> is yours to draw in.</p>';
      if (ext === 'mjs' || looksLikeModule(file.text)) {
        // An ES module: run it through the bundler so its imports (workspace files, npm packages) resolve.
        const page = shell(name, `${note}<script type="module" src="/${path.split('/').map(encodeURIComponent).join('/')}"></script>`);
        const b = bundle('__preview__.html', files, { html: page });
        result = { html: b.html, missing: b.missing, external: b.external, error: null };
      } else {
        result = { html: shell(name, `${note}<script>\n${escapeScript(file.text)}\n</script>`), missing: [], error: null };
      }
    } else if (ext === 'svg') {
      result = {
        html: shell(name, `<img alt="${escapeHtml(name)}" src="data:image/svg+xml;base64,${utf8Base64(file.text)}">`),
        missing: [],
        error: null,
      };
    } else if (ext === 'css') {
      result = { html: '', missing: [], error: 'CSS previews through an HTML page. Create an index.html that links this stylesheet.' };
    } else if (['json', 'txt', 'csv', 'log', ''].includes(ext)) {
      result = { html: shell(name, `<pre>${escapeHtml(file.text)}</pre>`), missing: [], error: null };
    } else {
      result = { html: '', missing: [], error: `No live preview for .${ext} files. Previews run HTML, JavaScript, TypeScript, Python and Lua games, Markdown and SVG.` };
    }
  } catch (err) {
    return { html: '', missing: [], error: err.message || String(err) };
  }
  if (result.html.length > MAX_PREVIEW_CHARS) {
    return { html: '', missing: result.missing, error: `The bundled page is ${formatSize(result.html.length)}, over the 2 MB preview limit.` };
  }
  return result;
}

export function formatSize(chars) {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(chars < 10240 ? 1 : 0)} KB`;
  return `${(chars / 1024 / 1024).toFixed(2)} MB`;
}

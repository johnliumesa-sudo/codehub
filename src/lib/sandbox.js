// Sandboxed execution of untrusted HTML/JS (public games and the live preview).
//
// Model: every document runs in <iframe sandbox="allow-scripts" srcdoc=…>. Without
// allow-same-origin the frame gets an opaque origin, so it cannot reach the app's IndexedDB auth
// session, the in-memory keys, cookies, localStorage or the parent DOM. A CSP <meta> is prepended
// before the user's markup; a CSP the user adds later can only tighten it. connect-src 'none'
// means no fetch/XHR/WebSocket: previews and games have no network in v1.
//
// Never add allow-same-origin, allow-popups, allow-top-navigation, allow-forms or allow-modals.
// Known residual: a frame can still navigate *itself* to an external URL. It still has no access to
// anything of the user's; anything typed into a game should be treated as public.

export const SANDBOX = 'allow-scripts';

export const GAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

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
 * before any user markup is parsed; in preview mode the console bridge runs before user scripts.
 */
export function buildSrcdoc(html, { mode = 'game', token } = {}) {
  const head =
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    GAME_CSP.replace(/"/g, '&quot;') +
    '"><meta name="referrer" content="no-referrer">';
  return head + (mode === 'preview' ? consoleBridge(token) : '') + String(html ?? '');
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

/**
 * Inline the workspace files an HTML entry references:
 *   <link rel="stylesheet" href="x.css">     -> <style>…</style>
 *   <script src="x.js"></script>             -> <script>…</script> (</script and <!-- escaped)
 *   <script src="x.js" defer|async>          -> <script defer src="data:text/javascript;base64,…">
 *                                               (inline scripts ignore defer; data: keeps the timing)
 *   <img src="x.svg">                        -> data:image/svg+xml URL
 * References are resolved relative to the HTML file's directory ("/x" = workspace root).
 * External references are left alone (the CSP blocks network anyway).
 * Returns { html, inlined: [path], missing: [ref] }.
 */
export function bundle(entryPath, files) {
  const map = fileMap(files);
  const entry = cleanPath(entryPath);
  if (!map.has(entry)) throw new Error(`Entry file not found: ${entryPath}`);
  const inlined = new Set();
  const missing = new Set();

  const lookup = (refValue) => {
    if (!refValue) return null;
    const p = resolveRef(entry, refValue);
    if (p === null) return null;
    if (!map.has(p)) {
      missing.add(refValue);
      return null;
    }
    inlined.add(p);
    return { path: p, text: map.get(p) };
  };

  let html = map.get(entry);

  // Scripts with a src and an empty body. Inline scripts are left untouched.
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attrSrc, body) => {
    const attrs = parseAttrs(attrSrc);
    const src = getAttr(attrs, 'src');
    if (!src || body.trim()) return whole;
    const file = lookup(src);
    if (!file) return whole;
    const rest = attrs.filter((a) => !['src', 'integrity', 'crossorigin', 'nonce'].includes(a.name));
    const type = (getAttr(attrs, 'type') || '').toLowerCase();
    const isModule = type === 'module';
    if (!isModule && (hasAttr(attrs, 'defer') || hasAttr(attrs, 'async'))) {
      const dataUrl = `data:text/javascript;base64,${utf8Base64(file.text)}`;
      return `<script${serializeAttrs([...rest, { name: 'src', value: dataUrl }])}></script>`;
    }
    const kept = rest.filter((a) => a.name !== 'defer' && a.name !== 'async');
    return `<script${serializeAttrs(kept)}>\n${escapeScript(file.text)}\n</script>`;
  });

  // Stylesheets.
  html = html.replace(/<link\b([^>]*)>/gi, (whole, attrSrc) => {
    const attrs = parseAttrs(attrSrc);
    const rel = (getAttr(attrs, 'rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) return whole;
    const file = lookup(getAttr(attrs, 'href'));
    if (!file) return whole;
    const media = getAttr(attrs, 'media');
    return `<style${media ? serializeAttrs([{ name: 'media', value: media }]) : ''}>\n${escapeStyle(file.text)}\n</style>`;
  });

  // SVG images (the workspace holds text files only, so SVG is the one image type we can inline).
  html = html.replace(/<img\b([^>]*)>/gi, (whole, attrSrc) => {
    const attrs = parseAttrs(attrSrc);
    const src = getAttr(attrs, 'src');
    if (!src || extOf(src.split(/[?#]/)[0]) !== 'svg') return whole;
    const file = lookup(src);
    if (!file) return whole;
    const next = attrs.map((a) => (a.name === 'src' ? { name: 'src', value: `data:image/svg+xml;base64,${utf8Base64(file.text)}` } : a));
    return `<img${serializeAttrs(next)}>`;
  });

  return { html, inlined: [...inlined], missing: [...missing] };
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

/** HTML files in the workspace that reference `path` via <script src> / <link href> / <img src>. */
export function htmlFilesReferencing(path, files) {
  const target = cleanPath(path);
  const out = [];
  for (const f of files || []) {
    if (!isHtmlPath(f.path) || typeof f.text !== 'string') continue;
    const re = /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(f.text))) {
      if (resolveRef(f.path, decodeEntities(m[1] ?? m[2] ?? m[3])) === target) {
        out.push(cleanPath(f.path));
        break;
      }
    }
  }
  return out;
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
      result = { html: b.html, missing: b.missing, error: null };
    } else if (ext === 'md' || ext === 'markdown') {
      const body = renderMarkdown ? renderMarkdown(file.text) : `<pre>${escapeHtml(file.text)}</pre>`;
      result = { html: shell(name, `<article>${body}</article>`), missing: [], error: null };
    } else if (ext === 'js' || ext === 'cjs' || ext === 'mjs') {
      const type = ext === 'mjs' ? ' type="module"' : '';
      const body =
        `<p style="color:#6b7487;font-size:12px;margin:0 0 12px">Running <code>${escapeHtml(name)}</code>. ` +
        'Output appears in the console below; <code>document.body</code> is yours to draw in.</p>' +
        `<script${type}>\n${escapeScript(file.text)}\n</script>`;
      result = { html: shell(name, body), missing: [], error: null };
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
      result = { html: '', missing: [], error: `No live preview for .${ext} files. Previews run HTML, Markdown, SVG and JavaScript.` };
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

// Run code snippets (pure): find runnable code in a message body and build the document the sandbox
// (src/lib/sandbox.js + SandboxFrame, preview mode with the console bridge) runs.
//
//  - JavaScript runs in a Web Worker started inside the sandboxed frame, so a busy loop never blocks
//    the page: the frame terminates the worker after RUN_LIMIT_MS. Console output is relayed through
//    the frame's console (the bridge forwards it to the parent as text).
//  - HTML (with the message's CSS and JS blocks inlined) renders in the frame itself. A heartbeat
//    from the frame lets the parent tear it down when the page is busy for RUN_LIMIT_MS.
// Status markers travel as console.debug lines that start with MARK; the parent strips them.

export const RUN_LIMIT_MS = 5000;
export const MAX_RUN_CHARS = 100_000;
export const MARK = '⁣codehub-run:';
export const HEARTBEAT_MS = 500;

const LANGS = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css',
};

/** Normalised runnable language of a fence/snippet language, or null. */
export function runLang(lang) {
  const k = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  return LANGS[k] || null;
}

const FENCE_RE = /(^|\n)[ \t]*```[ \t]*([A-Za-z0-9+#._-]*)[^\n]*\n([\s\S]*?)\n?[ \t]*```(?=[ \t]*(\n|$))/g;

/** Fenced code blocks of message text: [{ lang, code }] (any language). */
export function fencedBlocks(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('```')) return out;
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text))) out.push({ lang: m[2] || '', code: m[3] });
  return out;
}

/**
 * Runnable units of a message body. One HTML page when the message has an HTML block (its CSS and
 * JS blocks are inlined into it); otherwise one entry per JavaScript block. CSS alone is not runnable.
 * Returns [{ id, kind: 'js' | 'html', label, code? , html?, css?, js? }].
 */
export function extractRunnables(body) {
  if (!body || typeof body !== 'object') return [];
  const blocks = fencedBlocks(body.text);
  const code = body.code;
  if (code && typeof code === 'object' && typeof code.content === 'string') {
    const lang = runLang(code.lang) || runLang(String(code.filename || '').split('.').pop());
    if (lang) blocks.push({ lang, code: code.content, snippet: true });
  }
  const typed = blocks
    .map((b, i) => ({ ...b, kind: runLang(b.lang), i }))
    .filter((b) => b.kind && b.code.trim() && b.code.length <= MAX_RUN_CHARS);
  const html = typed.filter((b) => b.kind === 'html');
  const css = typed.filter((b) => b.kind === 'css');
  const js = typed.filter((b) => b.kind === 'js');
  if (html.length) {
    const parts = ['HTML', css.length ? 'CSS' : null, js.length ? 'JS' : null].filter(Boolean);
    return [{
      id: 'html',
      kind: 'html',
      label: parts.join(' + '),
      html: html.map((b) => b.code).join('\n'),
      css: css.map((b) => b.code),
      js: js.map((b) => b.code),
    }];
  }
  return js.map((b, n) => ({
    id: `js${n}`,
    kind: 'js',
    label: js.length > 1 ? `JavaScript (block ${n + 1})` : 'JavaScript',
    code: b.code,
  }));
}

/** Make text safe inside <script>…</script> / <style>…</style>. */
const escScript = (s) => String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const escStyle = (s) => String(s).replace(/<\/(style)/gi, '<\\/$1');
const jsString = (s) => JSON.stringify(String(s)).replace(/</g, '\\u003c'); // "</script>" can't end the inline script

const HEARTBEAT = `<script>(function(){var M=${jsString(MARK)};setInterval(function(){console.debug(M+"hb")},${HEARTBEAT_MS});})();</script>`;

// Inside the worker: console + error reporting as {__r:1, l, a:[string]} messages to the frame.
const PRELUDE_SRC = [
  '(function(){',
  'var P=self.postMessage.bind(self);',
  // Stack frames point into the worker's blob/data URL; show them as snippet:<line>:<col> of the user's code.
  'function clean(s){return s.replace(/(?:blob|data):[^\\s)]*?:(\\d+):(\\d+)/g,function(m,l,c){return "snippet:"+Math.max(1,l-__PL__)+":"+c;});}',
  'function f(v,s){try{if(typeof v==="string")return v;if(v===undefined)return "undefined";if(v===null)return "null";',
  'if(typeof v==="function")return "\\u0192 "+(v.name||"anonymous")+"()";if(typeof v==="bigint")return String(v)+"n";',
  'if(typeof v!=="object")return String(v);if(v instanceof Error)return v.stack&&String(v.stack).indexOf(v.message)>=0?clean(String(v.stack)):(v.name+": "+v.message);',
  's=[];return JSON.stringify(v,function(k,x){if(typeof x==="bigint")return String(x)+"n";if(typeof x==="function")return "\\u0192 "+(x.name||"anonymous")+"()";',
  'if(x===undefined)return "undefined";if(x&&typeof x==="object"){if(s.indexOf(x)>=0)return "[Circular]";s.push(x);}return x;},2);',
  '}catch(e){try{return Object.prototype.toString.call(v);}catch(e2){return "[unprintable]";}}}',
  'function send(l,args){var a=[];for(var i=0;i<args.length&&i<20;i++){var s=f(args[i]);if(s.length>4000)s=s.slice(0,4000)+"\\u2026";a.push(s);}try{P({__r:1,l:l,a:a});}catch(e){}}',
  '["log","info","warn","error","debug"].forEach(function(l){console[l]=function(){send(l==="debug"?"log":l,arguments);};});',
  'console.clear=function(){try{P({__r:1,l:"clear",a:[]});}catch(e){}};',
  'self.addEventListener("unhandledrejection",function(e){send("error",["Unhandled promise rejection: "+f(e&&e.reason)]);});',
  '})();',
].join('\n');
export const PRELUDE_LINES = PRELUDE_SRC.split('\n').length;
const WORKER_PRELUDE = PRELUDE_SRC.replace('__PL__', String(PRELUDE_LINES));

/**
 * Document for a JavaScript snippet: starts a worker with the code, relays its console, ends the run
 * after RUN_LIMIT_MS (marker "end" when the code finished, "timeout" when it was still busy).
 * Without worker support it falls back to running on the frame's own page.
 */
export function buildJsDocument(code) {
  const src = `${WORKER_PRELUDE}\n${String(code)}\n;postMessage({__r:1,l:"__done",a:[]});`;
  const fallback = `${String(code)}`;
  return (
    '<html><head><style>html{color-scheme:light dark}body{margin:8px;font:13px/1.5 system-ui,sans-serif}</style></head><body>' +
    HEARTBEAT +
    '<script>(function(){' +
    `var M=${jsString(MARK)},SRC=${jsString(src)},FB=${jsString(fallback)},LIMIT=${RUN_LIMIT_MS},PL=${PRELUDE_LINES};` +
    'var LV={log:1,info:1,warn:1,error:1,clear:1},done=false,ended=false,w=null;' +
    'function end(k){if(ended)return;ended=true;try{w&&w.terminate();}catch(e){}console.debug(M+k);}' +
    'function start(url){var x=new Worker(url);x.onmessage=function(e){var d=e.data;if(!d||d.__r!==1)return;' +
    'if(d.l==="__done"){done=true;console.debug(M+"done");return;}' +
    'var l=LV[d.l]?d.l:"log";var a=Array.isArray(d.a)?d.a.slice(0,20).map(String):[];' +
    'if(l==="clear")console.clear();else console[l].apply(console,a);};' +
    'x.onerror=function(e){if(e&&e.preventDefault)e.preventDefault();var m=(e&&e.message)||"Script error";' +
    'if(e&&e.lineno)m+=" (line "+Math.max(1,e.lineno-PL)+")";console.error((/^Uncaught/.test(m)?"":"Uncaught ")+m);done=true;console.debug(M+"done");};return x;}' +
    'try{w=start(URL.createObjectURL(new Blob([SRC],{type:"text/javascript"})));}catch(e1){' +
    'try{w=start("data:text/javascript;charset=utf-8,"+encodeURIComponent(SRC));}catch(e2){w=null;}}' +
    'setTimeout(function(){end(done?"end":"timeout");},LIMIT);' +
    'if(!w){console.info("Web Workers are unavailable here, so the snippet runs on the page.");' +
    'var s=document.createElement("script");s.textContent=FB;document.body.appendChild(s);done=true;console.debug(M+"done");}' +
    '})();</' +
    'script></body></html>'
  );
}

/** Document for an HTML snippet, with the message's CSS (in <head>) and JS (end of <body>) inlined. */
export function buildHtmlDocument({ html, css = [], js = [] }) {
  const styles = css.map((c) => `<style>\n${escStyle(c)}\n</style>`).join('');
  const scripts = js.map((c) => `<script>\n${escScript(c)}\n</script>`).join('');
  const page = String(html || '');
  // Full documents keep their own structure; fragments get a minimal shell.
  if (/<html[\s>]/i.test(page) || /<body[\s>]/i.test(page)) {
    let out = page;
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${styles}</head>`) : `${styles}${out}`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${scripts}</body>`) : `${out}${scripts}`;
    return `${HEARTBEAT}${out}`;
  }
  return `<html><head>${HEARTBEAT}<style>html{color-scheme:light dark}body{margin:8px;font:14px/1.5 system-ui,sans-serif}</style>${styles}</head><body>${page}${scripts}</body></html>`;
}

/** Classify one console line from the frame: { mark: 'hb'|'done'|'end'|'timeout' } or { line }. */
export function readConsole(entry) {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith(MARK)) {
    const mark = args[0].slice(MARK.length);
    if (['hb', 'done', 'end', 'timeout'].includes(mark)) return { mark };
  }
  const level = ['log', 'info', 'warn', 'error', 'clear'].includes(entry?.level) ? entry.level : 'log';
  return { line: { level, text: args.map((a) => String(a)).join(' ') } };
}

// Lua games: Lua 5.4 compiled to WebAssembly (wasmoon, about 145 KB, from jsDelivr). The workspace's
// .lua files are mounted so require("enemy") works; the entry runs with loadfile on a guarded thread. The page has a canvas,
// an on-screen console and an input line.
//
// Lua API on top of the standard library:
//   print(...)            on-screen console        input(prompt) -> string    (waits for Enter)
//   sleep(seconds)        pause without freezing   frame() -> dt seconds      (waits for the next frame)
//   canvas, ctx           the <canvas> and its 2D context (ctx:fillRect(…), ctx.fillStyle = "#fc0")
//   keydown(key) -> bool  is a key held ("ArrowLeft", "a", " ")   now() -> milliseconds
//   document, window      the page's DOM
// A loop that runs 4 seconds without frame(), sleep() or input() is stopped with an error, so it can't
// hang Codehub.
import { cleanPath, escapeHtml, escapeScript, extOf } from '../sandbox.js';
import { jsonForScript } from '../sandboxPlay.js';

export const WASMOON_VERSION = '1.16.0';
export const WASMOON_URL = `https://cdn.jsdelivr.net/npm/wasmoon@${WASMOON_VERSION}/+esm`;
export const WASMOON_WASM = `https://cdn.jsdelivr.net/npm/wasmoon@${WASMOON_VERSION}/dist/glue.wasm`;

const LUA_EXTS = ['lua', 'txt', 'json', 'csv', 'md', 'dat'];
const ignored = (p) => /(^|\/)(node_modules|\.git)\//.test(p) || /(^|\/)\.[^/]/.test(p);

export function luaFiles(files) {
  const out = {};
  for (const f of files || []) {
    const p = cleanPath(f?.path);
    if (!p || typeof f.text !== 'string' || ignored(p) || !LUA_EXTS.includes(extOf(p))) continue;
    out[p] = f.text;
  }
  return out;
}

const PRELUDE = `
local _cx = __cx
__cx = nil
function input(prompt)
  return _cx.input(prompt == nil and "" or tostring(prompt)):await()
end
function sleep(seconds)
  _cx.sleep((tonumber(seconds) or 0) * 1000):await()
end
function frame()
  return _cx.frame():await()
end
function keydown(key)
  return _cx.keydown(tostring(key))
end
now = _cx.now
canvas = _cx.canvas
ctx = _cx.ctx
document = _cx.document
window = _cx.window
local _busy = _cx.busy
local _sethook = debug.sethook
-- Hooks are per coroutine: the runner installs it on the thread that runs the game.
function __cx_guard()
  _sethook(function()
    if _busy() then error("this loop ran for 4 seconds without calling frame(), sleep() or input(), so it was stopped to keep the page responsive", 2) end
  end, "", 1000000)
end
`;

/** Lua that runs the entry file on the current thread, with the busy-loop guard installed. */
const runEntry = (entry) =>
  `__cx_guard()\n__cx_guard = nil\nlocal chunk, err = loadfile(${JSON.stringify(entry)})\nif not chunk then error(err, 0) end\nreturn chunk()\n`;

const CSS =
  'html,body{margin:0;height:100%;background:#0d1017;color:#e6e9f0;color-scheme:dark}' +
  '#cx{display:flex;flex-direction:column;height:100%;font:13.5px/1.5 ui-monospace,Menlo,Consolas,monospace}' +
  '#cx-stage{flex:1 1 60%;min-height:0;display:flex;align-items:center;justify-content:center;background:#000}' +
  '#cx-stage[hidden]{display:none}#canvas{max-width:100%;max-height:100%;outline:none}' +
  '#cx-con{flex:1 1 40%;min-height:3em;margin:0;padding:8px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}' +
  '#cx-stage:not([hidden])~#cx-con{flex:0 1 auto;max-height:32%;border-top:1px solid #222838}' +
  '#cx-con:empty{display:none}.err{color:#ff8080}.sys{color:#8a94a8}.echo{color:#7fd1ff}' +
  '#cx-in{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid #222838;background:#121621}' +
  '#cx-in[hidden]{display:none}#cx-in label{color:#7fd1ff;white-space:pre}' +
  '#cx-field{flex:1;min-width:0;background:#1b2130;color:inherit;border:1px solid #39425a;border-radius:6px;font:inherit;padding:5px 8px}' +
  '#cx-field:focus{outline:2px solid #5b8cff;outline-offset:0}' +
  '#cx-in button{background:#5b8cff;color:#fff;border:0;border-radius:6px;font:600 12px system-ui,sans-serif;padding:6px 10px;cursor:pointer}';

// Runs in the frame as a module (self-contained, serialised with toString). C = { url, wasm, prelude, run, canvas }.
/* eslint-disable prefer-arrow-callback, func-names */
// `load(url)` is import(url), written into the page text (see luaDoc) so the app's bundler never
// rewrites it: this code runs only in the frame.
async function luaBoot(C, load) {
  const D = document;
  const W = window;
  const con = D.getElementById('cx-con');
  const stage = D.getElementById('cx-stage');
  const canvas = D.getElementById('canvas');
  const form = D.getElementById('cx-in');
  const field = D.getElementById('cx-field');
  const label = D.getElementById('cx-prompt');
  let lines = 0;
  const write = (text, cls) => {
    const s = D.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    con.appendChild(s);
    if (++lines > 1500) con.removeChild(con.firstChild);
    con.scrollTop = con.scrollHeight;
    if (cls === 'err') console.error(text.replace(/\n$/, ''));
    else if (cls !== 'sys' && cls !== 'echo') console.log(text.replace(/\n$/, ''));
  };
  const report = (message) => {
    try {
      W.dispatchEvent(new ErrorEvent('error', { message }));
    } catch {
      /* ignore */
    }
  };
  let last = performance.now();
  const touch = () => {
    last = performance.now();
  };
  let waiting = null;
  const submit = () => {
    if (!waiting) return;
    const v = field.value;
    const r = waiting;
    waiting = null;
    form.hidden = true;
    write(`${v}\n`, 'echo');
    touch();
    r(v);
    if (!stage.hidden) canvas.focus();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  D.getElementById('cx-send').addEventListener('click', submit);
  const keys = new Set();
  W.addEventListener('keydown', (e) => {
    if (D.activeElement === field) return;
    keys.add(e.key);
    if (e.key.length === 1) keys.add(e.key.toLowerCase());
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  });
  W.addEventListener('keyup', (e) => {
    keys.delete(e.key);
    if (e.key.length === 1) keys.delete(e.key.toLowerCase());
  });
  W.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('pointerdown', () => canvas.focus());
  if (C.canvas) {
    stage.hidden = false;
    canvas.focus();
  }
  write('Loading Lua…\n', 'sys');
  let lua;
  try {
    const { LuaFactory } = await load(C.url);
    const factory = new LuaFactory(C.wasm);
    const files = JSON.parse(D.getElementById('cx-files').textContent);
    for (const p of Object.keys(files)) await factory.mountFile(p, files[p]);
    lua = await factory.createEngine();
  } catch (e) {
    const m = `Lua could not start: ${(e && e.message) || e}`;
    write(`${m}\n`, 'err');
    report(m);
    return;
  }
  con.textContent = '';
  lines = 0;
  let prevFrame = performance.now();
  const g = lua.global;
  g.set('print', (...a) => write(`${a.map((v) => (v === null || v === undefined ? 'nil' : String(v))).join('\t')}\n`));
  g.set('__cx', {
    input: (prompt) =>
      new Promise((res) => {
        if (prompt) write(prompt);
        waiting = res;
        label.textContent = prompt ? String(prompt).split('\n').pop() || '>' : '>';
        form.hidden = false;
        field.value = '';
        field.focus();
      }),
    sleep: (ms) =>
      new Promise((res) => {
        setTimeout(() => {
          touch();
          res();
        }, Math.max(0, Number(ms) || 0));
      }),
    frame: () =>
      new Promise((res) => {
        requestAnimationFrame((t) => {
          const dt = Math.min(0.25, Math.max(0, (t - prevFrame) / 1000));
          prevFrame = t;
          touch();
          res(dt);
        });
      }),
    keydown: (k) => keys.has(k),
    now: () => performance.now(),
    busy: () => !waiting && performance.now() - last > 4000,
    canvas,
    ctx: canvas.getContext('2d'),
    document: D,
    window: W,
  });
  try {
    await lua.doString(C.prelude);
    touch();
    await lua.doString(C.run);
  } catch (e) {
    const m = String((e && e.message) || e);
    write(`${m}\n`, 'err');
    report(m.split('\n')[0]);
  }
}
/* eslint-enable prefer-arrow-callback, func-names */

/** The play document for a Lua entry. -> { html, files: [paths], features: { canvas } } */
export function luaDoc(entry, files, { title = '' } = {}) {
  const ent = cleanPath(entry);
  const fs = luaFiles(files);
  if (!Object.prototype.hasOwnProperty.call(fs, ent)) throw new Error(`Entry file not found: ${entry}`);
  const src = Object.keys(fs).filter((p) => p.endsWith('.lua')).map((p) => fs[p]).join('\n');
  const canvas = /\b(?:ctx|canvas)\b/.test(src);
  const cfg = { url: WASMOON_URL, wasm: WASMOON_WASM, prelude: PRELUDE, run: runEntry(ent), canvas };
  const html =
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title || ent)}</title><style>${CSS}</style>` +
    '<div id="cx">' +
    '<div id="cx-stage" hidden><canvas id="canvas" width="640" height="400" tabindex="0" aria-label="Game"></canvas></div>' +
    '<pre id="cx-con" role="log" aria-live="polite" aria-label="Lua output"></pre>' +
    '<div id="cx-in" hidden><label id="cx-prompt" for="cx-field">&gt;</label>' +
    '<input id="cx-field" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Input for the program">' +
    '<button type="button" id="cx-send">Enter</button></div>' +
    '</div>' +
    `<script type="application/json" id="cx-files">${jsonForScript(fs)}</script>` +
    `<script type="module">(${escapeScript(luaBoot.toString())})(${jsonForScript(cfg)}, (u) => import(u));</script>`;
  return { html, files: Object.keys(fs), features: { canvas } };
}

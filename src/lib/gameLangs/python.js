// Python games: a self-contained page that loads Pyodide (CPython compiled to WebAssembly) from
// jsDelivr, writes the workspace's Python and data files into its file system and runs the entry with
// runpy. The page has an on-screen console (print, stderr, tracebacks), an input line for input(),
// and a canvas for pygame-ce, turtle and `from js import document` games.
//
// Pausing Python (input(), time.sleep, a pygame loop) uses JSPI (WebAssembly.Suspending, through
// pyodide.ffi.run_sync): Python suspends and the browser keeps painting and delivering input. Without
// JSPI the page says so instead of freezing. A watchdog (sys.monitoring JUMP events) gives the browser
// a frame at least every 50 ms, so a busy loop can't freeze Codehub; it slows tight loops 3-5x.
import { cleanPath, escapeHtml, escapeScript, extOf } from '../sandbox.js';
import { jsonForScript } from '../sandboxPlay.js';
import { TURTLE_PY } from './pyTurtle.js';

export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
export const PY_ROOT = '/home/pyodide/game/';
const PY_LIB = '/home/pyodide/codehub/';

/** Workspace files a Python game gets in its file system (code and text data it may open()). */
export const PY_FILE_EXTS = ['py', 'txt', 'json', 'csv', 'tsv', 'md', 'ini', 'cfg', 'toml', 'yaml', 'yml', 'dat', 'xml', 'svg'];

const ignored = (p) => /(^|\/)(node_modules|\.git|__pycache__)\//.test(p) || /(^|\/)\.[^/]/.test(p);

/** { path: text } of the files a Python game needs. */
export function pythonFiles(files) {
  const out = {};
  for (const f of files || []) {
    const p = cleanPath(f?.path);
    if (!p || typeof f.text !== 'string' || ignored(p) || !PY_FILE_EXTS.includes(extOf(p))) continue;
    out[p] = f.text;
  }
  return out;
}

const pySource = (files) => Object.keys(files).filter((p) => p.endsWith('.py')).map((p) => files[p]).join('\n');

/** Which optional pieces the code uses: pygame, turtle, a canvas (for the stage). */
export function pythonFeatures(files) {
  const src = pySource(files);
  const imports = (name) => new RegExp(`^\\s*(?:import\\s+[\\w., ]*\\b${name}\\b|from\\s+${name}\\b)`, 'm').test(src);
  const pygame = imports('pygame');
  const turtle = imports('turtle') && !Object.prototype.hasOwnProperty.call(files, 'turtle.py');
  const canvas = pygame || imports('turtle') || /\bgetElementById\(\s*["']canvas["']\s*\)/.test(src) || /\bcanvas\b/.test(src);
  return { pygame, turtle, canvas };
}

// Python run before the game: input()/time.sleep through JSPI, the watchdog, pygame patches that give
// the browser a frame, clean tracebacks (only the game's own frames, workspace-relative paths).
const PRELUDE = String.raw`
import builtins, sys, time, traceback, js
from pyodide.ffi import run_sync
try:
    from pyodide.ffi import can_run_sync
except ImportError:
    can_run_sync = None
_CX_JSPI = bool(js.__cx.jspi)
_CX_ROOT = __ROOT__
_last = [time.perf_counter()]
_NO_JSPI = ("This browser can't pause Python, so input(), time.sleep() and game loops can't run here. "
            "Try a current Chrome, Edge, Firefox or Safari.")

def _cx_can():
    if not _CX_JSPI:
        return False
    if can_run_sync is None:
        return True
    try:
        return bool(can_run_sync())
    except Exception:
        return False

def _cx_wait(ms):
    if _cx_can():
        run_sync(js.__cx.wait(ms))
    _last[0] = time.perf_counter()

def _cx_input(prompt=''):
    if not _cx_can():
        raise RuntimeError(_NO_JSPI)
    if prompt:
        sys.stdout.write(str(prompt))
    sys.stdout.flush()
    line = str(run_sync(js.__cx.readline(str(prompt))))
    _last[0] = time.perf_counter()
    return line

def _cx_sleep(s):
    s = float(s)
    if s < 0:
        raise ValueError("sleep length must be non-negative")
    _cx_wait(s * 1000)

builtins.input = _cx_input
time.sleep = _cx_sleep

# Watchdog: never run more than ~50 ms without letting the browser paint and handle input.
_n = [0]
def _cx_on_jump(code, off, dest):
    _n[0] += 1
    if _n[0] & 255:
        return
    if time.perf_counter() - _last[0] > 0.05 and _cx_can():
        _cx_wait(0)
try:
    _m = sys.monitoring
    _m.use_tool_id(3, "codehub-watchdog")
    _m.register_callback(3, _m.events.JUMP, _cx_on_jump)
    _m.set_events(3, _m.events.JUMP)
except Exception:
    pass

def _cx_patch_pygame():
    import pygame
    _Clock = pygame.time.Clock
    def _maybe_yield():
        if time.perf_counter() - _last[0] > 0.05:
            _cx_wait(0)
    class Clock:
        def __init__(self):
            self._c = _Clock()
            self._t = time.perf_counter()
        def tick(self, framerate=0):
            wait = 0.0
            if framerate and framerate > 0:
                wait = 1.0 / framerate - (time.perf_counter() - self._t)
            _cx_wait(max(0.0, wait) * 1000)
            self._t = time.perf_counter()
            return self._c.tick()
        tick_busy_loop = tick
        def get_fps(self): return self._c.get_fps()
        def get_time(self): return self._c.get_time()
        def get_rawtime(self): return self._c.get_rawtime()
    pygame.time.Clock = Clock
    pygame.time.delay = lambda ms: (_cx_wait(ms), int(ms))[1]
    pygame.time.wait = pygame.time.delay
    for name in ('flip', 'update'):
        orig = getattr(pygame.display, name)
        def wrapped(*a, _o=orig, **k):
            r = _o(*a, **k)
            _maybe_yield()
            return r
        setattr(pygame.display, name, wrapped)
    _get = pygame.event.get
    def get(*a, **k):
        _maybe_yield()
        return _get(*a, **k)
    pygame.event.get = get

def _cx_keep(fs):
    f = fs.filename or ''
    return not (f.startswith('<frozen runpy') or f.startswith('<exec>') or f.startswith('<codehub') or '/_pyodide/' in f or f.startswith(__LIB__))

def _cx_clean(te, seen=None):
    seen = seen or set()
    if te is None or id(te) in seen:
        return
    seen.add(id(te))
    te.stack = traceback.StackSummary.from_list([fs for fs in te.stack if _cx_keep(fs)])
    _cx_clean(te.__cause__, seen)
    _cx_clean(te.__context__, seen)

def _cx_main(entry):
    import os, runpy
    here = os.path.dirname(os.path.abspath(entry))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        runpy.run_path(entry, run_name='__main__')
    except SystemExit as e:
        if e.code not in (None, 0):
            print(f"Exited with code {e.code}", file=sys.stderr)
        return ''
    except BaseException as e:
        te = traceback.TracebackException.from_exception(e)
        _cx_clean(te)
        text = ''.join(te.format()).replace(_CX_ROOT, '')
        if isinstance(e, ModuleNotFoundError):
            text += ("Codehub can use the Python standard library and the packages that come with Pyodide "
                     "(pygame-ce, numpy …). pip and PyPI aren't available.\n")
        sys.stderr.write(text)
        where = ''
        if te.stack:
            last = te.stack[-1]
            where = f" ({last.filename.replace(_CX_ROOT, '')} line {last.lineno})"
        return f"{type(e).__name__}: {e}{where}"
    return ''
`;

const CSS =
  'html,body{margin:0;height:100%;background:#0d1017;color:#e6e9f0;color-scheme:dark}' +
  '#cx{display:flex;flex-direction:column;height:100%;font:13.5px/1.5 ui-monospace,Menlo,Consolas,monospace}' +
  '#cx-stage{flex:1 1 60%;min-height:0;display:flex;align-items:center;justify-content:center;background:#000}' +
  '#cx-stage[hidden]{display:none}#canvas{max-width:100%;max-height:100%;outline:none;image-rendering:pixelated}' +
  '#cx-status{display:flex;align-items:center;gap:10px;padding:8px 12px;color:#9aa3b5;border-bottom:1px solid #222838;' +
  'font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}#cx-status[hidden]{display:none}' +
  '#cx-status i{width:14px;height:14px;border:2px solid #39425a;border-top-color:#5b8cff;border-radius:50%;animation:s .8s linear infinite}' +
  '@keyframes s{to{transform:rotate(1turn)}}#cx-status b{color:#e6e9f0;font-weight:600}' +
  '#cx-con{flex:1 1 40%;min-height:3em;margin:0;padding:8px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}' +
  '#cx-stage:not([hidden])~#cx-con{flex:0 1 auto;max-height:32%;border-top:1px solid #222838}' +
  '#cx-con:empty{display:none}.err{color:#ff8080}.sys{color:#8a94a8}.echo{color:#7fd1ff}' +
  '#cx-in{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid #222838;background:#121621}' +
  '#cx-in[hidden]{display:none}#cx-in label{color:#7fd1ff;white-space:pre}' +
  '#cx-field{flex:1;min-width:0;background:#1b2130;color:inherit;border:1px solid #39425a;border-radius:6px;font:inherit;padding:5px 8px}' +
  '#cx-field:focus{outline:2px solid #5b8cff;outline-offset:0}' +
  '#cx-in button{background:#5b8cff;color:#fff;border:0;border-radius:6px;font:600 12px system-ui,sans-serif;padding:6px 10px;cursor:pointer}';

// Runs in the frame (self-contained, serialised with toString): loads Pyodide, shows progress, wires stdout/stderr/stdin,
// writes the files and runs the entry. C = { url, entry, root, lib, prelude, turtle, pygame, canvas, version }.
/* eslint-disable no-var, prefer-arrow-callback, func-names */
function pyBoot(C) {
  'use strict';
  var D = document;
  var W = window;
  var con = D.getElementById('cx-con');
  var stage = D.getElementById('cx-stage');
  var canvas = D.getElementById('canvas');
  var status = D.getElementById('cx-status');
  var statusText = D.getElementById('cx-status-text');
  var form = D.getElementById('cx-in');
  var field = D.getElementById('cx-field');
  var label = D.getElementById('cx-prompt');
  var t0 = Date.now();
  var step = '';
  var timer = setInterval(function () {
    statusText.textContent = step + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s';
  }, 100);
  function setStep(s) {
    step = s;
    statusText.textContent = s;
  }
  var lines = 0;
  var pending = { out: '', err: '' };
  function write(text, cls) {
    if (!text) return;
    var last = con.lastChild;
    if (last && (last.className || '') === (cls || '') && last.textContent.length < 2000) last.textContent += text;
    else {
      var s = D.createElement('span');
      if (cls) s.className = cls;
      s.textContent = text;
      con.appendChild(s);
      if (++lines > 1500) con.removeChild(con.firstChild);
    }
    con.scrollTop = con.scrollHeight;
    // Mirror whole lines to the browser console (the live preview shows it).
    if (cls === 'sys' || cls === 'echo') return;
    var key = cls === 'err' ? 'err' : 'out';
    pending[key] += text;
    var i = pending[key].lastIndexOf('\n');
    if (i >= 0) {
      var done = pending[key].slice(0, i);
      pending[key] = pending[key].slice(i + 1);
      try {
        (key === 'err' ? console.error : console.log)(done);
      } catch (e) {
        /* ignore */
      }
    }
  }
  function report(message) {
    try {
      W.dispatchEvent(new ErrorEvent('error', { message: message }));
    } catch (e) {
      /* ignore */
    }
  }
  function fail(message) {
    clearInterval(timer);
    status.hidden = true;
    write(message + '\n', 'err');
    report(message);
  }
  var waiting = null;
  function submit() {
    if (!waiting) return;
    var v = field.value;
    var r = waiting;
    waiting = null;
    form.hidden = true;
    write(v + '\n', 'echo');
    r(v);
    if (!stage.hidden) canvas.focus();
  }
  field.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    submit();
  });
  D.getElementById('cx-send').addEventListener('click', submit);
  var jspi = typeof WebAssembly === 'object' && typeof WebAssembly.Suspending === 'function';
  W.__cx = {
    jspi: jspi,
    readline: function (prompt) {
      return new Promise(function (res) {
        waiting = res;
        label.textContent = prompt ? String(prompt).split('\n').pop() || '>' : '>';
        form.hidden = false;
        field.value = '';
        field.focus();
      });
    },
    wait: function (ms) {
      return new Promise(function (res) {
        ms = +ms || 0;
        if (ms > 4) {
          setTimeout(function () {
            requestAnimationFrame(function () {
              res();
            });
          }, ms - 4);
        } else {
          requestAnimationFrame(function () {
            res();
          });
        }
      });
    },
  };
  // Arrow keys and space shouldn't scroll the page while a game has focus.
  W.addEventListener('keydown', function (e) {
    if (D.activeElement === field) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(e.key) >= 0) e.preventDefault();
  });
  canvas.addEventListener('pointerdown', function () {
    canvas.focus();
  });
  if (C.canvas) {
    stage.hidden = false;
    canvas.focus();
  }

  function load() {
    return new Promise(function (res, rej) {
      if (typeof W.loadPyodide === 'function') return res();
      var s = D.createElement('script');
      s.src = C.url + 'pyodide.js';
      s.onload = function () {
        if (typeof W.loadPyodide === 'function') res();
        else rej(new Error('pyodide.js loaded but did not start'));
      };
      s.onerror = function () {
        rej(new Error('Couldn’t download Python from ' + C.url + ' (offline, or the CDN is unreachable).'));
      };
      D.head.appendChild(s);
    });
  }

  async function main() {
    setStep('Downloading Python ' + C.version + ' (about 6 MB the first time)…');
    await load();
    var py = await W.loadPyodide({ indexURL: C.url, stdout: function () {}, stderr: function () {} });
    var dec = { out: new TextDecoder(), err: new TextDecoder() };
    py.setStdout({
      write: function (b) {
        write(dec.out.decode(b, { stream: true }));
        return b.length;
      },
    });
    py.setStderr({
      write: function (b) {
        write(dec.err.decode(b, { stream: true }), 'err');
        return b.length;
      },
    });
    setStep('Preparing files…');
    var files = JSON.parse(D.getElementById('cx-files').textContent);
    Object.keys(files).forEach(function (p) {
      var full = C.root + p;
      py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      py.FS.writeFile(full, files[p]);
    });
    py.FS.mkdirTree(C.lib);
    if (C.turtle) py.FS.writeFile(C.lib + 'turtle.py', C.turtle);
    py.FS.chdir(C.root);
    var src = Object.keys(files)
      .filter(function (p) {
        return /\.py$/.test(p);
      })
      .map(function (p) {
        return files[p];
      })
      .join('\n');
    if (C.pygame) setStep('Downloading pygame-ce (about 1.5 MB the first time)…');
    else setStep('Loading packages…');
    await py.loadPackagesFromImports(src, {
      messageCallback: function (m) {
        if (/^Loading /.test(m)) setStep(m + '…');
      },
      errorCallback: function (m) {
        write(m + '\n', 'err');
      },
    });
    if (C.pygame) py.canvas.setCanvas2D(canvas);
    py.runPython('import sys\nsys.path.insert(0, ' + JSON.stringify(C.lib) + ')\nsys.path.insert(0, ' + JSON.stringify(C.root) + ')');
    py.runPython(C.prelude, { filename: '<codehub>' });
    if (C.pygame && jspi) py.runPython('_cx_patch_pygame()');
    clearInterval(timer);
    status.hidden = true;
    if (!jspi) {
      write("This browser can't pause Python: input(), time.sleep() and game loops won't work here. Try a current Chrome, Edge, Firefox or Safari.\n", 'sys');
      if (C.pygame) {
        fail('pygame games need a browser that can pause Python (WebAssembly JSPI).');
        return;
      }
    }
    var err = await py.runPythonAsync('_cx_main(' + JSON.stringify(C.entry) + ')', { filename: '<codehub>' });
    var tail = (pending.out ? pending.out : '') + (pending.err ? pending.err : '');
    if (tail) {
      try {
        console.log(tail);
      } catch (e) {
        /* ignore */
      }
      pending.out = '';
      pending.err = '';
    }
    if (err) report(String(err));
  }
  main().catch(function (e) {
    fail('Python could not start: ' + ((e && e.message) || e));
  });
}
/* eslint-enable no-var, prefer-arrow-callback, func-names */

/**
 * The play document for a Python entry. -> { html, files: [paths], features: { pygame, turtle, canvas } }
 * `title` names the page; `pyodideUrl` is only overridden by tests.
 */
export function pythonDoc(entry, files, { title = '', pyodideUrl = PYODIDE_URL } = {}) {
  const ent = cleanPath(entry);
  const fs = pythonFiles(files);
  if (!Object.prototype.hasOwnProperty.call(fs, ent)) throw new Error(`Entry file not found: ${entry}`);
  const features = pythonFeatures(fs);
  const prelude = PRELUDE.replace('__ROOT__', JSON.stringify(PY_ROOT)).replace('__LIB__', JSON.stringify(PY_LIB));
  const cfg = {
    url: pyodideUrl,
    version: '3.14',
    entry: ent,
    root: PY_ROOT,
    lib: PY_LIB,
    prelude,
    turtle: features.turtle ? TURTLE_PY : '',
    pygame: features.pygame,
    canvas: features.canvas,
  };
  const html =
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title || ent)}</title><style>${CSS}</style>` +
    '<div id="cx">' +
    '<div id="cx-status" role="status" aria-live="polite"><i aria-hidden="true"></i><span id="cx-status-text">Starting Python…</span></div>' +
    '<div id="cx-stage" hidden><canvas id="canvas" width="640" height="400" tabindex="0" aria-label="Game"></canvas></div>' +
    '<pre id="cx-con" role="log" aria-live="polite" aria-label="Python output"></pre>' +
    '<div id="cx-in" hidden><label id="cx-prompt" for="cx-field">&gt;</label>' +
    '<input id="cx-field" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Input for the program">' +
    '<button type="button" id="cx-send">Enter</button></div>' +
    '</div>' +
    `<script type="application/json" id="cx-files">${jsonForScript(fs)}</script>` +
    `<script>(${escapeScript(pyBoot.toString())})(${jsonForScript(cfg)});</script>`;
  return { html, files: Object.keys(fs), features };
}

// The page a JavaScript / TypeScript / JSX / TSX game runs in when the workspace has no HTML page of
// its own: a canvas#game that fills the frame and an on-screen console. The entry file is loaded with
// <script type="module" src> (or a classic <script src> for plain scripts) and inlined by bundle().
import { escapeHtml, escapeScript } from '../sandbox.js';

export const LANG_META = 'codehub-lang';

/** <meta name="codehub-lang" content="py">: which language a published game was written in. */
export const langMarker = (lang) => `<meta name="${LANG_META}" content="${escapeHtml(lang)}">`;

/** The language marker a game document starts with ('js', 'ts', 'py', 'lua'), or 'html' without one. */
export function langOfDoc(html) {
  const m = /^<meta name="codehub-lang" content="(html|js|ts|py|lua)">/.exec(String(html || ''));
  return m ? m[1] : 'html';
}

export const SHELL_CSS =
  'html,body{margin:0;height:100%;background:#0d1017;color:#e6e9f0;color-scheme:dark;' +
  "font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  // Fills the frame at its automatic size; a game that sets its own size is centred (and scaled down,
  // keeping its aspect ratio, when it is larger than the frame).
  '#game{display:block;position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;outline:none;touch-action:none}' +
  '#game[hidden]{display:none}' +
  '#cx-console{position:fixed;left:8px;right:8px;bottom:8px;max-height:min(34vh,9em);display:flex;flex-direction:column;' +
  'background:rgba(13,16,23,.92);border:1px solid #2a3142;border-radius:8px;z-index:2147483646;' +
  'font:12.5px/1.45 ui-monospace,Menlo,Consolas,monospace;box-shadow:0 6px 22px rgba(0,0,0,.35)}' +
  '#cx-console[hidden]{display:none}#cx-console header{display:flex;align-items:center;gap:8px;padding:3px 6px 3px 10px;' +
  'color:#9aa3b5;font:600 11px/1.6 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase}' +
  '#cx-console header span{flex:1}#cx-console button{all:unset;cursor:pointer;color:#c9cfdb;padding:0 6px;border-radius:4px;font-size:16px;line-height:20px}' +
  '#cx-console button:hover,#cx-console button:focus-visible{background:#262d3d}' +
  '#cx-log{margin:0;padding:0 10px 8px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}' +
  '#cx-log .warn{color:#ffcb6b}#cx-log .error{color:#ff8080}';

// Runs in the frame before the game: sizes canvas#game to the frame (until the game sets its own
// size), hides it when the game never draws on it, and mirrors console output and uncaught errors into
// the on-screen console. ES5, self-contained (serialised with toString).
/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-rest-params */
function shellRuntime() {
  'use strict';
  var D = document;
  var W = window;
  var c = D.getElementById('game');
  var box = D.getElementById('cx-console');
  var log = D.getElementById('cx-log');
  var used = false;
  var auto = null;
  function fit() {
    if (!c) return;
    if (auto && (c.width !== auto[0] || c.height !== auto[1])) return; // the game sized it itself
    var w = Math.max(1, W.innerWidth || 1);
    var h = Math.max(1, W.innerHeight || 1);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    auto = [c.width, c.height];
  }
  fit();
  W.addEventListener('resize', fit);
  if (c) {
    var gc = c.getContext;
    c.getContext = function () {
      used = true;
      c.hidden = false;
      return gc.apply(c, arguments);
    };
    if (c.transferControlToOffscreen) {
      var tc = c.transferControlToOffscreen;
      c.transferControlToOffscreen = function () {
        used = true;
        return tc.apply(c, arguments);
      };
    }
    // A game that builds its own page (DOM, its own canvas) doesn't need ours.
    W.addEventListener('load', function () {
      setTimeout(function () {
        if (!used) c.hidden = true;
      }, 300);
    });
    c.addEventListener('pointerdown', function () {
      c.focus();
    });
  }
  D.getElementById('cx-hide').addEventListener('click', function () {
    box.hidden = true;
  });
  var n = 0;
  function add(level, parts) {
    var s = [];
    for (var i = 0; i < parts.length && i < 20; i++) {
      var v = parts[i];
      try {
        s.push(typeof v === 'string' ? v : v instanceof Error ? v.name + ': ' + v.message : JSON.stringify(v) === undefined ? String(v) : JSON.stringify(v));
      } catch (e) {
        s.push(String(v));
      }
    }
    var line = D.createElement('div');
    line.className = level;
    line.textContent = s.join(' ').slice(0, 4000);
    log.appendChild(line);
    if (++n > 300) log.removeChild(log.firstChild);
    box.hidden = false;
    log.scrollTop = log.scrollHeight;
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (l) {
    var o = console[l];
    console[l] = function () {
      try {
        add(l === 'warn' || l === 'error' ? l : 'log', Array.prototype.slice.call(arguments));
      } catch (e) {
        /* never break the game's logging */
      }
      if (o) return o.apply(console, arguments);
      return undefined;
    };
  });
  W.addEventListener('error', function (e) {
    if (!e || (e.target && e.target !== W)) return;
    add('error', [(e.message || 'Error') + (e.lineno ? ' (line ' + e.lineno + ')' : '')]);
  });
  W.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    add('error', ['Unhandled promise rejection: ' + (r && r.message ? r.message : String(r))]);
  });
}
/* eslint-enable no-var, prefer-arrow-callback, func-names, prefer-rest-params */

/**
 * The page for a JS/TS entry. `module`: load the entry as an ES module (always for TS/JSX, and for
 * JavaScript that uses import/export); otherwise a classic script, so top-level functions stay global.
 */
export function jsShellHtml({ entry, title, module = true }) {
  const src = `/${String(entry).split('/').map(encodeURIComponent).join('/')}`;
  return (
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title || entry)}</title><style>${SHELL_CSS}</style>` +
    '<canvas id="game" tabindex="0" aria-label="Game"></canvas>' +
    '<section id="cx-console" hidden aria-label="Console"><header><span>Console</span>' +
    '<button type="button" id="cx-hide" aria-label="Hide console" title="Hide console">×</button></header>' +
    '<pre id="cx-log" role="log" aria-live="polite"></pre></section>' +
    `<script>(${escapeScript(shellRuntime.toString())})();</script>` +
    `<script${module ? ' type="module"' : ''} src="${escapeHtml(src)}"></script>`
  );
}


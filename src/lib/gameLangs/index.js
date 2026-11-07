// The game language layer: workspace files + a chosen entry -> one self-contained play document.
// The live preview and the publish modal both call buildGameDoc, so what you preview is exactly what
// gets published (and what the Arcade plays).
//
//   .html/.htm         bundle() as before (scripts, styles, modules, data files inlined)
//   .js/.mjs           a game page (canvas#game + on-screen console) that runs the file; ES modules,
//                      npm imports and workspace files are bundled
//   .ts/.tsx/.jsx      the same page; each module is compiled with TypeScript 6 in the app
//                      (transpile.js, a lazy chunk) before it is bundled. A JSX/TSX file that only
//                      exports a React component (export default) is mounted into #root.
//   .py                Pyodide from jsDelivr (python.js)
//   .lua               wasmoon from jsDelivr (lua.js)
// Every document except plain HTML starts with <meta name="codehub-lang" content="…"> (jsShell.js).
import { bundle, cleanPath, MAX_PREVIEW_CHARS, formatSize } from '../sandbox.js';
import { looksLikeModule } from '../esmScan.js';
import { titleFromHtml } from '../gameText.js';
import { entryKind, needsTranspiler, TRANSPILE_EXTS, UNSUPPORTED, UNSUPPORTED_MESSAGE } from './langs.js';
import { jsShellHtml, langMarker, needsReactMount } from './jsShell.js';
import { makeTransform } from './transpile.js';
import { pythonDoc } from './python.js';
import { luaDoc } from './lua.js';

export * from './langs.js';
export { langOfDoc, langMarker } from './jsShell.js';
export { loadTypeScript, makeTransform } from './transpile.js';
export { PYODIDE_URL, PYODIDE_VERSION, pythonDoc, pythonFeatures } from './python.js';
export { WASMOON_URL, WASMOON_VERSION, luaDoc } from './lua.js';

const EMPTY = { missing: [], inlined: [], external: [], unpinned: [], modules: [], assets: [], errors: [] };

/** A readable default title for a game from its entry (the HTML <title>, else the file or folder name). */
export function gameTitle(entry, files, fallback = '') {
  const p = cleanPath(entry);
  const f = (files || []).find((x) => cleanPath(x.path) === p);
  const k = entryKind(p);
  if (k?.lang === 'html') {
    const t = titleFromHtml(f?.text);
    if (t) return t;
  }
  const parts = p.split('/');
  const base = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  if (/^(?:main|index|game|app|play|start)$/i.test(base)) {
    if (parts.length > 1 && !/^(?:src|lib|app)$/i.test(parts[parts.length - 2])) return parts[parts.length - 2];
    return fallback || base;
  }
  return base.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Build the play document for `entry`.
 *   ts     the TypeScript module (loadTypeScript()); required when needsTranspiler(entry, files)
 *   title  page title for generated pages
 * -> { html, lang, kind, missing, inlined, external, unpinned, modules, assets, errors, features?, error }
 * `error` is a message for the user when nothing can run (unsupported language, missing compiler …).
 */
export function buildGameDoc(entry, files, { ts = null, title = '' } = {}) {
  const path = cleanPath(entry);
  const kind = entryKind(path);
  if (!kind) {
    const ext = path.split('.').pop().toLowerCase();
    if (UNSUPPORTED[ext]) return { ...EMPTY, html: '', lang: null, kind: null, error: UNSUPPORTED_MESSAGE };
    return { ...EMPTY, html: '', lang: null, kind: null, error: `.${ext} files can’t run as a game.` };
  }
  const file = (files || []).find((f) => cleanPath(f.path) === path);
  if (!file || typeof file.text !== 'string') return { ...EMPTY, html: '', lang: kind.lang, kind, error: `Can’t read ${path}` };
  const transform = ts ? makeTransform(ts, files) : null;
  if (!transform && needsTranspiler(path, files)) {
    return { ...EMPTY, html: '', lang: kind.lang, kind, error: 'The TypeScript compiler isn’t loaded yet.' };
  }
  const opts = transform ? { transform, moduleExts: TRANSPILE_EXTS } : {};
  try {
    if (kind.lang === 'html') {
      const b = bundle(path, files, opts);
      return { ...EMPTY, ...b, lang: 'html', kind, error: null };
    }
    if (kind.lang === 'js' || kind.lang === 'ts') {
      const module = kind.transpile || kind.ext === 'mjs' || looksLikeModule(file.text);
      const mount = (kind.ext === 'jsx' || kind.ext === 'tsx') && needsReactMount(file.text, files);
      const page = jsShellHtml({ entry: path, title: title || gameTitle(path, files), module, mount });
      const b = bundle('__game__.html', files, { html: page, ...opts });
      return { ...EMPTY, ...b, html: langMarker(kind.lang) + b.html, lang: kind.lang, kind, error: null };
    }
    if (kind.lang === 'py') {
      const d = pythonDoc(path, files, { title: title || gameTitle(path, files) });
      return { ...EMPTY, html: langMarker('py') + d.html, inlined: d.files, features: d.features, lang: 'py', kind, error: null };
    }
    const d = luaDoc(path, files, { title: title || gameTitle(path, files) });
    return { ...EMPTY, html: langMarker('lua') + d.html, inlined: d.files, features: d.features, lang: 'lua', kind, error: null };
  } catch (err) {
    return { ...EMPTY, html: '', lang: kind.lang, kind, error: err?.message || String(err) };
  }
}

/** buildGameDoc for the live preview: also enforces the preview size limit. */
export function buildGamePreview(entry, files, opts) {
  const r = buildGameDoc(entry, files, opts);
  if (!r.error && r.html.length > MAX_PREVIEW_CHARS) {
    return { ...r, html: '', error: `The bundled page is ${formatSize(r.html.length)}, over the 2 MB preview limit.` };
  }
  return r;
}

// Which workspace files can run as a game, in which language, and which entry to run.
// Pure (no DOM, no TypeScript import): used by the live preview, the publish modal, the Arcade and the
// unit tests. See ./index.js for building the play document.
import { cleanPath, extOf, htmlFilesReferencing, isHtmlPath, resolveRef } from '../sandbox.js';

/** Languages a published game can record (games/{id}/lang, and the marker inside its code). */
export const LANGS = Object.freeze({
  html: { id: 'html', label: 'HTML' },
  js: { id: 'js', label: 'JavaScript' },
  ts: { id: 'ts', label: 'TypeScript' },
  py: { id: 'py', label: 'Python' },
  lua: { id: 'lua', label: 'Lua' },
});
export const LANG_IDS = Object.freeze(Object.keys(LANGS));
export const isLangId = (v) => typeof v === 'string' && LANG_IDS.includes(v);
export const langLabel = (id) => (isLangId(id) ? LANGS[id].label : '');

/** What a first play downloads (shown on Python games in the Arcade and the publish modal). */
export const PYTHON_FIRST_LOAD = 'Python games download about 6 MB the first time (pygame games about 7.5 MB), then load from the browser cache.';

// Entry kinds by extension. `transpile`: compiled in the app with TypeScript before it runs.
const KINDS = {
  html: { lang: 'html', label: 'HTML page' },
  htm: { lang: 'html', label: 'HTML page' },
  xhtml: { lang: 'html', label: 'HTML page' },
  js: { lang: 'js', label: 'JavaScript' },
  mjs: { lang: 'js', label: 'JavaScript' },
  jsx: { lang: 'js', label: 'JSX', transpile: true },
  ts: { lang: 'ts', label: 'TypeScript', transpile: true },
  mts: { lang: 'ts', label: 'TypeScript', transpile: true },
  tsx: { lang: 'ts', label: 'TSX', transpile: true },
  py: { lang: 'py', label: 'Python' },
  lua: { lang: 'lua', label: 'Lua' },
};

/** Extensions TypeScript compiles for us (module files). */
export const TRANSPILE_EXTS = ['ts', 'mts', 'tsx', 'jsx'];

/** Languages Codehub can't compile in the browser. */
export const UNSUPPORTED = Object.freeze({
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
});
export const UNSUPPORTED_MESSAGE =
  'C, C++, Rust, Java and Kotlin need a compiler that is too large to run in your browser, so Codehub can’t run or publish them. ' +
  'Write the game in JavaScript, TypeScript, Python or Lua, or compile it on your computer to a single-file JavaScript/WebAssembly ' +
  'HTML page and publish that.';
export const SUPPORTED_SUMMARY = 'HTML, JavaScript, TypeScript (also JSX/TSX), Python and Lua';

const isDeclaration = (p) => /\.d\.[mc]?ts$/i.test(p);
const ignored = (p) => /(^|\/)(node_modules|\.git)\//.test(p) || /(^|\/)\.[^/]/.test(p);

/** { ext, lang, label, transpile } for a file that can be a game entry, else null. */
export function entryKind(path) {
  const p = cleanPath(path);
  if (!p || isDeclaration(p)) return null;
  const ext = extOf(p);
  const k = KINDS[ext];
  return k ? { ext, lang: k.lang, label: k.label, transpile: !!k.transpile } : null;
}

/** Labels of the unsupported languages in the workspace ("C++", "Rust" …), in a stable order. */
export function unsupportedIn(files) {
  const found = new Set();
  for (const f of files || []) {
    const p = cleanPath(f?.path);
    if (!p || ignored(p)) continue;
    const label = UNSUPPORTED[extOf(p)];
    if (label) found.add(label);
  }
  return ['C', 'C++', 'Rust', 'Java', 'Kotlin'].filter((l) => found.has(l));
}

const family = (lang) => (lang === 'ts' ? 'js' : lang); // TS and JS modules import each other

// ---------- who imports whom (to tell entries from modules) ----------

const JS_SPEC = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]*\s*from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\1/g;

function jsImports(text) {
  const out = [];
  let m;
  JS_SPEC.lastIndex = 0;
  while ((m = JS_SPEC.exec(String(text || '')))) out.push(m[2]);
  return out;
}

function resolveJs(from, spec, have) {
  if (!/^\.{1,2}\/|^\//.test(spec)) return null;
  const p = resolveRef(from, spec);
  if (!p) return null;
  const exts = ['js', 'mjs', 'jsx', 'ts', 'mts', 'tsx'];
  const cands = [p, ...exts.map((e) => `${p}.${e}`), ...exts.map((e) => `${p}/index.${e}`)];
  const m = /^(.*)\.(m?)js(x?)$/.exec(p);
  if (m) cands.push(`${m[1]}.${m[2]}ts${m[3]}`, `${m[1]}.${m[2]}tsx`);
  return cands.find((c) => have.has(c)) || null;
}

/** Python module names a file imports (absolute imports only; "a.b" also adds "a"). */
function pyImports(text) {
  const names = new Set();
  for (const line of String(text || '').split('\n')) {
    let m = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/.exec(line);
    if (m) {
      names.add(m[1]);
      for (const part of m[2].replace(/[()\\]/g, ' ').split(',')) {
        const id = part.trim().split(/\s+/)[0];
        if (/^[A-Za-z_]\w*$/.test(id)) names.add(`${m[1]}.${id}`);
      }
      continue;
    }
    m = /^\s*import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+/)[0];
        if (/^[A-Za-z_][\w.]*$/.test(mod)) {
          const segs = mod.split('.');
          for (let i = 1; i <= segs.length; i++) names.add(segs.slice(0, i).join('.'));
        }
      }
    }
  }
  return names;
}

const pyModuleName = (p) => p.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');

function luaImports(text) {
  const out = new Set();
  const re = /\brequire\s*\(?\s*(["'])([\w./-]+)\1/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(m[2].replace(/\.lua$/, '').replace(/\./g, '/'));
  return out;
}

const PREFERRED = /^(?:main|index|game|app|play|start)$/i;
const baseName = (p) => p.split('/').pop().replace(/\.[^.]+$/, '');

function rank(e) {
  const order = { html: 0, ts: 1, js: 2, py: 3, lua: 4 };
  return [order[e.lang] ?? 9, PREFERRED.test(baseName(e.path)) ? 0 : 1, e.path.split('/').length, e.path];
}
function compare(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return 0;
}

/**
 * Files that can run as a game: every HTML page, and every JavaScript/TypeScript/Python/Lua file that
 * no other workspace file loads (a page's <script src>, an import, a require). When every file of a
 * language is imported by another (a cycle), its main/game/index file still counts.
 * -> [{ path, ext, lang, label, transpile }], HTML pages first, then main/index/game files.
 */
export function findEntries(files) {
  const list = (files || []).filter((f) => f && typeof f.text === 'string' && f.path).map((f) => ({ path: cleanPath(f.path), text: f.text }));
  const have = new Set(list.map((f) => f.path));
  const imported = new Set();
  const pyNames = new Set();
  const luaNames = new Set();
  for (const f of list) {
    if (ignored(f.path)) continue;
    const k = entryKind(f.path);
    if (!k) continue;
    if (k.lang === 'js' || k.lang === 'ts') {
      for (const spec of jsImports(f.text)) {
        const t = resolveJs(f.path, spec, have);
        if (t && t !== f.path) imported.add(t);
      }
    } else if (k.lang === 'py') {
      for (const n of pyImports(f.text)) pyNames.add(n);
    } else if (k.lang === 'lua') {
      for (const n of luaImports(f.text)) luaNames.add(n);
    }
  }
  const all = [];
  for (const f of list) {
    if (ignored(f.path)) continue;
    const k = entryKind(f.path);
    if (!k) continue;
    let isModule = false;
    let onPage = false; // loaded by an HTML page (directly or through imports): never its own entry
    if (k.lang === 'js' || k.lang === 'ts') {
      onPage = htmlFilesReferencing(f.path, list).length > 0;
      isModule = onPage || imported.has(f.path);
    } else if (k.lang === 'py') isModule = pyNames.has(pyModuleName(f.path)) || /(^|\/)__init__\.py$/.test(f.path);
    else if (k.lang === 'lua') isModule = luaNames.has(f.path.replace(/\.lua$/, ''));
    all.push({ path: f.path, ...k, isModule, onPage });
  }
  const out = all.filter((e) => !e.isModule);
  // An import cycle (every file of a language imported by another one): its main file still runs.
  // Not when an HTML page loads any of them: then the page is the game and they are its modules.
  for (const fam of ['js', 'py', 'lua']) {
    const members = all.filter((e) => family(e.lang) === fam);
    if (!members.length || out.some((e) => family(e.lang) === fam) || members.some((e) => e.onPage)) continue;
    const main = members.find((e) => PREFERRED.test(baseName(e.path)));
    if (main) out.push(main);
  }
  return out.map(({ isModule, onPage, ...e }) => e).sort(compare); // eslint-disable-line no-unused-vars
}

/**
 * The entry to run when the user hasn't picked one, for the active file: itself when it is an entry;
 * for a module, the page that loads it or the main entry of its language. null when the active file
 * isn't game code (the caller then uses autoEntry for Markdown, SVG, CSS …).
 */
export function autoGameEntry(activePath, files) {
  const active = cleanPath(activePath);
  const k = entryKind(active);
  if (!k) return null;
  if (k.lang === 'html') return active;
  // A module an HTML page loads runs through that page (its canvas, styles, other modules).
  if (k.lang === 'js' || k.lang === 'ts') {
    const pages = htmlFilesReferencing(active, files);
    if (pages.length) return pages[0];
  }
  const entries = findEntries(files);
  if (entries.some((e) => e.path === active)) return active;
  const same = entries.find((e) => family(e.lang) === family(k.lang));
  return same ? same.path : active;
}

/** Does building `entry` need the TypeScript compiler (a lazy chunk)? */
export function needsTranspiler(entry, files) {
  const k = entryKind(entry);
  if (!k) return false;
  if (k.transpile) return true;
  if (k.lang !== 'html') return false;
  const page = (files || []).find((f) => cleanPath(f.path) === cleanPath(entry));
  return !!page && /<script\b[^>]*\bsrc\s*=\s*["']?[^"'\s>]+\.(?:m?ts|tsx|jsx)(?:[?#][^"'\s>]*)?["']?/i.test(page.text || '');
}

/** Language id of an entry path ('html' | 'js' | 'ts' | 'py' | 'lua'), or null. */
export const langOfEntry = (path) => entryKind(path)?.lang || null;

export { isHtmlPath };

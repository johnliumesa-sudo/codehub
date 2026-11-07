// TypeScript / TSX / JSX -> JavaScript for games, with the TypeScript 6 compiler API
// (`transpileModule`: one file at a time, no type checking). TypeScript 7 is the Go-native compiler
// and has no JavaScript API, so 6.0.x is the last version that can run in the browser.
//
// The compiler is about 1 MB gzipped: it's never in the start-up bundle. loadTypeScript() imports
// it on demand (a separate chunk); everything else here takes the loaded module as an argument so
// the unit tests can pass Node's copy.
import { cleanPath } from '../sandbox.js';

let tsPromise = null;

/** The TypeScript module, loaded once on first use (a lazy chunk). */
export function loadTypeScript() {
  if (!tsPromise) {
    tsPromise = import('typescript')
      .then((m) => m.default || m)
      .catch((err) => {
        tsPromise = null;
        throw new Error(`Couldn’t load the TypeScript compiler: ${err?.message || err}`);
      });
  }
  return tsPromise;
}

/** The workspace tsconfig.json compilerOptions that matter for emitting JavaScript. */
export function readTsConfig(ts, files) {
  const f = (files || []).find((x) => cleanPath(x.path) === 'tsconfig.json' || cleanPath(x.path) === 'jsconfig.json');
  if (!f || typeof f.text !== 'string') return {};
  let raw;
  try {
    raw = ts.parseConfigFileTextToJson(cleanPath(f.path), f.text).config;
  } catch {
    return {};
  }
  const o = raw?.compilerOptions;
  if (!o || typeof o !== 'object') return {};
  const out = {};
  const jsx = { react: ts.JsxEmit.React, 'react-jsx': ts.JsxEmit.ReactJSX, 'react-jsxdev': ts.JsxEmit.ReactJSX, preserve: ts.JsxEmit.ReactJSX, 'react-native': ts.JsxEmit.ReactJSX };
  if (typeof o.jsx === 'string' && jsx[o.jsx.toLowerCase()] !== undefined) out.jsx = jsx[o.jsx.toLowerCase()];
  for (const k of ['jsxImportSource', 'jsxFactory', 'jsxFragmentFactory']) {
    if (typeof o[k] === 'string' && /^[\w@./-]{1,80}$/.test(o[k])) out[k] = o[k];
  }
  for (const k of ['experimentalDecorators', 'useDefineForClassFields']) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

/** "main.ts:3:7 ';' expected." for a diagnostic. */
function describe(ts, d, path) {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (d.file && typeof d.start === 'number') {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${path}:${line + 1}:${character + 1} ${msg}`;
  }
  return `${path}: ${msg}`;
}

/**
 * A bundle() transform for TypeScript/TSX/JSX modules: (path, text) -> JavaScript (ES2022 module).
 * JSX uses the automatic React runtime (`react/jsx-runtime`) unless tsconfig.json says otherwise.
 * Syntax errors throw "file:line:col message" (the bundler turns that into a module that throws it).
 */
export function makeTransform(ts, files) {
  const base = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
    isolatedModules: true,
    sourceMap: false,
    inlineSourceMap: false,
    removeComments: false,
    ...readTsConfig(ts, files),
  };
  return (path, text) => {
    const r = ts.transpileModule(String(text ?? ''), { fileName: path, reportDiagnostics: true, compilerOptions: base });
    const errors = (r.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.slice(0, 3).map((d) => describe(ts, d, path)).join('\n'));
    return r.outputText;
  };
}

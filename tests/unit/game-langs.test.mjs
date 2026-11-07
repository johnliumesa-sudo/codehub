// Games in other languages (src/lib/gameLangs): entry detection, TypeScript transpiling, the JS/TS game
// page, Python and Lua documents, the language marker, templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LANG_IDS, PYODIDE_URL, UNSUPPORTED_MESSAGE, WASMOON_URL, autoGameEntry, buildGameDoc, buildGamePreview, entryKind, findEntries,
  gameTitle, isLangId, langLabel, langOfDoc, makeTransform, needsTranspiler, pythonDoc, pythonFeatures, unsupportedIn,
} from '../../src/lib/gameLangs/index.js';
import { luaDoc } from '../../src/lib/gameLangs/lua.js';
import { jsShellHtml } from '../../src/lib/gameLangs/jsShell.js';
import { readTsConfig } from '../../src/lib/gameLangs/transpile.js';
import { MAX_GAME_CHARS, WS_PREFIX } from '../../src/lib/sandbox.js';
import { getTemplate, templateFiles } from '../../src/lib/codespaceTemplates.js';

const F = (obj) => Object.entries(obj).map(([path, text]) => ({ path, text }));
const paths = (list) => list.map((e) => e.path);
/** The module sources the bundle boot script embeds ({ path: code }). */
function modulesOf(html) {
  const m = /\}\)\((\{"k":"@codehub-ws\/".*?)\);<\/script>/s.exec(html);
  assert.ok(m, 'bundle boot data');
  return JSON.parse(m[1]).m;
}

// ---------- detection ----------

test('entryKind: languages by extension; declarations and unknown files are not entries', () => {
  assert.deepEqual(entryKind('src/main.ts'), { ext: 'ts', lang: 'ts', label: 'TypeScript', transpile: true });
  assert.equal(entryKind('App.tsx').label, 'TSX');
  assert.deepEqual([entryKind('a.jsx').lang, entryKind('a.jsx').transpile], ['js', true]);
  assert.equal(entryKind('game.js').transpile, false);
  assert.equal(entryKind('main.py').lang, 'py');
  assert.equal(entryKind('main.lua').lang, 'lua');
  assert.equal(entryKind('index.HTML').lang, 'html');
  for (const p of ['types.d.ts', 'x.d.mts', 'main.cpp', 'Game.java', 'style.css', 'README.md', '']) assert.equal(entryKind(p), null, p);
});

test('findEntries: pages and unimported files; modules, packages and node_modules are left out', () => {
  const files = F({
    'index.html': '<script type="module" src="src/app.js"></script>',
    'src/app.js': "import { b } from './b.js';",
    'src/b.js': 'export const b = 1;',
    'tool.ts': "import type { T } from './types';\nimport {\n  x,\n} from './lib/x';\nconst y = await import('./lazy');",
    'types.ts': 'export interface T {}',
    'lib/x.ts': 'export const x = 1;',
    'lazy.tsx': 'export default 1;',
    'game.py': 'from engine.core import run\nimport util, sprites as sp\nrun()',
    'engine/__init__.py': '',
    'engine/core.py': 'def run(): pass',
    'util.py': '',
    'sprites.py': '',
    'main.lua': 'local e = require("enemy")\nlocal m = require "lib.map"',
    'enemy.lua': 'return {}',
    'lib/map.lua': 'return {}',
    'node_modules/pkg/index.js': '',
    '.hidden/x.py': '',
  });
  assert.deepEqual(paths(findEntries(files)), ['index.html', 'tool.ts', 'game.py', 'main.lua']);
});

test('findEntries: a cycle still offers its main file; main/index/game sort first', () => {
  const cyc = F({ 'main.py': 'import other', 'other.py': 'import main', 'z.js': '', 'game.js': '' });
  assert.deepEqual(paths(findEntries(cyc)), ['game.js', 'z.js', 'main.py']);
});

test('autoGameEntry: a module previews through its entry or page', () => {
  const files = F({
    'main.ts': "import './player';",
    'player.ts': '',
    'page.html': '<script src="ui.js"></script>',
    'ui.js': '',
    'main.py': 'import helpers',
    'helpers.py': '',
  });
  assert.equal(autoGameEntry('player.ts', files), 'main.ts');
  assert.equal(autoGameEntry('main.ts', files), 'main.ts');
  assert.equal(autoGameEntry('ui.js', files), 'page.html');
  assert.equal(autoGameEntry('helpers.py', files), 'main.py');
  assert.equal(autoGameEntry('README.md', files), null);
});

test('needsTranspiler: TS/TSX/JSX entries and pages that load them', () => {
  const files = F({ 'a.html': '<script type="module" src="./main.tsx"></script>', 'b.html': '<script src="x.js"></script>', 'm.ts': '' });
  assert.equal(needsTranspiler('m.ts', files), true);
  assert.equal(needsTranspiler('x.jsx', files), true);
  assert.equal(needsTranspiler('a.html', files), true);
  assert.equal(needsTranspiler('b.html', files), false);
  assert.equal(needsTranspiler('x.js', files), false);
  assert.equal(needsTranspiler('x.py', files), false);
});

test('unsupported languages are named and explained', () => {
  assert.deepEqual(unsupportedIn(F({ 'a.rs': '', 'b.cpp': '', 'c.h': '', 'D.kt': '', 'node_modules/x.java': '' })), ['C', 'C++', 'Rust', 'Kotlin']);
  assert.deepEqual(unsupportedIn(F({ 'main.py': '' })), []);
  assert.match(UNSUPPORTED_MESSAGE, /C, C\+\+, Rust, Java and Kotlin/);
  assert.match(UNSUPPORTED_MESSAGE, /JavaScript, TypeScript, Python or Lua/);
  const r = buildGameDoc('main.cpp', F({ 'main.cpp': 'int main(){}' }));
  assert.equal(r.html, '');
  assert.equal(r.error, UNSUPPORTED_MESSAGE);
});

test('language ids and labels', () => {
  assert.deepEqual(LANG_IDS, ['html', 'js', 'ts', 'py', 'lua']);
  assert.equal(isLangId('py'), true);
  assert.equal(isLangId('cpp'), false);
  assert.equal(langLabel('ts'), 'TypeScript');
  assert.equal(langLabel('nope'), '');
});

// ---------- TypeScript ----------

test('transpile: enums, namespaces, parameter properties, legacy decorators, JSX runtimes', async () => {
  const run = async (code) => {
    const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    return (await import(url)).out;
  };
  const tr = makeTransform(ts, []);
  const js = tr('a.ts', `enum Dir { Up = 1, Down }
namespace N { export const k = 3; }
class P { constructor(public x: number, private y = 2) {} sum(): number { return this.x + this.y; } }
export const out = [Dir.Down, Dir[1], N.k, new P(5).sum()];`);
  assert.deepEqual(await run(js), [2, 'Up', 3, 7]);

  const dec = makeTransform(ts, F({ 'tsconfig.json': '{ "compilerOptions": { "experimentalDecorators": true } }' }));
  const legacy = dec('d.ts', `const seen: string[] = [];
function log(_t: object, key: string) { seen.push(key); }
class A { @log m() {} }
export const out = seen;`);
  assert.deepEqual(await run(legacy), ['m']);

  assert.match(tr('v.tsx', 'export const v = <b>hi</b>;'), /from "react\/jsx-runtime"/);
  const classic = makeTransform(ts, F({ 'tsconfig.json': '{\n // comment\n "compilerOptions": { "jsx": "react", "jsxFactory": "h" } }' }));
  assert.match(classic('v.tsx', 'export const v = <b>hi</b>;'), /h\("b", null, "hi"\)/);
  assert.deepEqual(readTsConfig(ts, F({ 'tsconfig.json': '{ "compilerOptions": { "jsxImportSource": "preact", "jsx": "react-jsx" } }' })), {
    jsx: ts.JsxEmit.ReactJSX,
    jsxImportSource: 'preact',
  });
  // Unsafe or odd values are ignored.
  assert.deepEqual(readTsConfig(ts, F({ 'tsconfig.json': '{ "compilerOptions": { "jsxFactory": "x</script>" } }' })), {});
});

test('transpile: a syntax error names the file, line and column', () => {
  const tr = makeTransform(ts, []);
  assert.throws(() => tr('src/bad.ts', 'const a = 1;\nlet x: number = ;'), /src\/bad\.ts:2:17 Expression expected/);
});

// ---------- JS / TS game documents ----------

const TS_FILES = F({
  'main.ts': "import { add } from './vec.js';\nimport { nanoid } from 'nanoid';\nimport type { V } from './types';\nconst v: V = add({ x: 1 }, { x: 2 });\nfetch('levels.json');\nconsole.log(v, nanoid());",
  'vec.ts': 'import type { V } from "./types";\nexport const add = (a: V, b: V): V => ({ x: a.x + b.x });',
  'types.ts': 'export interface V { x: number }',
  'levels.json': '[1]',
  'package.json': '{ "dependencies": { "nanoid": "5.0.7" } }',
});

test('TypeScript entry: marker first, shell page, transpiled modules, pinned npm import, data files', () => {
  const r = buildGameDoc('main.ts', TS_FILES, { ts });
  assert.equal(r.error, null);
  assert.equal(r.lang, 'ts');
  assert.ok(r.html.startsWith('<meta name="codehub-lang" content="ts">'));
  assert.equal(langOfDoc(r.html), 'ts');
  assert.match(r.html, /<canvas id="game" tabindex="0" aria-label="Game"><\/canvas>/);
  assert.match(r.html, /id="cx-console"/);
  assert.match(r.html, new RegExp(`<script type="module">import "${WS_PREFIX}main.ts";</script>`));
  assert.deepEqual(r.modules.sort(), ['main.ts', 'vec.ts']); // types.ts only holds types
  assert.deepEqual(r.assets, ['levels.json']);
  assert.deepEqual(r.unpinned, []);
  assert.deepEqual(r.errors, []);
  const mods = modulesOf(r.html);
  assert.doesNotMatch(mods['main.ts'], /: V\b/);
  assert.match(mods['main.ts'], /"@codehub-ws\/vec\.ts"/);
  assert.match(r.html, /https:\/\/cdn\.jsdelivr\.net\/npm\/nanoid@5\.0\.7\/\+esm/);
});

test('TypeScript entry without the compiler loaded: a clear error, no document', () => {
  const r = buildGameDoc('main.ts', TS_FILES);
  assert.equal(r.html, '');
  assert.match(r.error, /TypeScript compiler/);
});

test('TypeScript syntax error: the document still builds and the module throws the message', () => {
  const r = buildGameDoc('main.ts', F({ 'main.ts': 'let = ;' }), { ts });
  assert.equal(r.error, null);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^main\.ts: main\.ts:1:\d+ /);
  assert.match(modulesOf(r.html)['main.ts'], /^throw new SyntaxError/);
});

test('JavaScript entry: plain scripts stay classic (globals), modules are bundled', () => {
  const classic = buildGameDoc('game.js', F({ 'game.js': 'function tick() {}\nvar score = 0;' }));
  assert.equal(classic.lang, 'js');
  assert.match(classic.html, /<script>\nfunction tick\(\) \{\}\nvar score = 0;\n<\/script>/);
  assert.doesNotMatch(classic.html, /type="module"/);
  const mod = buildGameDoc('main.js', F({ 'main.js': "import { a } from './a.js';\nconsole.log(a);", 'a.js': 'export const a = 1;' }));
  assert.deepEqual(mod.modules.sort(), ['a.js', 'main.js']);
  assert.match(mod.html, /<script type="module">import "@codehub-ws\/main\.js";<\/script>/);
});

test('jsShellHtml escapes the title and entry path', () => {
  const h = jsShellHtml({ entry: 'my game/x".js', title: '<b>Hi</b>', module: false });
  assert.match(h, /<title>&lt;b&gt;Hi&lt;\/b&gt;<\/title>/);
  assert.match(h, /<script src="\/my%20game\/x%22\.js"><\/script>/);
});

test('HTML entries are bundled as before, with no marker; TypeScript pages compile', () => {
  const r = buildGameDoc('index.html', F({ 'index.html': '<title>Hi</title><script type="module" src="main.ts"></script>', 'main.ts': 'const n: number = 1;' }), { ts });
  assert.equal(r.lang, 'html');
  assert.equal(langOfDoc(r.html), 'html');
  assert.deepEqual(r.modules, ['main.ts']);
  assert.match(modulesOf(r.html)['main.ts'], /const n = 1;/);
});

test('langOfDoc only trusts a marker at the very start', () => {
  assert.equal(langOfDoc('<meta name="codehub-lang" content="py"><p>'), 'py');
  assert.equal(langOfDoc('<p><meta name="codehub-lang" content="py">'), 'html');
  assert.equal(langOfDoc('<meta name="codehub-lang" content="cobol">'), 'html');
  assert.equal(langOfDoc(null), 'html');
});

// ---------- Python ----------

test('Python document: pinned Pyodide, workspace files, console/input UI, prelude', () => {
  const files = F({ 'main.py': 'import helpers\nprint(helpers.X)\nname = input()', 'helpers.py': 'X = "</script><script>alert(1)</script>"', 'data/level.json': '[1]', 'app.js': 'x', 'README.md': '# hi' });
  const r = buildGameDoc('main.py', files);
  assert.equal(r.error, null);
  assert.equal(r.lang, 'py');
  assert.ok(r.html.startsWith('<meta name="codehub-lang" content="py">'));
  assert.equal(PYODIDE_URL, 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/');
  assert.ok(r.html.includes(JSON.stringify(PYODIDE_URL)));
  assert.deepEqual(r.inlined.sort(), ['README.md', 'data/level.json', 'helpers.py', 'main.py']);
  // File contents can't break out of the script element.
  assert.equal((r.html.match(/<\/script>/g) || []).length, 2);
  for (const id of ['cx-con', 'cx-field', 'cx-status', 'canvas']) assert.match(r.html, new RegExp(`id="${id}"`));
  for (const s of ['run_sync', 'sys.monitoring', '_cx_patch_pygame', 'runpy.run_path', 'TracebackException']) assert.ok(r.html.includes(s), s);
  assert.equal(r.features.pygame, false);
  assert.ok(r.html.length < 30_000, `small game document (${r.html.length})`);
});

test('Python features: pygame, turtle shim only when needed, canvas stage', () => {
  assert.deepEqual(pythonFeatures({ 'm.py': 'print(1)' }), { pygame: false, turtle: false, canvas: false });
  assert.deepEqual(pythonFeatures({ 'm.py': 'import pygame, sys' }), { pygame: true, turtle: false, canvas: true });
  assert.deepEqual(pythonFeatures({ 'm.py': 'from turtle import *' }), { pygame: false, turtle: true, canvas: true });
  assert.equal(pythonFeatures({ 'm.py': 'import turtle', 'turtle.py': '# mine' }).turtle, false);
  assert.equal(pythonFeatures({ 'm.py': 'from js import document\nc = document.getElementById("canvas")' }).canvas, true);
  const t = pythonDoc('m.py', F({ 'm.py': 'import turtle\nturtle.forward(10)' }));
  assert.ok(t.html.includes('class Turtle'));
  assert.ok(!pythonDoc('m.py', F({ 'm.py': 'print(1)' })).html.includes('class Turtle'));
  assert.throws(() => pythonDoc('nope.py', F({ 'm.py': '' })), /Entry file not found/);
});

// ---------- Lua ----------

test('Lua document: wasmoon from jsDelivr, mounted files, guarded runner', () => {
  const r = buildGameDoc('main.lua', F({ 'main.lua': 'local u = require("util")\nctx:fillRect(0,0,1,1)', 'util.lua': 'return {}', 'x.py': '' }));
  assert.equal(r.error, null);
  assert.equal(r.lang, 'lua');
  assert.equal(WASMOON_URL, 'https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm');
  assert.ok(r.html.includes(JSON.stringify(WASMOON_URL)));
  assert.deepEqual(r.inlined.sort(), ['main.lua', 'util.lua']);
  assert.equal(r.features.canvas, true);
  assert.ok(r.html.includes('loadfile(\\"main.lua\\")'));
  assert.ok(r.html.includes('__cx_guard()'));
  assert.equal(luaDoc('a.lua', F({ 'a.lua': 'print(1)' })).features.canvas, false);
});

// ---------- titles, preview limit, templates ----------

test('gameTitle: HTML <title>, else folder or file name', () => {
  assert.equal(gameTitle('index.html', F({ 'index.html': '<title>Space &amp; Time</title>' })), 'Space & Time');
  assert.equal(gameTitle('pong/main.py', []), 'pong');
  assert.equal(gameTitle('src/main.ts', [], 'My Space'), 'My Space');
  assert.equal(gameTitle('main.lua', [], 'Codespace X'), 'Codespace X');
  assert.equal(gameTitle('flappy_bird.py', []), 'Flappy bird');
});

test('buildGamePreview applies the 2 MB preview limit', () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 10);
  const r = buildGamePreview('main.py', F({ 'main.py': `s = "${big}"` }));
  assert.equal(r.html, '');
  assert.match(r.error, /over the 2 MB preview limit/);
});

test('templates: the Python and TypeScript games build into publishable documents', () => {
  const py = getTemplate('python-game');
  const pyFiles = templateFiles('python-game').map((f) => ({ path: f.path, text: f.content }));
  assert.equal(py.name, 'Python game');
  assert.deepEqual(paths(findEntries(pyFiles)), ['main.py']);
  const p = buildGameDoc('main.py', pyFiles);
  assert.equal(p.error, null);
  assert.equal(p.features.pygame, true);
  assert.ok(p.html.length < MAX_GAME_CHARS);

  const tsFiles = templateFiles('typescript-game').map((f) => ({ path: f.path, text: f.content }));
  assert.deepEqual(paths(findEntries(tsFiles)), ['main.ts']);
  const t = buildGameDoc('main.ts', tsFiles, { ts });
  assert.equal(t.error, null);
  assert.deepEqual(t.errors, []);
  assert.deepEqual(t.modules.sort(), ['game.ts', 'input.ts', 'main.ts', 'types.ts']);
  assert.ok(t.html.length < MAX_GAME_CHARS);
  // The template type-checks under strict mode (what an editor would report).
  const dir = mkdtempSync(join(tmpdir(), 'codehub-ts-template-'));
  for (const f of tsFiles) writeFileSync(join(dir, f.path), f.text);
  const prog = ts.createProgram([join(dir, 'main.ts')], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [],
  });
  const diags = ts.getPreEmitDiagnostics(prog).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(diags, []);
});

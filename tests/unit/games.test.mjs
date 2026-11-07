// Games, live preview and chat Run: sandbox profiles, the play runtime, the bundler (ES modules,
// import maps, CDN mapping, workspace files) and the small pure helpers around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  GAME_CSP, PLAY_ALLOW, PLAY_CSP, PLAY_SANDBOX, SANDBOX, STRICT_CSP, WS_PREFIX, autoEntry, buildPreviewHtml, buildSrcdoc, bundle,
  exactVersion, frameAttrs, htmlFilesReferencing, isAllowedUrl, newToken, npmModuleUrl, rewriteCdnUrl,
} from '../../src/lib/sandbox.js';
import { TAILWIND_BROWSER_URL, SAVE_MAX_CHARS, cleanStorageSnapshot, jsonForScript, playRuntimeScript, readRuntimeMessage } from '../../src/lib/sandboxPlay.js';
import { applyEdits, looksLikeModule, scanModule } from '../../src/lib/esmScan.js';
import { chooseEvictions } from '../../src/lib/gameSaves.js';
import { clipChars, coverLetter, publishRefusal, titleFromHtml } from '../../src/lib/gameText.js';
import { extractRunnables, snippetFromLongText } from '../../src/features/messaging/lib/runnable.js';

// The policy add-ons have always had. Add-on Workers inherit it (connect-src 'none'); never change it.
const ORIGINAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const ORIGINAL_HEAD =
  '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
  ORIGINAL_CSP.replace(/"/g, '&quot;') +
  '"><meta name="referrer" content="no-referrer">';

const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
const files = (o) => Object.entries(o).map(([path, text]) => ({ path, text }));

// ---------- profiles ----------

test('strict profile (add-ons) is byte-for-byte the original sandbox', () => {
  assert.equal(GAME_CSP, ORIGINAL_CSP);
  assert.equal(STRICT_CSP, ORIGINAL_CSP);
  assert.equal(SANDBOX, 'allow-scripts');
  assert.deepEqual(frameAttrs('strict'), { sandbox: 'allow-scripts', allow: '', csp: ORIGINAL_CSP });
  assert.deepEqual(frameAttrs(), frameAttrs('strict'));
  assert.deepEqual(frameAttrs('anything-else'), frameAttrs('strict'));
  const html = '<p>add-on host</p><script>x()</script>';
  // Default profile, game mode (what AddonFrame renders) and the explicit 'strict' profile.
  assert.equal(buildSrcdoc(html, { mode: 'game' }), ORIGINAL_HEAD + html);
  assert.equal(buildSrcdoc(html, { mode: 'game', profile: 'strict', token: 'abc' }), ORIGINAL_HEAD + html);
  assert.equal(buildSrcdoc(html), ORIGINAL_HEAD + html);
  // Strict preview: original head + console bridge + markup, no play runtime.
  const pv = buildSrcdoc(html, { mode: 'preview', token: 'tok123', profile: 'strict' });
  assert.ok(pv.startsWith(ORIGINAL_HEAD + '<script>'));
  assert.ok(pv.endsWith(html));
  assert.ok(pv.includes('"tok123"'));
  assert.ok(!pv.includes('__codehub'));
  assert.equal(pv, buildSrcdoc(html, { mode: 'preview', token: 'tok123' }));
});

test('play profile: sandbox flags, permissions and CSP', () => {
  const a = frameAttrs('play');
  assert.equal(a.sandbox, PLAY_SANDBOX);
  assert.deepEqual(a.sandbox.split(' ').sort(), ['allow-pointer-lock', 'allow-scripts']);
  for (const bad of ['allow-same-origin', 'allow-popups', 'allow-top-navigation', 'allow-forms', 'allow-modals']) assert.ok(!a.sandbox.includes(bad));
  assert.equal(a.allow, PLAY_ALLOW);
  assert.match(PLAY_ALLOW, /fullscreen \*/);
  const d = directives(PLAY_CSP);
  assert.deepEqual(d['default-src'], ["'none'"]);
  for (const k of ['frame-src', 'object-src', 'form-action', 'base-uri']) assert.deepEqual(d[k], ["'none'"], k);
  assert.ok(d['script-src'].includes("'unsafe-eval'") && d['script-src'].includes("'wasm-unsafe-eval'"));
  assert.deepEqual(d['worker-src'], ['blob:', 'data:']);
  // Only pinned path prefixes on hosts that can't proxy an arbitrary origin; never a bare host or *.
  const hosts = new Set(Object.values(d).flat().filter((v) => v.startsWith('http')));
  assert.deepEqual([...hosts].sort(), [
    'https://cdn.jsdelivr.net/npm/', 'https://cdn.jsdelivr.net/pyodide/', 'https://cdnjs.cloudflare.com/ajax/libs/',
    'https://fonts.googleapis.com/css', 'https://fonts.googleapis.com/css2', 'https://fonts.gstatic.com/s/', 'https://unpkg.com/',
  ]);
  for (const v of Object.values(d).flat()) assert.ok(v !== '*' && v !== 'https:' && v !== 'http:' && !/esm\.sh|\/gh\//.test(v), v);
  assert.ok(!d['connect-src'].includes("'none'") && d['connect-src'].includes('data:') && d['connect-src'].includes('blob:'));

  const doc = buildSrcdoc('<p>game</p>', { profile: 'play', mode: 'game', token: 't1' });
  assert.ok(doc.startsWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + PLAY_CSP.replace(/"/g, '&quot;')));
  // The runtime comes before the user's markup.
  assert.ok(doc.indexOf('__codehub') < doc.indexOf('<p>game</p>'));
  assert.ok(doc.endsWith('<p>game</p>'));
  const preview = buildSrcdoc('<p>x</p>', { profile: 'play', mode: 'preview', token: 't2' });
  assert.ok(preview.indexOf('__sbx:T') < preview.indexOf('__codehub'), 'console bridge first, then the runtime');
});

test('isAllowedUrl mirrors the play CSP', () => {
  for (const u of [
    'https://cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.min.js', 'https://cdn.jsdelivr.net/npm/canvas-confetti@1/+esm',
    'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js', 'https://unpkg.com/three@0.160.0/build/three.module.js',
    'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js', 'data:text/javascript,1',
  ]) assert.ok(isAllowedUrl(u, 'script'), u);
  for (const u of [
    'https://cdn.jsdelivr.net/gh/user/repo/x.js', 'https://cdn.jsdelivr.net/combine/npm/a', 'https://esm.sh/react', 'https://example.com/x.js',
    'http://unpkg.com/x', 'https://cdnjs.cloudflare.com/other/x.js', 'https://code.jquery.com/jquery-3.7.1.min.js', 'not a url',
  ]) assert.ok(!isAllowedUrl(u, 'script'), u);
  assert.ok(isAllowedUrl('https://fonts.googleapis.com/css2?family=Press+Start+2P', 'style'));
  assert.ok(isAllowedUrl('https://fonts.googleapis.com/css?family=Roboto', 'style'));
  assert.ok(!isAllowedUrl('https://fonts.googleapis.com/icon?family=Material+Icons', 'style'));
  assert.ok(!isAllowedUrl('https://fonts.googleapis.com/css2', 'script'));
  assert.ok(!isAllowedUrl('https://cdn.jsdelivr.net/pyodide/x.css', 'style'));
});

test('rewriteCdnUrl maps esm.sh / Skypack / jQuery to their jsDelivr twins', () => {
  assert.equal(rewriteCdnUrl('https://esm.sh/nanoid@5.0.7'), 'https://cdn.jsdelivr.net/npm/nanoid@5.0.7/+esm');
  assert.equal(rewriteCdnUrl('https://esm.sh/canvas-confetti@1.9.2?bundle'), 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.2/+esm');
  assert.equal(rewriteCdnUrl('https://esm.sh/@tweenjs/tween.js@23.1.1'), 'https://cdn.jsdelivr.net/npm/@tweenjs/tween.js@23.1.1/+esm');
  assert.equal(rewriteCdnUrl('https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js'), 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm');
  assert.equal(rewriteCdnUrl('https://cdn.skypack.dev/canvas-confetti'), 'https://cdn.jsdelivr.net/npm/canvas-confetti/+esm');
  assert.equal(rewriteCdnUrl('https://code.jquery.com/jquery-3.7.1.min.js'), 'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js');
  assert.equal(rewriteCdnUrl('http://unpkg.com/three@0.160.0/build/three.module.js'), 'https://unpkg.com/three@0.160.0/build/three.module.js');
  // esm.sh build paths and other hosts stay as written.
  assert.equal(rewriteCdnUrl('https://esm.sh/v135/react@18.2.0/es2022/react.mjs'), 'https://esm.sh/v135/react@18.2.0/es2022/react.mjs');
  assert.equal(rewriteCdnUrl('https://example.com/a.js'), 'https://example.com/a.js');
  assert.equal(npmModuleUrl('three/addons/controls/OrbitControls.js', '0.170.0'), 'https://cdn.jsdelivr.net/npm/three@0.170.0/addons/controls/OrbitControls.js/+esm');
  assert.equal(npmModuleUrl('@scope/pkg', '^1.2.0'), 'https://cdn.jsdelivr.net/npm/@scope/pkg@%5E1.2.0/+esm');
  assert.equal(npmModuleUrl('confetti', null), 'https://cdn.jsdelivr.net/npm/confetti/+esm');
  assert.equal(npmModuleUrl('x', 'git+https://evil/x'), 'https://cdn.jsdelivr.net/npm/x/+esm');
});

// ---------- lexer ----------

test('scanModule finds real import specifiers only', () => {
  const src = [
    "// import nope from './comment.js'",
    "/* export * from './block.js' */",
    "import a from './a.js';",
    'import {b as c, "d-e" as de} from "../b.js"',
    "import * as ns from 'three'",
    "import './side.js';",
    "export * from './re.js'",
    "export { q } from './q.js';",
    'export {a}',
    "const s = \"import x from './fake.js'\";",
    "const t = `levels/${n}.json ${ `inner${1}` }`;",
    "const r = /import\\('x'\\)/g, d = 4 / 2 / 1;",
    "const lazy = await import('./lazy.js');",
    "x.import('./not.js'); import.meta.url;",
    "fetch('levels.json');",
  ].join('\n');
  const { specifiers, strings } = scanModule(src);
  assert.deepEqual(specifiers.map((x) => [x.spec, x.dynamic]), [
    ['./a.js', false], ['../b.js', false], ['three', false], ['./side.js', false], ['./re.js', false], ['./q.js', false], ['./lazy.js', true],
  ]);
  for (const x of specifiers) assert.match(src.slice(x.start, x.end), /^(['"]).*\1$/);
  const values = strings.map((x) => x.value);
  assert.ok(values.includes('levels.json') && values.includes('levels/') && values.includes("import x from './fake.js'"));
  assert.ok(strings.find((x) => x.value === 'levels/').template);
  assert.equal(applyEdits('abcdef', [{ start: 1, end: 3, text: 'X' }, { start: 4, end: 5, text: 'YY' }]), 'aXdYYf');
  assert.equal(looksLikeModule("import x from 'y'"), true);
  assert.equal(looksLikeModule('export default 1'), true);
  assert.equal(looksLikeModule('const s = "import a from \'b\'"; // export default'), false);
  assert.equal(looksLikeModule('console.log(1)'), false);
});

// ---------- bundler ----------

test('bundle: classic games are unchanged apart from inlining', () => {
  const b = bundle('index.html', files({
    'index.html': '<link rel="stylesheet" href="style.css"><script src="game.js"></script><img src="ship.svg">',
    'style.css': 'body{background:url(bg.svg)} </style>',
    'game.js': 'let best = localStorage.getItem("best"); </script>',
    'ship.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'bg.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  }));
  assert.ok(!b.html.includes(WS_PREFIX), 'no module boot for a classic game');
  assert.match(b.html, /<style>\nbody\{background:url\("data:image\/svg\+xml;base64,/);
  assert.ok(b.html.includes('<\\/style>') && b.html.includes('<\\/script>'));
  assert.match(b.html, /<img src="data:image\/svg\+xml;base64,/);
  assert.deepEqual(b.modules, []);
  assert.deepEqual(b.missing, []);
  assert.deepEqual(new Set(b.inlined), new Set(['style.css', 'game.js', 'ship.svg', 'bg.svg']));
});

test('bundle: ES modules, npm imports pinned by package.json, workspace data files', () => {
  const b = bundle('game/index.html', files({
    'game/index.html': '<link rel="modulepreload" href="src/main.js"><script type="module" src="src/main.js"></script>',
    'game/src/main.js': "import { Player } from './player.js';\nimport confetti from 'canvas-confetti';\nimport { tween } from '@tweenjs/tween.js';\nconst lv = await (await fetch('levels.json')).json();\nconst more = import('./lazy');\nfetch(`maps/${n}.txt`);",
    'game/src/player.js': "export class Player {}\nimport '../shared/util.mjs';",
    'game/src/lazy.js': 'export default 1;',
    'game/shared/util.mjs': "import data from './data.json' with { type: 'json' };",
    'game/shared/data.json': '{"a":1}',
    'game/levels.json': '[1,2]',
    'game/maps/1.txt': 'ab',
    'game/maps/2.txt': 'cd',
    'package.json': JSON.stringify({ dependencies: { 'canvas-confetti': '1.9.3' } }),
    'README.md': 'not used',
  }));
  assert.deepEqual(b.modules.sort(), ['game/shared/data.json', 'game/shared/util.mjs', 'game/src/lazy.js', 'game/src/main.js', 'game/src/player.js']);
  assert.deepEqual(b.assets.sort(), ['game/levels.json', 'game/maps/1.txt', 'game/maps/2.txt']);
  assert.deepEqual(b.unpinned, ['@tweenjs/tween.js']);
  assert.deepEqual(b.missing, []);
  assert.ok(!/modulepreload/.test(b.html));
  assert.match(b.html, /<script type="module">import "@codehub-ws\/game\/src\/main\.js";<\/script>/);
  const boot = /<script>\((function bundleBoot[\s\S]*?)\)\((\{[\s\S]*?\})\);<\/script>/.exec(b.html);
  assert.ok(boot, 'boot script first');
  assert.ok(b.html.startsWith('<script>(function bundleBoot'));
  const data = JSON.parse(boot[2]);
  assert.equal(data.base, 'game/');
  assert.equal(data.map.imports['canvas-confetti'], 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/+esm');
  assert.equal(data.map.imports['@tweenjs/tween.js'], 'https://cdn.jsdelivr.net/npm/@tweenjs/tween.js/+esm');
  assert.match(data.m['game/src/main.js'], /from "@codehub-ws\/game\/src\/player\.js"/);
  assert.match(data.m['game/src/main.js'], /import\("@codehub-ws\/game\/src\/lazy\.js"\)/);
  assert.match(data.m['game/src/main.js'], /from 'canvas-confetti'/, 'bare imports stay bare (import map)');
  assert.match(data.m['game/src/player.js'], /import "@codehub-ws\/game\/shared\/util\.mjs"/);
  assert.deepEqual(data.a['game/levels.json'], ['application/json', '[1,2]']);
  assert.ok(!('README.md' in data.a) && !('package.json' in data.a));
  // Data embedded in the boot can't end the script element.
  const evil = bundle('index.html', files({ 'index.html': '<script type="module" src="m.js"></script>', 'm.js': "const s = '</script><img src=x onerror=alert(1)>';" }));
  assert.equal(evil.html.split('</script>').length - 1, 2, 'only the boot and the entry script close');
});

test('bundle: import maps, external URLs, missing files, classic scripts that are modules', () => {
  const page = `<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/","utils":"./js/utils.js"}}</script>
<script type="module">import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nimport { u } from 'utils';\nimport { nanoid } from 'https://esm.sh/nanoid@5.0.7';\nimport './nope.js';</script>
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script src="https://example.com/tracker.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Press+Start+2P">
<script src="legacy.js"></script>`;
  const b = bundle('index.html', files({ 'index.html': page, 'js/utils.js': 'export const u = 1;', 'legacy.js': "import { u } from './js/utils.js';\nconsole.log(u);" }));
  assert.ok(!/type="importmap"/.test(b.html), 'the page map is merged into the boot map');
  const data = JSON.parse(/\)\((\{[\s\S]*?\})\);<\/script>/.exec(b.html)[1]);
  assert.equal(data.map.imports.three, 'https://unpkg.com/three@0.160.0/build/three.module.js');
  assert.equal(data.map.imports.utils, '@codehub-ws/js/utils.js');
  assert.ok(!('three/addons/controls/OrbitControls.js' in data.map.imports), 'covered by the page map prefix');
  assert.match(b.html, /from "https:\/\/cdn\.jsdelivr\.net\/npm\/nanoid@5\.0\.7\/\+esm"/);
  assert.match(b.html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/jquery@3\.7\.1\/dist\/jquery\.min\.js"><\/script>/);
  assert.match(b.html, /<script type="module">import "@codehub-ws\/legacy\.js";<\/script>/, 'a <script src> with import syntax runs as a module');
  assert.deepEqual(b.missing, ['./nope.js']);
  const ext = Object.fromEntries(b.external.map((x) => [x.url, x.allowed]));
  assert.equal(ext['https://example.com/tracker.js'], false);
  assert.equal(ext['https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js'], true);
  assert.equal(ext['https://fonts.googleapis.com/css2?family=Press+Start+2P'], true);
  assert.equal(b.external.find((x) => x.url.includes('nanoid')).from, 'https://esm.sh/nanoid@5.0.7');

  // Only a page map (no workspace modules, no npm imports): it stays a static element.
  const s = bundle('index.html', files({ 'index.html': '<script type="importmap">{"imports":{"three":"https://esm.sh/three@0.160.0"}}</script><script type="module">import "three";</script>' }));
  assert.match(s.html, /^<script type="importmap">\{"imports":\{"three":"https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/\+esm"\}\}<\/script>/);
  assert.ok(!s.html.includes('bundleBoot'));
  assert.throws(() => bundle('missing.html', []), /Entry file not found/);
});

test('bundle: transform hook for other module languages', () => {
  const b = bundle('index.html', files({ 'index.html': '<script type="module" src="main.ts"></script>', 'main.ts': "import { x } from './x.js';\nconst n: number = x;", 'x.ts': 'export const x: number = 1;' }), {
    moduleExts: ['ts'],
    transform: (path, text) => text.replace(/: number/g, ''),
  });
  assert.deepEqual(b.modules.sort(), ['main.ts', 'x.ts']);
  assert.match(b.html, /@codehub-ws\/x\.ts/);
  assert.ok(!b.html.includes(': number'));
});

test('preview: module JS files run through the bundler; importers find their page', () => {
  const ws = files({ 'index.html': '<script type="module" src="main.js"></script>', 'main.js': "import './lib/a.js';", 'lib/a.js': "import { b } from './b.js';", 'lib/b.js': 'export const b = 1;', 'solo.js': "import { b } from './lib/b.js'; console.log(b);", 'plain.js': 'console.log(1)' });
  assert.deepEqual(htmlFilesReferencing('lib/b.js', ws), ['index.html']);
  assert.equal(autoEntry('lib/b.js', ws), 'index.html');
  const solo = buildPreviewHtml('solo.js', ws);
  assert.equal(solo.error, null);
  assert.match(solo.html, /import "@codehub-ws\/solo\.js"/);
  const plain = buildPreviewHtml('plain.js', ws);
  assert.ok(!plain.html.includes('bundleBoot') && plain.html.includes('console.log(1)'));
});

// ---------- runtime (run in a VM with a minimal window) ----------

function runRuntime({ persist = true, local = {}, mode = 'game' } = {}) {
  const posted = [];
  const timers = [];
  const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, attachShadow() { return { appendChild() {}, querySelectorAll: () => [] }; }, remove() {}, isConnected: true });
  const document = {
    createElement: el,
    createTextNode: () => ({}),
    addEventListener() {},
    body: el(),
    documentElement: el(),
  };
  Object.defineProperty(document, 'cookie', { configurable: true, get() { throw new Error('SecurityError'); }, set() { throw new Error('SecurityError'); } });
  const g = {
    console: { info() {}, error() {}, log() {} },
    document,
    addEventListener() {},
    setTimeout: (fn) => timers.push(fn),
    DOMException,
  };
  for (const n of ['localStorage', 'sessionStorage']) Object.defineProperty(g, n, { configurable: true, get() { throw new Error('SecurityError: sandboxed'); } });
  g.window = g;
  g.parent = { postMessage: (m) => posted.push(m) };
  const ctx = vm.createContext(g);
  const script = playRuntimeScript({ token: 'tok', mode, storage: { persist, local, session: {} } });
  vm.runInContext(script.replace(/^<script>/, '').replace(/<\/script>$/, ''), ctx);
  return { ctx, posted, flush: () => { while (timers.length) timers.shift()(); }, run: (code) => vm.runInContext(code, ctx) };
}

test('runtime: localStorage works in the opaque origin, is Storage-like and persists through the parent', () => {
  const r = runRuntime({ local: { best: '7', bad: 5 } });
  assert.equal(r.posted[0].kind, 'hello');
  assert.equal(r.posted[0].__sbx, 'tok');
  assert.equal(r.run("localStorage.getItem('best')"), '7');
  assert.equal(r.run("localStorage.getItem('bad')"), null, 'non-string initial values are dropped');
  r.run("localStorage.setItem('score', 12); localStorage.level = 3; localStorage['name'] = 'Ann';");
  assert.equal(r.run("localStorage.score + '|' + localStorage.level + '|' + localStorage.getItem('name')"), '12|3|Ann');
  assert.equal(r.run('localStorage.length'), 4);
  assert.equal(r.run("'level' in localStorage && !('nope' in localStorage)"), true);
  assert.equal(r.run('JSON.stringify(localStorage)'), '{"best":"7","score":"12","level":"3","name":"Ann"}');
  assert.equal(r.run('Object.keys(localStorage).join()'), 'best,score,level,name');
  assert.equal(r.run('localStorage.key(1)'), 'score');
  r.run('delete localStorage.level; localStorage.removeItem("name");');
  assert.equal(r.run('localStorage.length'), 2);
  r.flush();
  const saves = r.posted.filter((m) => m.kind === 'storage');
  assert.equal(saves.length, 1, 'changes in one task are coalesced');
  assert.deepEqual(JSON.parse(JSON.stringify(saves[0])), { kind: 'storage', area: 'local', data: { best: '7', score: '12' }, __sbx: 'tok' });
  assert.equal(r.run("sessionStorage.setItem('s', 1); sessionStorage.getItem('s')"), '1');
  // Over the budget: QuotaExceededError, nothing stored.
  assert.throws(() => r.run(`localStorage.setItem('big', 'x'.repeat(${SAVE_MAX_CHARS}))`), (e) => e.name === 'QuotaExceededError');
  assert.equal(r.run("localStorage.getItem('big')"), null);
  // document.cookie no longer throws.
  r.run("document.cookie = 'a=1; path=/'; document.cookie = 'b=2'; document.cookie = 'a=; max-age=0'");
  assert.equal(r.run('document.cookie'), 'b=2');
});

test('runtime: dialogs never block or break a game; preview runs do not persist', () => {
  const r = runRuntime({ persist: false });
  assert.equal(r.run("confirm('Play again?')"), true);
  assert.equal(r.run("prompt('Name?')"), '');
  assert.equal(r.run("prompt('Name?', 'Player 1')"), 'Player 1');
  assert.equal(r.run("alert('Game over')"), undefined);
  assert.equal(r.run('typeof __codehub.notice'), 'function');
  r.run("localStorage.setItem('x', '1')");
  r.flush();
  assert.equal(r.posted.filter((m) => m.kind === 'storage').length, 0);
});

test('runtime messages and storage snapshots are validated', () => {
  assert.deepEqual(cleanStorageSnapshot({ a: '1', b: 'two' }), { a: '1', b: 'two' });
  assert.equal(cleanStorageSnapshot({ a: 1 }), null);
  assert.equal(cleanStorageSnapshot(['a']), null);
  assert.equal(cleanStorageSnapshot({ a: 'x'.repeat(10) }, 5), null);
  assert.equal(readRuntimeMessage({ kind: 'storage', area: 'cookies', data: {} }), null);
  assert.equal(readRuntimeMessage({ kind: 'storage', area: 'local', data: { a: {} } }), null);
  assert.deepEqual(readRuntimeMessage({ kind: 'storage', area: 'local', data: { a: 'b' } }), { kind: 'storage', area: 'local', data: { a: 'b' } });
  assert.equal(readRuntimeMessage({ kind: 'error', message: 'x'.repeat(5000) }).message.length, 1000);
  assert.equal(readRuntimeMessage({ kind: 'eval', code: 'x' }), null);
  assert.equal(readRuntimeMessage('hello'), null);
  assert.equal(jsonForScript({ s: '</script><!--\u2028' }), '{"s":"\\u003c/script>\\u003c!--\\u2028"}');
  assert.match(newToken(), /^[0-9a-f]{32}$/);
});

test('saved games: least recently used are evicted first, never the current one', () => {
  const entries = [
    { key: 'u/a', chars: 400, at: 1 },
    { key: 'u/b', chars: 400, at: 2 },
    { key: 'u/c', chars: 400, at: 3 },
  ];
  assert.deepEqual(chooseEvictions(entries, { maxChars: 1000, maxGames: 10 }), ['u/a']);
  assert.deepEqual(chooseEvictions(entries, { maxChars: 1000, maxGames: 10, keep: 'u/a' }), ['u/b']);
  assert.deepEqual(chooseEvictions(entries, { maxChars: 10_000, maxGames: 1 }), ['u/a', 'u/b']);
  assert.deepEqual(chooseEvictions(entries, { maxChars: 10_000, maxGames: 10 }), []);
});

// ---------- text helpers ----------

test('non-Latin titles: cover letters, <title> parsing and clipping keep characters whole', () => {
  assert.equal(coverLetter('🚀 Rocket'), '🚀');
  assert.equal(coverLetter('👩‍🚀 Astronaut'), '👩‍🚀');
  assert.equal(coverLetter('星のゲーム'), '星');
  assert.equal(coverLetter('لعبة'), 'ل');
  assert.equal(coverLetter('snake'), 'S');
  assert.equal(coverLetter('  '), '?');
  assert.equal(titleFromHtml('<title>&#x661F; &amp; &#128640; <b>Dodger</b></title>'), '星 & 🚀 Dodger');
  assert.equal(clipChars('ab🚀', 3), 'ab', 'never half an emoji');
  assert.equal(clipChars('ab🚀', 4), 'ab🚀');
  assert.equal(titleFromHtml(`<title>${'🎮'.repeat(50)}</title>`).length, 80);
});

test('publish refusals explain the likely cause', () => {
  const denied = { code: 'PERMISSION_DENIED' };
  assert.match(publishRefusal(denied, { lastAt: 1000, now: 20_000 }).message, /at most once a minute/);
  const stale = publishRefusal(denied, { lastAt: 0, now: 20_000 });
  assert.match(stale.message, /database rules/);
  assert.match(stale.message, /deploy the current database rules/);
  assert.equal(stale.code, 'PERMISSION_DENIED');
  const other = new Error('network');
  assert.equal(publishRefusal(other), other);
});

test('chat: a long code paste becomes a runnable snippet', () => {
  const text = `Here is my game\n\`\`\`html\n<!doctype html><html><head><title>t</title></head><body><canvas></canvas></body></html>\n\`\`\`\n\`\`\`css\nbody{margin:0}\n\`\`\`\n\`\`\`js\n${'console.log(1);\n'.repeat(400)}\`\`\``;
  const s = snippetFromLongText(text);
  assert.equal(s.caption, 'Here is my game');
  assert.equal(s.code.filename, 'index.html');
  assert.match(s.code.content, /<style>\nbody\{margin:0\}\n<\/style><\/head>/);
  assert.match(s.code.content, /console\.log\(1\);[\s\S]*<\/script><\/body><\/html>$/);
  assert.ok(!s.code.content.includes('codehub-run'), 'no Run heartbeat in the stored code');
  const units = extractRunnables({ text: s.caption, code: { lang: 'xml', filename: s.code.filename, content: s.code.content } });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'html');
  assert.deepEqual(snippetFromLongText('```py\nprint(1)\n```\n```py\nprint(2)\n```').code, { lang: 'py', content: 'print(1)\n\nprint(2)' });
  assert.equal(snippetFromLongText('```py\nprint(1)\n```\n```js\nx\n```'), null);
  assert.equal(snippetFromLongText('plain long prose'), null);
  assert.equal(snippetFromLongText('<!DOCTYPE html><html><body>hi</body></html>').code.lang, 'html');
});

// ---------- review fixes ----------

test('snippet profile (chat Run): play CSP, but no fullscreen or pointer lock', () => {
  const a = frameAttrs('snippet');
  assert.equal(a.sandbox, 'allow-scripts');
  assert.equal(a.allow, '');
  assert.equal(a.csp, PLAY_CSP);
  assert.ok(buildSrcdoc('<p>x</p>', { profile: 'snippet', mode: 'preview', token: 't' }).includes(PLAY_CSP.replace(/"/g, '&quot;')));
  // Add-ons are untouched.
  assert.ok(buildSrcdoc('<p>x</p>').startsWith(ORIGINAL_HEAD));
});

test('bundle: one React for ranges and unpinned imports; exact versions from simple ranges', () => {
  const code = "import { createRoot } from 'react-dom/client';\nimport { useState } from 'react';\nimport { jsx } from 'react/jsx-runtime';\nimport _ from 'lodash-es';";
  const page = '<div id="root"></div><script type="module" src="/src/main.js"></script>';
  const urls = (pkg) => {
    const f = { 'index.html': page, 'src/main.js': code };
    if (pkg) f['package.json'] = JSON.stringify({ dependencies: pkg });
    return bundle('index.html', files(f)).external.map((e) => e.url).sort();
  };
  assert.deepEqual(urls({ react: '^18.3.1', 'react-dom': '^18.3.1', 'lodash-es': '~4.17.21' }), [
    'https://cdn.jsdelivr.net/npm/lodash-es@4.17.21/+esm',
    'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/client/+esm',
    'https://cdn.jsdelivr.net/npm/react@18.3.1/+esm',
    'https://cdn.jsdelivr.net/npm/react@18.3.1/jsx-runtime/+esm',
  ]);
  assert.ok(urls(null).every((u) => /react(-dom)?@19\.3\.1\/|lodash-es\/\+esm/.test(u)), 'unpinned: one React version');
  assert.ok(urls({ react: '^18', 'react-dom': '^18' }).filter((u) => /react/.test(u)).every((u) => u.includes('@18.3.1/')));
  assert.ok(urls({ react: '18.2.0', 'react-dom': '^18.3.1' }).filter((u) => /react/.test(u)).every((u) => u.includes('@18.2.0/')));
  assert.equal(exactVersion('>=2.0.0'), '2.0.0');
  assert.equal(exactVersion('^1.2'), null);
  assert.equal(exactVersion('latest'), null);
});

test('bundle: CSS imported from modules (Vite style), CSS modules and package stylesheets', () => {
  const r = bundle('index.html', files({
    'index.html': '<div id="app"></div><script type="module" src="/src/main.js"></script>',
    'src/main.js': "import './style.css';\nimport s from './btn.module.css';\nimport 'bootstrap/dist/css/bootstrap.min.css';\ndocument.body.className = s.big;",
    'src/style.css': "@import './base.css';\nbody { color: red }",
    'src/base.css': 'html { margin: 0 }',
    'src/btn.module.css': '.big { font-size: 2em } .big:hover { color: blue }',
    'package.json': '{"dependencies":{"bootstrap":"^5.3.3"}}',
  }));
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.errors, []);
  const boot = JSON.parse(/\}\)\((\{"k":"@codehub-ws\/".*?)\);<\/script>/s.exec(r.html)[1]);
  assert.match(boot.m['src/style.css'], /document\.head\.appendChild\(s\)/);
  assert.match(boot.m['src/style.css'], /html \{ margin: 0 \}/, '@import inlined');
  assert.match(boot.m['src/btn.module.css'], /export default \{"big":"big"\}/);
  assert.equal(boot.map.imports['bootstrap/dist/css/bootstrap.min.css'], `${WS_PREFIX}.codehub-npm-css/bootstrap/dist/css/bootstrap.min.css`);
  assert.ok(r.external.some((e) => e.url === 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css' && e.allowed));
  assert.ok(!r.modules.some((p) => p.includes('codehub-npm-css')));
  // The main module's import now points at the generated module.
  assert.match(boot.m['src/main.js'], /import "@codehub-ws\/src\/style\.css"/);
});

test('Tailwind Play CDN maps to the official browser build on jsDelivr', () => {
  for (const u of ['https://cdn.tailwindcss.com', 'https://cdn.tailwindcss.com/', 'https://cdn.tailwindcss.com/3.4.16', 'https://cdn.tailwindcss.com?plugins=forms', '//cdn.tailwindcss.com']) {
    assert.equal(rewriteCdnUrl(u), TAILWIND_BROWSER_URL, u);
  }
  assert.ok(isAllowedUrl(TAILWIND_BROWSER_URL, 'script'));
  const r = bundle('index.html', files({ 'index.html': '<script src="https://cdn.tailwindcss.com"></script><h1 class="text-pink-500">x</h1>' }));
  assert.ok(r.html.includes(`<script src="${TAILWIND_BROWSER_URL}"></script>`));
  assert.ok(!r.html.includes('type="module"'));
});

function runtimeDom() {
  // Enough DOM for the runtime's WebRTC, nested-frame and focus guards.
  const listeners = {};
  class El {
    constructor(name) { this.nodeName = name.toUpperCase(); this.nodeType = 1; this.children = []; this.parent = null; }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    querySelectorAll(sel) {
      const names = sel.split(',').map((s) => s.trim().toUpperCase());
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (names.includes(c.nodeName)) out.push(c); walk(c); });
      walk(this);
      return out;
    }
    focus() { doc.activeElement = this; }
  }
  const doc = new El('#document');
  doc.nodeType = 9;
  doc.body = new El('body');
  doc.body.parent = doc;
  doc.children.push(doc.body);
  doc.activeElement = doc.body;
  doc.querySelector = () => null;
  doc.addEventListener = () => {};
  doc.createElement = (n) => new El(n);
  const observers = [];
  class MO {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
  }
  const append = (parent, child) => {
    child.parent = parent;
    parent.children.push(child);
    observers.forEach((o) => o.cb([{ addedNodes: [child] }]));
  };
  const proto = El.prototype;
  const timers = [];
  const g = {
    console: { info() {}, error() {}, log() {}, warn() {} },
    document: doc,
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    setTimeout: (fn) => timers.push(fn),
    DOMException,
    MutationObserver: MO,
    HTMLElement: function HTMLElement() {},
    RTCPeerConnection: function RTCPeerConnection() {},
    webkitRTCPeerConnection: function webkitRTCPeerConnection() {},
    RTCDataChannel: function RTCDataChannel() {},
  };
  g.HTMLElement.prototype = proto;
  g.window = g;
  g.parent = { postMessage() {} };
  const ctx = vm.createContext(g);
  vm.runInContext(playRuntimeScript({ token: 't', mode: 'game' }).replace(/^<script>/, '').replace(/<\/script>$/, ''), ctx);
  return { g, doc, El, append, fire: (t) => (listeners[t] || []).forEach((fn) => fn()), flush: () => { while (timers.length) timers.shift()(); }, run: (c) => vm.runInContext(c, ctx) };
}

test('runtime: no WebRTC in play frames, nested frames are removed', () => {
  const r = runtimeDom();
  assert.equal(r.run('typeof RTCPeerConnection'), 'undefined');
  assert.equal(r.run('typeof webkitRTCPeerConnection'), 'undefined');
  assert.equal(r.run('typeof RTCDataChannel'), 'undefined');
  r.run('RTCPeerConnection = function () {}');
  assert.equal(r.run('typeof RTCPeerConnection'), 'undefined', 'a game cannot put it back');
  const frame = new r.El('iframe');
  r.append(r.doc.body, frame);
  assert.equal(frame.parent, null);
  const wrap = new r.El('div');
  wrap.children.push(Object.assign(new r.El('iframe'), { parent: wrap }));
  r.append(r.doc.body, wrap);
  assert.equal(wrap.children.length, 0, 'frames inside inserted subtrees too');
  assert.equal(r.doc.body.children.length, 1);
});

test('runtime: a field the game focused gets focus back when the frame is focused', () => {
  const r = runtimeDom();
  const input = new r.El('input');
  r.append(r.doc.body, input);
  input.focus();
  r.doc.activeElement = r.doc.body; // the focus call was lost: the frame didn't have focus yet
  r.fire('focus');
  r.flush();
  assert.equal(r.doc.activeElement, input);
});

// Games, live preview and chat Run in the play sandbox: templates, a multi-file ES module game with a
// CDN library, an npm import, JSON data, localStorage and dialogs, published and played in the Arcade
// (saved data survives Restart and a reload), non-Latin titles, keyboard focus, and a long HTML game
// pasted into chat. Games in other languages: a multi-file TypeScript/TSX game, a JavaScript-only
// game (also published under rules that predate games/{id}/lang), Python (print/input console,
// tracebacks, pygame-ce), the Python and TypeScript templates, and the message for C/C++/Rust/Java.
// Review fixes: a Vite-style React project (caret versions, CSS imports, a module open in the editor),
// a component-only JSX file, an AI-style page (Tailwind Play CDN, a self-focused field, no WebRTC or
// nested frames, dialog focus), Python files that persist and turtle.distance(turtle), and saved data
// that stays with its own game when the player switches games.
// CDN requests (also Pyodide and pygame-ce) are served from a local cache (page.route), never the
// network, once the cache is filled (CODEHUB_CDN_CACHE, default <tmp>/codehub-cdn-cache).
// Python's input(), time.sleep and pygame loops need WebAssembly JSPI (Chrome 137+): with the
// bundled Chromium 130 those tests check the "can't pause Python" message instead. To run them for
// real, point CODEHUB_E2E_CHROMIUM at a newer Chromium/Chrome executable.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, createServer } from './fixtures.mjs';
import { DB, NS, RULES } from './global-setup.mjs';
import { makeZip } from '../../src/lib/zip.js';

if (process.env.CODEHUB_E2E_CHROMIUM) test.use({ launchOptions: { executablePath: process.env.CODEHUB_E2E_CHROMIUM } });

const CDN_CACHE = process.env.CODEHUB_CDN_CACHE || join(tmpdir(), 'codehub-cdn-cache');
const CDN_FILES = {
  'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js': 'text/javascript',
  'https://cdn.jsdelivr.net/npm/nanoid@5.0.7/+esm': 'text/javascript',
  'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js': 'text/javascript',
};
// Whole pinned runtimes the language layer loads (any file under these prefixes).
const CDN_PREFIXES = [
  'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/',
  'https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/',
  // React (one exact version per major line, see sandbox.js reactVersion) and the Tailwind browser build.
  'https://cdn.jsdelivr.net/npm/react@18.3.1/',
  'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/',
  'https://cdn.jsdelivr.net/npm/scheduler@0.23.2/',
  'https://cdn.jsdelivr.net/npm/react@19.3.1/',
  'https://cdn.jsdelivr.net/npm/react-dom@19.3.1/',
  'https://cdn.jsdelivr.net/npm/scheduler@0.28.0/',
  'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.5/',
];
const CDN_TYPES = { js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', json: 'application/json', zip: 'application/zip', whl: 'application/zip' };
const cdnType = (url) => CDN_FILES[url] || (/\/\+esm$/.test(url) ? 'text/javascript' : CDN_TYPES[url.split(/[?#]/)[0].split('.').pop()] || 'application/octet-stream');
const CDN_HOSTS = /^https:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

async function cdnBody(url) {
  const file = join(CDN_CACHE, createHash('sha256').update(url).digest('hex').slice(0, 24));
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fill the CDN cache with ${url}: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(CDN_CACHE, { recursive: true });
  writeFileSync(file, body);
  return body;
}

/** Serve the known CDN files from the cache; refuse every other CDN request (no network in tests). */
async function routeCdn(page) {
  await page.route(CDN_HOSTS, async (route) => {
    const url = route.request().url();
    if (!CDN_FILES[url] && !CDN_PREFIXES.some((p) => url.startsWith(p))) return route.abort();
    return route.fulfill({ status: 200, body: await cdnBody(url), contentType: cdnType(url), headers: { 'access-control-allow-origin': '*' } });
  });
}

/** Load database rules into the emulator (the app's namespace). */
async function putRules(json) {
  const r = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: json });
  if (!r.ok) throw new Error(`loading rules failed: ${r.status} ${await r.text()}`);
}
/** The current rules without games/{id}/lang: what the server has until the owner pastes new rules. */
function rulesWithoutLang() {
  const rules = JSON.parse(readFileSync(RULES, 'utf8'));
  delete rules.rules.games.$gameId.lang;
  return JSON.stringify(rules);
}

const composer = (page) => page.locator('textarea[aria-label^="Message"]');

async function openCodespaces(page) {
  await page.getByRole('button', { name: 'Codespaces', exact: true }).click();
}

async function newCodespace(page, name, template) {
  await openCodespaces(page);
  await page.getByRole('button', { name: 'New codespace' }).first().click();
  await page.locator('.cs-modal').getByLabel('Name').fill(name);
  await page.getByRole('radio', { name: new RegExp(template) }).click();
  await page.getByRole('button', { name: 'Create codespace' }).click();
  await expect(page.locator('.cs-modal')).toHaveCount(0, { timeout: 30_000 });
  // A template opens its first file (editor toolbar); a blank codespace shows its welcome actions.
  const ready = template === 'Blank' ? page.getByRole('button', { name: /Export \/ Import/ }) : page.getByRole('button', { name: 'Publish game' });
  await expect(ready).toBeEnabled({ timeout: 30_000 });
}

async function importZip(page, entries) {
  const blob = makeZip(entries.map(([path, text]) => ({ path, data: text })));
  const buffer = Buffer.from(await blob.arrayBuffer());
  await page.getByRole('button', { name: /Export \/ Import/ }).click();
  await page.getByRole('menuitem', { name: /Import files/ }).click();
  const dlg = page.locator('.pd-import-modal');
  await dlg.locator('input[type=file][accept*="zip"]').setInputFiles({ name: 'game.zip', mimeType: 'application/zip', buffer });
  await dlg.getByRole('button', { name: new RegExp(`^Import ${entries.length} files?$`) }).click();
  await expect(dlg).toContainText(`Done: ${entries.length} of ${entries.length} written`, { timeout: 60_000 });
  await dlg.locator('.pd-actions').getByRole('button', { name: 'Close' }).click();
}

async function openFile(page, path) {
  await page.locator('.cx-tree').getByTitle(path, { exact: true }).click();
  await expect(page.locator('.cx-crumbs')).toHaveAttribute('title', path);
}

async function openPreview(page) {
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  return page.frameLocator('iframe[title^="Preview of"]');
}

async function publish(page, { title, desc }) {
  await page.getByRole('button', { name: 'Publish game' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish game' });
  await expect(dlg.getByLabel('Entry file')).toBeVisible({ timeout: 30_000 });
  if (title) await dlg.getByLabel('Title').fill(title);
  if (desc) await dlg.getByLabel('Description').fill(desc);
  return dlg;
}

async function confirmPublish(dlg) {
  await dlg.getByRole('checkbox').check();
  await dlg.getByRole('button', { name: 'Publish publicly' }).click();
  await expect(dlg.getByRole('heading', { name: 'Game published' })).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Done' }).click();
}

async function playInArcade(page, title) {
  await page.getByRole('button', { name: 'Arcade (public games)' }).click();
  await page.getByRole('button', { name: `Play ${title}` }).click();
  await expect(page.getByRole('dialog', { name: `Playing ${title}` })).toBeVisible();
  return page.frameLocator(`iframe[title="Game: ${title}"]`);
}

const activeTitle = (page) => page.evaluate(() => document.activeElement?.getAttribute('title') || document.activeElement?.tagName);

// ---------- the multi-file game ----------

const CLICKER = [
  ['index.html', `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Module Clicker</title>
  <link rel="stylesheet" href="css/style.css">
  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
  <script src="https://example.com/analytics.js"></script>
</head>
<body>
  <button id="hit" type="button">Hit</button>
  <p id="status">Loading…</p>
  <p id="player"></p>
  <p id="lib"></p>
  <p>Score <span id="score">0</span> · <span id="best">Best: 0</span> · <span id="games">Games: 0</span></p>
  <script type="module" src="src/main.js"></script>
</body>
</html>
`],
  ['css/style.css', '#hit { padding: 12px 20px; background: #234 url(../img/star.svg) no-repeat right center; color: #fff; }\n'],
  ['img/star.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="gold"/></svg>'],
  ['src/main.js', `import { loadLevels } from './levels.js';
import { createScore } from './score.js';
import { nanoid } from 'nanoid';

const $ = (id) => document.getElementById(id);
const name = prompt('Your name?', 'Player 1');
$('player').textContent = 'Player: ' + name;
$('lib').textContent = 'confetti: ' + typeof confetti + ' · id: ' + nanoid(8).length;
const score = createScore('module-clicker-best');
let games = 1;
const render = () => {
  $('score').textContent = String(score.current);
  $('best').textContent = 'Best: ' + score.best;
  $('games').textContent = 'Games: ' + games;
};
const levels = await loadLevels();
$('status').textContent = 'Ready: ' + levels[0].name;
render();
$('hit').addEventListener('click', () => {
  score.add(1);
  if (score.current >= 3) {
    score.save();
    alert('Game over! Score ' + score.current);
    if (confirm('Play again?')) {
      games += 1;
      score.reset();
    }
  }
  render();
});
`],
  ['src/score.js', `// Unguarded localStorage, like most generated games.
export function createScore(key) {
  const s = {
    current: 0,
    best: Number(localStorage.getItem(key)) || 0,
    add(n) { s.current += n; },
    save() { if (s.current > s.best) { s.best = s.current; localStorage.setItem(key, String(s.best)); } },
    reset() { s.current = 0; },
  };
  return s;
}
`],
  ['src/levels.js', "export async function loadLevels() {\n  const res = await fetch('data/levels.json');\n  return res.json();\n}\n"],
  ['data/levels.json', '[{ "name": "Crystal Caves 💎" }, { "name": "Lava Lake" }]'],
  ['package.json', '{ "name": "module-clicker", "dependencies": { "nanoid": "5.0.7" } }'],
];

test('multi-file module game: CDN library, npm import, JSON data, dialogs and a high score that survives Restart and a reload', async ({ users }) => {
  test.setTimeout(240_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Clicker', 'Blank');
  await importZip(alice, CLICKER);
  await openFile(alice, 'index.html');

  // Live preview: modules, the npm package, the classic CDN script and the JSON file all load.
  const pv = await openPreview(alice);
  await expect(pv.locator('#status')).toHaveText('Ready: Crystal Caves 💎', { timeout: 30_000 });
  await expect(pv.locator('#lib')).toHaveText('confetti: function · id: 8');
  await expect(pv.locator('#player')).toHaveText('Player: Player 1');
  await expect(pv.locator('#hit')).toHaveCSS('background-image', /data:image\/svg\+xml;base64/);
  await expect(alice.locator('.sbx-banner.warn')).toContainText('The sandbox blocks https://example.com/analytics.js');
  await expect(alice.locator('.sbx-log')).toContainText('Blocked by the sandbox');
  // The preview does not keep storage between runs, but works within one.
  await pv.locator('#hit').click();
  await pv.locator('#hit').click();
  await pv.locator('#hit').click();
  await expect(pv.locator('#best')).toHaveText('Best: 3');
  await expect(alice.locator('.sbx-log')).toContainText('Game over! Score 3');
  await alice.getByRole('button', { name: 'Close preview' }).click();

  const dlg = await publish(alice, { desc: 'Click three times. Uses ES modules, an npm package and a CDN library.' });
  await expect(dlg.getByLabel('Title')).toHaveValue('Module Clicker');
  await expect(dlg).toContainText('Inlined 6 files');
  await expect(dlg.getByRole('note')).toContainText('Won’t load in the sandbox: https://example.com/analytics.js');
  await dlg.getByRole('button', { name: /Test run/ }).click();
  const tr = alice.frameLocator('iframe[title="Game test run"]');
  await expect(tr.locator('#status')).toHaveText('Ready: Crystal Caves 💎', { timeout: 30_000 });
  await expect(dlg.getByRole('alert', { name: 'Test run problems' })).toContainText('https://example.com/analytics.js');
  await confirmPublish(dlg);

  // Arcade: the game runs, the blocked script is explained, the frame has keyboard focus.
  let game = await playInArcade(alice, 'Module Clicker');
  const issues = alice.locator('.gm-issues');
  await expect(issues).toContainText('The sandbox blocked part of this game', { timeout: 30_000 });
  await expect(issues).toContainText('https://example.com/analytics.js');
  await expect(issues).toContainText('cdn.jsdelivr.net/npm');
  await issues.getByRole('button', { name: 'Dismiss' }).click();
  await expect(game.locator('#status')).toHaveText('Ready: Crystal Caves 💎');
  await expect(game.locator('#lib')).toHaveText('confetti: function · id: 8');
  await expect(game.locator('#best')).toHaveText('Best: 0');
  await expect.poll(() => activeTitle(alice)).toBe('Game: Module Clicker');

  // alert / confirm / prompt don't break the game: the notice shows, confirm says OK, play goes on.
  for (let i = 0; i < 3; i++) await game.locator('#hit').click();
  await expect(game.locator('codehub-notice .n', { hasText: 'Game over! Score 3' })).toBeVisible();
  await expect(game.locator('#games')).toHaveText('Games: 2');
  await expect(game.locator('#score')).toHaveText('0');
  await expect(game.locator('#best')).toHaveText('Best: 3');

  // Focus left the game (a click on the player's toolbar): a hint brings it back.
  await alice.getByRole('dialog', { name: 'Playing Module Clicker' }).locator('.gm-like').focus();
  const hint = alice.getByRole('button', { name: 'Click the game to play with the keyboard' });
  await expect(hint).toBeVisible();
  await hint.click();
  await expect(hint).toBeHidden();
  await expect.poll(() => activeTitle(alice)).toBe('Game: Module Clicker');

  // Restart keeps the saved high score.
  await alice.getByRole('button', { name: 'Restart' }).first().click();
  game = alice.frameLocator('iframe[title="Game: Module Clicker"]');
  await expect(game.locator('#status')).toHaveText('Ready: Crystal Caves 💎');
  await expect(game.locator('#best')).toHaveText('Best: 3');
  await expect(game.locator('#games')).toHaveText('Games: 1');

  // A reload of the whole app (and the next visit) too.
  await alice.waitForTimeout(500);
  await alice.reload();
  await expect(alice.getByRole('navigation', { name: 'Servers' })).toBeVisible({ timeout: 60_000 });
  game = await playInArcade(alice, 'Module Clicker');
  await expect(game.locator('#best')).toHaveText('Best: 3', { timeout: 30_000 });
  // Saved data can be cleared from the player.
  await alice.getByRole('button', { name: 'Clear saved data' }).click();
  await alice.getByRole('button', { name: 'Click again to clear' }).click();
  game = alice.frameLocator('iframe[title="Game: Module Clicker"]');
  await expect(game.locator('#best')).toHaveText('Best: 0');
});

test('Canvas game template: live preview, non-Latin title, Arcade play with keyboard focus, fullscreen', async ({ users }) => {
  test.setTimeout(180_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Dodger', 'Canvas game');

  const pv = await openPreview(alice);
  const pvCanvas = pv.locator('canvas#game');
  await expect(pvCanvas).toBeVisible({ timeout: 30_000 });
  await pvCanvas.click();
  await alice.keyboard.press('Space');
  await expect.poll(() => pvCanvas.evaluate(() => state.mode)).toBe('play'); // eslint-disable-line no-undef
  await alice.getByRole('button', { name: 'Close preview' }).click();

  const title = '星际躲避 Star Dodger 🚀 نجمة';
  const desc = '躲避陨石 · تجنب الصخور · 🎮 Space to start';
  const dlg = await publish(alice, { title, desc });
  await expect(dlg.getByLabel('Title')).toHaveAttribute('dir', 'auto');
  await confirmPublish(dlg);

  await alice.getByRole('button', { name: 'Arcade (public games)' }).click();
  const card = alice.locator('.gm-card', { hasText: title });
  await expect(card.locator('.gm-card-title')).toHaveText(title);
  await expect(card.locator('.gm-card-title')).toHaveAttribute('dir', 'auto');
  await expect(card.locator('.gm-card-desc')).toHaveText(desc);
  await expect(card.locator('.gm-cover-letter')).toHaveText('星');
  await card.getByRole('button', { name: `Play ${title}` }).click();
  const player = alice.getByRole('dialog', { name: `Playing ${title}` });
  await expect(player.getByRole('heading', { name: title })).toBeVisible();
  const canvas = alice.frameLocator(`iframe[title="Game: ${title}"]`).locator('canvas#game');
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // No click needed: the player gives the game keyboard focus.
  await expect.poll(() => activeTitle(alice)).toBe(`Game: ${title}`);
  await alice.keyboard.press('Space');
  await expect.poll(() => canvas.evaluate(() => state.mode)).toBe('play'); // eslint-disable-line no-undef
  const x0 = await canvas.evaluate(() => state.ship.x); // eslint-disable-line no-undef
  await alice.keyboard.down('ArrowRight');
  await alice.waitForTimeout(300);
  await alice.keyboard.up('ArrowRight');
  expect(await canvas.evaluate(() => state.ship.x)).toBeGreaterThan(x0); // eslint-disable-line no-undef

  // Games may use fullscreen themselves; the player can show the game full screen.
  expect(await canvas.evaluate(() => document.fullscreenEnabled)).toBe(true);
  await player.getByRole('button', { name: 'Full screen' }).click();
  await expect.poll(() => alice.evaluate(() => document.fullscreenElement?.className || '')).toContain('gm-stage');
  await expect(player.locator('.gm-player-head').getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true');
  // The toolbar is outside the full-screen stage; the stage has its own exit button.
  await player.locator('.gm-stage').getByRole('button', { name: 'Exit full screen' }).click();
  await expect.poll(() => alice.evaluate(() => !!document.fullscreenElement)).toBe(false);
});

test('Snake template: live preview and the publish test run play it', async ({ users }) => {
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Snake', 'Snake');
  const pv = await openPreview(alice);
  const board = pv.locator('canvas').first();
  await expect(board).toBeVisible({ timeout: 30_000 });
  await board.click();
  await alice.keyboard.press('ArrowUp');
  await expect.poll(() => board.evaluate(() => running)).toBe(true); // eslint-disable-line no-undef
  await alice.getByRole('button', { name: 'Close preview' }).click();

  const dlg = await publish(alice, {});
  await dlg.getByRole('button', { name: /Test run/ }).click();
  const run = alice.frameLocator('iframe[title="Game test run"]').locator('canvas').first();
  await expect(run).toBeVisible({ timeout: 30_000 });
  await run.click();
  await alice.keyboard.press('ArrowUp');
  await expect.poll(() => run.evaluate(() => running)).toBe(true); // eslint-disable-line no-undef
  expect(await alice.locator('iframe[title="Game test run"]').getAttribute('sandbox')).toBe('allow-scripts allow-pointer-lock');
});

test('live preview: a p5.js game from cdnjs runs (served from the local CDN cache)', async ({ users }) => {
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Sketch', 'Blank');
  await importZip(alice, [
    ['index.html', `<!doctype html><html><head><title>p5 Catcher</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js"></script></head>
<body><p id="frames">0</p><script>
let x = 200, drawn = 0;
function setup() { createCanvas(400, 300); }
function draw() { background(30); fill(255, 200, 0); circle(x, 250, 30); if (keyIsDown(RIGHT_ARROW)) x += 4; drawn++; if (drawn % 10 === 0) document.getElementById('frames').textContent = String(drawn); }
</script></body></html>`],
  ]);
  await openFile(alice, 'index.html');
  const pv = await openPreview(alice);
  await expect(pv.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => Number(await pv.locator('#frames').textContent())).toBeGreaterThan(20);
  await expect(alice.locator('.sbx-banner.warn')).toHaveCount(0);
});

test('chat: a long HTML game paste is sent as a snippet and runs with storage and dialogs', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Games');
  await alice.getByRole('button', { name: /^general$/ }).first().click();
  await expect(composer(alice)).toHaveAttribute('aria-label', 'Message #general');
  const level = Array.from({ length: 320 }, (_, i) => `[${i % 7}, ${(i * 3) % 11}, ${(i * 5) % 13}]`).join(', ');
  const text = [
    'Try my game 🎮',
    '```html',
    '<!doctype html><html><head><title>Chat Runner</title></head><body><h1 id="title">Chat Runner</h1><p id="out">…</p><canvas id="c" width="200" height="100"></canvas></body></html>',
    '```',
    '```css',
    'body { background: #102; color: #fff; font-family: system-ui; } #out { color: rgb(0, 255, 0); }',
    '```',
    '```js',
    `const LEVEL = [${level}];`,
    "const runs = Number(localStorage.getItem('runs') || 0) + 1;",
    "localStorage.setItem('runs', String(runs));",
    "const who = prompt('Name?', 'Ann');",
    "alert('Welcome ' + who);",
    "document.getElementById('out').textContent = (confirm('Ready?') ? 'ready' : 'no') + ' ' + who + ' runs=' + localStorage.getItem('runs') + ' cells=' + LEVEL.length;",
    '```',
  ].join('\n');
  expect(text.length).toBeGreaterThan(4000);
  await composer(alice).fill(text);
  await expect(alice.locator('.composer-count.snippet')).toHaveText('Sends as a code snippet');
  await composer(alice).press('Enter');
  const msg = alice.locator('.msg', { hasText: 'Try my game 🎮' });
  await expect(msg.getByRole('button', { name: 'Run HTML' })).toBeVisible({ timeout: 30_000 });
  await expect(composer(alice)).toHaveValue('');
  await msg.getByRole('button', { name: 'Run HTML' }).click();
  const frame = alice.frameLocator('.mx-run-frame:not(.hidden)');
  await expect(frame.locator('#out')).toHaveText('ready Ann runs=1 cells=320');
  await expect(frame.locator('#out')).toHaveCSS('color', 'rgb(0, 255, 0)');
  await expect(frame.locator('codehub-notice .n', { hasText: 'Welcome Ann' })).toBeVisible();
  const out = msg.getByRole('region', { name: 'HTML output' });
  await expect(out.getByRole('log')).toContainText('Welcome Ann');
});

// ---------- games in other languages ----------

/** RGBA of one canvas pixel (works for pygame's canvas too: copied through a 2D canvas). */
const pixel = (canvas, x, y) =>
  canvas.evaluate(
    (c, [px, py]) => {
      const d = document.createElement('canvas');
      d.width = c.width;
      d.height = c.height;
      const g = d.getContext('2d');
      g.drawImage(c, 0, 0);
      return Array.from(g.getImageData(px, py, 1, 1).data);
    },
    [x, y],
  );
const hasJspi = (page) => page.evaluate(() => typeof WebAssembly.Suspending === 'function');

async function entryOptions(dlg) {
  return dlg.getByLabel('Entry file').locator('option').allTextContents();
}

const TS_GAME = [
  ['main.ts', `import { World, Dir } from './world.js'; // TypeScript convention: ./world.js is world.ts
import { hud } from './hud';
import type { Point } from './types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const world = new World(canvas.width, canvas.height);
const start: Point = { x: world.x, y: 0 };
(window as unknown as { world: World }).world = world;
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'ArrowRight') world.move(Dir.Right);
  if (e.key === 'ArrowLeft') world.move(Dir.Left);
});
document.body.append(hud(world, start));
function draw(): void {
  ctx.fillStyle = 'rgb(10, 20, 30)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgb(250, 200, 0)';
  ctx.fillRect(world.x, 40, 20, 20);
  requestAnimationFrame(draw);
}
draw();
console.log('TS game ready', Dir[Dir.Right]);
`],
  ['world.ts', `export enum Dir { Left = -1, Right = 1 }
export namespace Speed { export const step = 10; }
export class World {
  x = 20;
  constructor(public readonly width: number, private height: number) {}
  move(dir: Dir): void { this.x = Math.max(0, Math.min(this.width - 20, this.x + dir * Speed.step)); }
}
`],
  ['hud.tsx', `import { h } from './h';
import type { World } from './world';
import type { Point } from './types';
export const hud = (w: World, p: Point): HTMLElement => <p id="hud" class="hud">TSX hud: start {p.x} of {w.width > 0 ? 'wide' : 'none'}</p>;
`],
  ['h.ts', `export function h(tag: string, props: Record<string, string> | null, ...children: unknown[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) el.setAttribute(k, v);
  el.append(...children.map(String));
  return el;
}
`],
  ['types.ts', 'export interface Point { x: number; y: number }\n'],
  ['tsconfig.json', '{\n  // comments are fine here\n  "compilerOptions": { "strict": true, "jsx": "react", "jsxFactory": "h" }\n}\n'],
];

test('TypeScript multi-file game (enum, namespace, TSX, tsconfig): preview, publish with its language, play in the Arcade', async ({ users }) => {
  test.setTimeout(180_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'TS Mover', 'Blank');
  await importZip(alice, TS_GAME);
  await openFile(alice, 'world.ts');

  // A module previews through the entry that imports it.
  const pv = await openPreview(alice);
  await expect(alice.locator('.sbx-entry')).toContainText('Auto: main.ts');
  await expect(pv.locator('#hud')).toHaveText('TSX hud: start 20 of wide', { timeout: 60_000 });
  await expect(pv.locator('#cx-console')).toContainText('TS game ready Right');
  await expect(alice.locator('.sbx-log')).toContainText('TS game ready Right');
  await pv.locator('canvas#game').click();
  await alice.keyboard.press('ArrowRight');
  await expect.poll(() => pv.locator('canvas#game').evaluate(() => window.world.x)).toBe(30);
  await alice.getByRole('button', { name: 'Close preview' }).click();

  const dlg = await publish(alice, { title: 'TS Mover' });
  expect(await entryOptions(dlg)).toEqual(['main.ts · TypeScript']);
  await expect(dlg.locator('.gm-lang')).toHaveText('TypeScript');
  await expect(dlg).toContainText('Inlined 4 files');
  await confirmPublish(dlg);

  await alice.getByRole('button', { name: 'Arcade (public games)' }).click();
  const card = alice.locator('.gm-card', { hasText: 'TS Mover' });
  await expect(card.locator('.gm-lang')).toHaveText('TypeScript');
  const game = await playInArcade(alice, 'TS Mover');
  await expect(game.locator('#hud')).toHaveText('TSX hud: start 20 of wide', { timeout: 30_000 });
  await expect.poll(() => activeTitle(alice)).toBe('Game: TS Mover');
  await alice.keyboard.press('ArrowRight');
  await alice.keyboard.press('ArrowRight');
  await expect.poll(() => game.locator('canvas#game').evaluate(() => window.world.x)).toBe(40);
  expect(await pixel(game.locator('canvas#game'), 45, 50)).toEqual([250, 200, 0, 255]);
});

test('JavaScript-only game (no HTML): canvas page, publish under rules that predate games/{id}/lang', async ({ users }) => {
  test.setTimeout(180_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'JS Only', 'Blank');
  await importZip(alice, [
    ['game.js', `// A plain script: top-level functions stay global.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let taps = Number(localStorage.getItem('taps') || 0);
function paint() {
  ctx.fillStyle = 'rgb(0, 128, 255)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = '20px sans-serif';
  ctx.fillText('Taps: ' + taps, 20, 40);
  document.title = 'taps ' + taps;
}
canvas.addEventListener('click', () => { taps++; localStorage.setItem('taps', String(taps)); paint(); });
paint();
console.log('size', canvas.width > 100 && canvas.height > 100);
`],
  ]);
  await openFile(alice, 'game.js');
  const pv = await openPreview(alice);
  const c = pv.locator('canvas#game');
  await expect(c).toBeVisible({ timeout: 30_000 });
  await expect(alice.locator('.sbx-log')).toContainText('size true');
  expect(await pixel(c, 5, 80)).toEqual([0, 128, 255, 255]);
  await c.click();
  await expect.poll(() => c.evaluate(() => document.title)).toBe('taps 1');
  await alice.getByRole('button', { name: 'Close preview' }).click();

  // The server still has rules from before games/{id}/lang: publishing retries without it.
  await putRules(rulesWithoutLang());
  try {
    const dlg = await publish(alice, { title: 'Tap Blue' });
    expect(await entryOptions(dlg)).toEqual(['game.js · JavaScript']);
    await confirmPublish(dlg);
    await alice.getByRole('button', { name: 'Arcade (public games)' }).click();
    const card = alice.locator('.gm-card', { hasText: 'Tap Blue' });
    await expect(card).toBeVisible();
    await expect(card.locator('.gm-lang')).toHaveCount(0); // not recorded…
    const game = await playInArcade(alice, 'Tap Blue');
    // …but the player reads the language marker in the code.
    await expect(alice.getByRole('dialog', { name: 'Playing Tap Blue' }).locator('.gm-player-sub .gm-lang')).toHaveText('JavaScript');
    const gc = game.locator('canvas#game');
    await expect(gc).toBeVisible({ timeout: 30_000 });
    await gc.click();
    await gc.click();
    await expect.poll(() => gc.evaluate(() => document.title)).toBe('taps 2');
  } finally {
    await putRules(readFileSync(RULES, 'utf8'));
  }
});

const PY_CONSOLE = [
  ['main.py', `import sys
from helpers import greet
import helpers

print("python", sys.version.split()[0])
name = input("Your name? ")
print(greet(name))
n = int(input("A number: "))
helpers.check(n)
`],
  ['helpers.py', `def greet(n):
    return f"Hello, {n}!"


def check(n):
    if n == 7:
        raise ValueError("seven is not allowed")
    print("ok", n * 2)
`],
];

test('Python console game: print, input(), multi-file imports and clean tracebacks; published and played', async ({ users }) => {
  test.setTimeout(300_000);
  const alice = await users('alice');
  await routeCdn(alice);
  const jspi = await hasJspi(alice);
  await newCodespace(alice, 'Py Hello', 'Blank');
  await importZip(alice, PY_CONSOLE);
  await openFile(alice, 'helpers.py');

  const pv = await openPreview(alice);
  await expect(alice.locator('.sbx-entry')).toContainText('Auto: main.py');
  const con = pv.locator('#cx-con');
  await expect(con).toContainText('python 3.14', { timeout: 90_000 });
  if (jspi) {
    await pv.locator('#cx-field').fill('Ada');
    await pv.locator('#cx-field').press('Enter');
    await expect(con).toContainText('Hello, Ada!');
    await pv.locator('#cx-field').fill('7');
    await pv.locator('#cx-field').press('Enter');
    await expect(con).toContainText('ValueError: seven is not allowed');
    await expect(con).toContainText('File "helpers.py", line 7, in check');
    await expect(con).toContainText('File "main.py", line 9');
    await expect(con).not.toContainText('_pyodide');
    await expect(con).not.toContainText('runpy');
    // Output and the error also reach the preview console.
    await expect(alice.locator('.sbx-log')).toContainText('Hello, Ada!');
    await expect(alice.locator('.sbx-log')).toContainText('ValueError: seven is not allowed (helpers.py line 7)');
  } else {
    await expect(con).toContainText("This browser can't pause Python");
    await expect(con).toContainText('RuntimeError');
  }
  await alice.getByRole('button', { name: 'Close preview' }).click();

  const dlg = await publish(alice, { title: 'Py Hello' });
  expect(await entryOptions(dlg)).toEqual(['main.py · Python']);
  await expect(dlg.locator('.gm-lang-line')).toContainText('Python games download about 6 MB');
  await confirmPublish(dlg);

  await alice.getByRole('button', { name: 'Arcade (public games)' }).click();
  await expect(alice.locator('.gm-card', { hasText: 'Py Hello' }).locator('.gm-lang')).toHaveText('Python');
  const game = await playInArcade(alice, 'Py Hello');
  await expect(alice.getByRole('dialog', { name: 'Playing Py Hello' }).locator('.gm-player-sub')).toContainText('first play downloads about 6 MB');
  const gcon = game.locator('#cx-con');
  await expect(gcon).toContainText('python 3.14', { timeout: 90_000 });
  if (jspi) {
    await game.locator('#cx-field').fill('Bo');
    await game.locator('#cx-field').press('Enter');
    await expect(gcon).toContainText('Hello, Bo!');
    await game.locator('#cx-field').fill('3');
    await game.locator('#cx-field').press('Enter');
    await expect(gcon).toContainText('ok 6');
  } else {
    // The Python error is reported in the player's error panel too.
    await expect(alice.locator('.gm-issues')).toContainText('RuntimeError');
  }
});

test('Python game template (pygame-ce): preview plays with the keyboard, publish test run', async ({ users }) => {
  test.setTimeout(300_000);
  const alice = await users('alice');
  await routeCdn(alice);
  const jspi = await hasJspi(alice);
  await newCodespace(alice, 'Coins', 'Python game');
  await expect(alice.locator('.cx-crumbs')).toHaveAttribute('title', 'main.py');

  const pv = await openPreview(alice);
  const canvas = pv.locator('canvas#canvas');
  if (!jspi) {
    await expect(pv.locator('#cx-con')).toContainText('pygame games need a browser that can pause Python', { timeout: 120_000 });
    return;
  }
  await expect(pv.locator('#cx-con')).toContainText('Coin Rush! Best score so far: 0', { timeout: 120_000 });
  await expect(canvas).toBeVisible();
  // The sky and the basket (centre bottom) are drawn; holding → moves the basket right.
  await expect.poll(() => pixel(canvas, 5, 200)).toEqual([18, 24, 40, 255]);
  await expect.poll(() => pixel(canvas, 240, 339)).toEqual([235, 240, 250, 255]);
  await canvas.click();
  await alice.keyboard.down('ArrowRight');
  await alice.waitForTimeout(600);
  await alice.keyboard.up('ArrowRight');
  await expect.poll(() => pixel(canvas, 240, 339)).toEqual([18, 24, 40, 255]);
  // The app stays responsive while the game loop runs.
  await expect(alice.getByRole('button', { name: 'Close preview' })).toBeEnabled();
  await alice.getByRole('button', { name: 'Close preview' }).click();

  const dlg = await publish(alice, {});
  await expect(dlg.getByLabel('Title')).toHaveValue('Coins');
  await dlg.getByRole('button', { name: /Test run/ }).click();
  const tr = alice.frameLocator('iframe[title="Game test run"]');
  await expect(tr.locator('#cx-con')).toContainText('Coin Rush!', { timeout: 120_000 });
  await expect.poll(() => pixel(tr.locator('canvas#canvas'), 5, 200)).toEqual([18, 24, 40, 255]);
});

test('TypeScript game template: compiles and plays in the preview', async ({ users }) => {
  test.setTimeout(180_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Bricks', 'TypeScript game');
  const pv = await openPreview(alice);
  await expect(alice.locator('.sbx-entry')).toContainText('main.ts');
  const c = pv.locator('canvas#game');
  await expect(c).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => c.evaluate((el) => [el.width, el.height])).toEqual([480, 320]);
  await expect.poll(() => pixel(c, 20, 45)).toEqual([255, 107, 107, 255]); // first row of bricks
  await expect(alice.locator('.sbx-log .sbx-line.error')).toHaveCount(0);
  await c.click();
  await alice.keyboard.press('Space');
  // The ball leaves the paddle (it was drawn right above it).
  await expect.poll(() => pixel(c, 240, 291), { timeout: 10_000 }).not.toEqual([232, 236, 244, 255]);
});

test('C, C++, Rust and Java: the publish modal and the preview explain they can’t run in the browser', async ({ users }) => {
  const alice = await users('alice');
  await newCodespace(alice, 'Native', 'Blank');
  await importZip(alice, [
    ['main.cpp', '#include <cstdio>\nint main() { std::puts("hi"); }\n'],
    ['Game.java', 'class Game { public static void main(String[] a) {} }\n'],
    ['src/lib.rs', 'fn main() {}\n'],
  ]);
  await openFile(alice, 'main.cpp');
  await alice.getByRole('button', { name: 'Publish game' }).click();
  const dlg = alice.getByRole('dialog', { name: 'Publish game' });
  const msg = dlg.getByRole('alert');
  await expect(msg).toContainText('Nothing in this workspace can run as a game yet.', { timeout: 30_000 });
  await expect(msg).toContainText('Found C++, Rust, Java code.');
  await expect(msg).toContainText('need a compiler that is too large to run in your browser');
  await expect(msg).toContainText('JavaScript, TypeScript, Python or Lua');
  await dlg.getByRole('button', { name: 'Close' }).click();

  await openPreview(alice);
  await expect(alice.locator('.sbx-stage')).toContainText('can’t run or publish them');
});

test('Lua game: print, input(), require, canvas and frame() in the preview', async ({ users }) => {
  test.setTimeout(180_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Lua Box', 'Blank');
  await importZip(alice, [
    ['main.lua', `local util = require("util")
print("lua", _VERSION)
local name = input("Name? ")
print(util.greet(name))
ctx.fillStyle = "rgb(0, 200, 100)"
local x = 0
for i = 1, 20 do
  ctx:clearRect(0, 0, 640, 400)
  ctx:fillRect(x, 10, 20, 20)
  x = x + 5
  frame()
end
print("moved", x)
error("boom")
`],
    ['util.lua', 'local M = {}\nfunction M.greet(n) return "Hi " .. n end\nreturn M\n'],
    ['busy.lua', 'print("spinning")\nlocal n = 0\nwhile true do n = n + 1 end\n'],
  ]);
  await openFile(alice, 'main.lua');
  const pv = await openPreview(alice);
  const con = pv.locator('#cx-con');
  await expect(con).toContainText('lua Lua 5.4', { timeout: 60_000 });
  await pv.locator('#cx-field').fill('Lin');
  await pv.locator('#cx-field').press('Enter');
  await expect(con).toContainText('Hi Lin');
  await expect(con).toContainText('moved 100');
  await expect(con).toContainText('main.lua:14: boom');
  expect(await pixel(pv.locator('canvas#canvas'), 105, 20)).toEqual([0, 200, 100, 255]);
  await expect(alice.locator('.sbx-log')).toContainText('Hi Lin');

  // A loop that never yields is stopped instead of hanging the page.
  await alice.getByLabel('File to preview').selectOption('busy.lua');
  await expect(pv.locator('#cx-con')).toContainText('stopped to keep the page responsive', { timeout: 30_000 });
  await alice.getByLabel('File to preview').selectOption('main.lua');

  const dlg = await publish(alice, { title: 'Lua Box' });
  expect(await entryOptions(dlg)).toEqual(['main.lua · Lua', 'busy.lua · Lua']);
  await expect(dlg.locator('.gm-lang')).toHaveText('Lua');
});

// ---------- review fixes ----------

const REACT_VITE = [
  ['index.html', '<!doctype html>\n<html><head><title>Whack React</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n'],
  ['package.json', '{ "name": "whack", "private": true, "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" } }'],
  ['src/main.jsx', "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n"],
  ['src/App.jsx', "import { useState } from 'react';\nimport styles from './App.module.css';\n\nexport default function App() {\n  const [hits, setHits] = useState(0);\n  return <button id=\"whack\" className={styles.mole} onClick={() => setHits(hits + 1)}>Hits: {hits}</button>;\n}\n"],
  ['src/index.css', 'body { background: rgb(1, 2, 3); }\n'],
  ['src/App.module.css', '.mole { color: rgb(0, 200, 0); }\n'],
  // What an AI chat usually answers with: one file that exports a component.
  ['ReactionGame.jsx', "import { useState } from 'react';\n\nexport default function ReactionGame() {\n  const [n, setN] = useState(0);\n  return <button id=\"react-btn\" onClick={() => setN(n + 1)}>Reacted {n}</button>;\n}\n"],
];

test('Vite-style React game: caret versions, CSS imports, a module open in the editor; a component-only JSX file', async ({ users }) => {
  test.setTimeout(240_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Whack', 'Blank');
  await importZip(alice, REACT_VITE);
  await openFile(alice, 'src/App.jsx');

  // The open module runs through the page that loads it, with one React and its CSS.
  const pv = await openPreview(alice);
  await expect(alice.locator('.sbx-entry')).toContainText('Auto: index.html');
  await expect(pv.locator('#whack')).toHaveText('Hits: 0', { timeout: 60_000 });
  await pv.locator('#whack').click();
  await expect(pv.locator('#whack')).toHaveText('Hits: 1');
  await expect(pv.locator('#whack')).toHaveCSS('color', 'rgb(0, 200, 0)');
  await expect(pv.locator('body')).toHaveCSS('background-color', 'rgb(1, 2, 3)');

  // A JSX file that only exports a component is mounted (React 19 when nothing pins a version).
  await openFile(alice, 'ReactionGame.jsx');
  await expect(alice.locator('.sbx-entry')).toContainText('Auto: ReactionGame.jsx');
  await expect(pv.locator('#react-btn')).toHaveText('Reacted 0', { timeout: 60_000 });
  await pv.locator('#react-btn').click();
  await expect(pv.locator('#react-btn')).toHaveText('Reacted 1');
  await alice.getByRole('button', { name: 'Close preview' }).click();

  // Publish: the page is the default for a module, and modules are not offered as entries.
  await openFile(alice, 'src/main.jsx');
  const dlg = await publish(alice, {});
  expect(await entryOptions(dlg)).toEqual(['index.html · HTML page', 'ReactionGame.jsx · JSX']);
  await expect(dlg.getByLabel('Entry file')).toHaveValue('index.html');
  await expect(dlg.getByLabel('Title')).toHaveValue('Whack React');
  await confirmPublish(dlg);
  const game = await playInArcade(alice, 'Whack React');
  await expect(game.locator('#whack')).toHaveText('Hits: 0', { timeout: 60_000 });
  await game.locator('#whack').click();
  await expect(game.locator('#whack')).toHaveText('Hits: 1');
  await expect(alice.locator('.gm-issues')).toHaveCount(0);
});

const TYPE_RUSH = [
  ['index.html', `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Type Rush</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-white p-4">
  <h1 id="title" class="text-pink-500 text-3xl font-bold">Type Rush</h1>
  <p>Type <b>sakura</b> and press Enter.</p>
  <input id="answer" class="border p-2" autocomplete="off">
  <p id="score">Score: 0</p>
  <p id="net"></p>
  <script>
    const $ = (id) => document.getElementById(id);
    // WebRTC and nested frames are not available to games.
    $('net').textContent = 'rtc:' + typeof RTCPeerConnection;
    addEventListener('message', (e) => { if (e.data === 'child ran') $('net').textContent += ' child'; });
    const f = document.createElement('iframe');
    f.srcdoc = '<script>parent.postMessage("child ran", "*")<' + '/script>';
    document.body.appendChild(f);
    let score = 0;
    const a = $('answer');
    a.focus();
    a.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (a.value.trim() === 'sakura') $('score').textContent = 'Score: ' + ++score;
      a.value = '';
    });
  </script>
</body>
</html>
`],
];

test('AI-style page: Tailwind Play CDN, a field the game focuses itself, no WebRTC or nested frames; dialog focus', async ({ users }) => {
  test.setTimeout(180_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Type Rush', 'Blank');
  await importZip(alice, TYPE_RUSH);
  await openFile(alice, 'index.html');

  const pv = await openPreview(alice);
  await expect(pv.locator('#net')).toHaveText('rtc:undefined', { timeout: 30_000 });
  // Tailwind styles apply (pink, not the default black) and nothing is reported as blocked.
  await expect.poll(() => pv.locator('#title').evaluate((el) => getComputedStyle(el).color), { timeout: 30_000 }).not.toBe('rgb(0, 0, 0)');
  await expect(alice.locator('.sbx-banner.warn')).toHaveCount(0);
  await expect(pv.locator('iframe')).toHaveCount(0);
  await alice.waitForTimeout(500);
  await expect(pv.locator('#net')).toHaveText('rtc:undefined');
  await alice.getByRole('button', { name: 'Close preview' }).click();

  // The publish dialog takes keyboard focus, keeps Tab inside, and gives it back on close.
  const publishBtn = alice.getByRole('button', { name: 'Publish game' });
  await publishBtn.focus();
  await alice.keyboard.press('Enter');
  const dlg = alice.getByRole('dialog', { name: 'Publish game' });
  await expect(dlg.getByLabel('Entry file')).toBeVisible({ timeout: 30_000 });
  const inDialog = () => alice.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Publish game"]'));
  await expect.poll(() => alice.evaluate(() => document.activeElement?.tagName)).toBe('SELECT');
  for (let i = 0; i < 14; i++) {
    await alice.keyboard.press('Tab');
    expect(await inDialog()).toBe(true);
  }
  await alice.keyboard.press('Shift+Tab');
  expect(await inDialog()).toBe(true);
  await alice.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(publishBtn).toBeFocused();

  const dlg2 = await publish(alice, {});
  await confirmPublish(dlg2);

  // In the Arcade, typing goes to the game's field without clicking it first.
  const game = await playInArcade(alice, 'Type Rush');
  await expect(game.locator('#net')).toHaveText('rtc:undefined', { timeout: 30_000 });
  await expect.poll(() => activeTitle(alice)).toBe('Game: Type Rush');
  await expect.poll(() => game.locator('#answer').evaluate((el) => document.activeElement === el)).toBe(true);
  await alice.keyboard.type('sakura');
  await alice.keyboard.press('Enter');
  await expect(game.locator('#score')).toHaveText('Score: 1');
  // Closing the player returns focus to its Play button.
  await alice.getByRole('button', { name: 'Close player' }).click();
  await expect(alice.getByRole('button', { name: 'Play Type Rush' })).toBeFocused();
});

test('Python: files the game writes persist in the Arcade; turtle.distance() takes another turtle', async ({ users }) => {
  test.setTimeout(300_000);
  const alice = await users('alice');
  await routeCdn(alice);
  await newCodespace(alice, 'Py Save', 'Blank');
  await importZip(alice, [
    ['main.py', `import os
import turtle

best = open("best.txt").read().strip() if os.path.exists("best.txt") else "none yet"
print("best so far:", best)
runs = int(best) + 1 if best.isdigit() else 1
with open("best.txt", "w") as f:
    f.write(str(runs))

player = turtle.Turtle()
target = turtle.Turtle()
target.penup()
target.goto(30, 40)
print("distance", player.distance(target), "heading", round(player.towards(target), 2))
`],
  ]);
  await openFile(alice, 'main.py');
  const pv = await openPreview(alice);
  await expect(pv.locator('#cx-con')).toContainText('distance 50.0 heading 53.13', { timeout: 90_000 });
  await expect(pv.locator('#cx-con')).toContainText('best so far: none yet');
  await alice.getByRole('button', { name: 'Close preview' }).click();

  const dlg = await publish(alice, { title: 'Py Save' });
  await confirmPublish(dlg);
  let game = await playInArcade(alice, 'Py Save');
  await expect(game.locator('#cx-con')).toContainText('best so far: none yet', { timeout: 90_000 });
  await expect(game.locator('#cx-con')).toContainText('distance 50.0');
  await alice.waitForTimeout(500);
  await alice.getByRole('button', { name: 'Restart' }).first().click();
  game = alice.frameLocator('iframe[title="Game: Py Save"]');
  await expect(game.locator('#cx-con')).toContainText('best so far: 1', { timeout: 90_000 });
  await alice.waitForTimeout(500);
  await alice.getByRole('button', { name: 'Restart' }).first().click();
  game = alice.frameLocator('iframe[title="Game: Py Save"]');
  await expect(game.locator('#cx-con')).toContainText('best so far: 2', { timeout: 90_000 });
});

// Game A writes its localStorage all the time; game B shows what it finds in its own.
const SWITCH_CODE = {
  A: '<script>let n = 0; setInterval(() => localStorage.setItem("owned", "written-by-game-A-" + ++n), 5);</script>A',
  B: '<body><script>document.body.append("B sees: " + localStorage.getItem("owned"))</script>',
};

test('saved data stays with its game when the player switches games while one is running', async ({ page }) => {
  // The real SandboxFrame and saved-game storage, in a parent shaped like the Arcade player
  // (tests/e2e/harness/frameSwitch.jsx, served by the dev server).
  await page.goto('/');
  const peekB = () => page.evaluate(() => window.__h.peek('B'));
  await page.evaluate(async (code) => {
    const m = await import('/tests/e2e/harness/frameSwitch.jsx');
    window.__h = m.mount(code, 'A');
  }, SWITCH_CODE);
  const frame = page.frameLocator('iframe[title="harness game"]');
  await expect(frame.locator('body')).toHaveText('A', { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect((await peekB()).local).toEqual({});
  // Switch to B while A writes; A's last flushes (and its unload grace) must not land in B's save.
  await page.evaluate(() => window.__h.open('B'));
  await expect(frame.locator('body')).toHaveText('B sees: null', { timeout: 30_000 });
  await page.waitForTimeout(2000);
  expect((await peekB()).local).toEqual({});
  expect((await page.evaluate(() => window.__h.peek('A'))).local.owned).toMatch(/^written-by-game-A-\d+$/);
  // A fresh start of B reads only B's own data.
  await page.evaluate(() => { window.__h.unmount(); });
  await page.evaluate(async (code) => {
    const m = await import('/tests/e2e/harness/frameSwitch.jsx');
    window.__h = m.mount(code, 'B');
  }, SWITCH_CODE);
  await expect(page.frameLocator('iframe[title="harness game"]').locator('body')).toHaveText('B sees: null', { timeout: 30_000 });
});

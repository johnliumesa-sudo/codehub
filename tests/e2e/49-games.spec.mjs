// Games, live preview and chat Run in the play sandbox: templates, a multi-file ES module game with a
// CDN library, an npm import, JSON data, localStorage and dialogs, published and played in the Arcade
// (saved data survives Restart and a reload), non-Latin titles, keyboard focus, and a long HTML game
// pasted into chat. CDN requests are served from a local cache (page.route), never the network,
// once the cache is filled (CODEHUB_CDN_CACHE, default <tmp>/codehub-cdn-cache).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, createServer } from './fixtures.mjs';
import { makeZip } from '../../src/lib/zip.js';

const CDN_CACHE = process.env.CODEHUB_CDN_CACHE || join(tmpdir(), 'codehub-cdn-cache');
const CDN_FILES = {
  'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js': 'text/javascript',
  'https://cdn.jsdelivr.net/npm/nanoid@5.0.7/+esm': 'text/javascript',
  'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js': 'text/javascript',
};
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
    if (!CDN_FILES[url]) return route.abort();
    return route.fulfill({ status: 200, body: await cdnBody(url), contentType: CDN_FILES[url], headers: { 'access-control-allow-origin': '*' } });
  });
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

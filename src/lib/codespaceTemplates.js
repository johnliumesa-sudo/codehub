// Starter templates for new codespaces (F8) and for empty channel workspaces.
//
// Rules for template content:
//  - no external URLs in the code (no CDNs, fonts, images or fetches), so every template works in
//    the preview sandbox and as a public game as-is. The Python template's runtime (Pyodide and
//    pygame-ce) is loaded by Codehub's game page from the pinned jsDelivr path, not by the code;
//  - HTML references sibling files with relative <link href> / <script src>, which the preview
//    bundler inlines;
//  - each file is far below the 900 KB per-file seed limit.
// The chosen template id is stored in plaintext at codespaces/{csid}/meta/template (documented).

const WEB_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web starter</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main class="card">
      <h1>Hello, Codehub 👋</h1>
      <p>Edit <code>index.html</code>, <code>style.css</code> and <code>main.js</code> together in real time.</p>
      <button id="counter" type="button">Clicked 0 times</button>
      <ul id="log" aria-live="polite"></ul>
    </main>
    <script src="main.js"></script>
  </body>
</html>
`;

const WEB_STYLE = `:root {
  --bg: #0f1218;
  --card: #181d27;
  --text: #e6e9f0;
  --dim: #9aa3b5;
  --accent: #5b8cff;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}

.card {
  width: min(520px, 92vw);
  padding: 28px;
  border-radius: 14px;
  background: var(--card);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
}

h1 { margin: 0 0 8px; font-size: 26px; }
p { color: var(--dim); }
code { color: var(--accent); }

button {
  padding: 10px 16px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button:hover { filter: brightness(1.1); }

#log { padding-left: 18px; color: var(--dim); font-size: 14px; }
`;

const WEB_MAIN = `// Runs in the live preview. Open the Console panel to see the logs.
const button = document.getElementById('counter');
const log = document.getElementById('log');
let clicks = 0;

button.addEventListener('click', () => {
  clicks += 1;
  button.textContent = \`Clicked \${clicks} time\${clicks === 1 ? '' : 's'}\`;
  const item = document.createElement('li');
  item.textContent = \`Click #\${clicks} at \${new Date().toLocaleTimeString()}\`;
  log.prepend(item);
  console.log('clicked', clicks);
});

console.info('Web starter ready');
`;

const WEB_README = `# Web starter

A tiny vanilla HTML/CSS/JS page.

- \`index.html\` – markup
- \`style.css\` – styles
- \`main.js\` – behaviour

Open **Preview** to run it. Everything is end-to-end encrypted while you edit together.
`;

const CANVAS_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Star Dodger</title>
    <style>
      html, body { margin: 0; height: 100%; background: #07090e; color: #e6e9f0; font-family: system-ui, sans-serif; }
      body { display: grid; place-items: center; }
      canvas { display: block; max-width: 100vw; max-height: 100vh; border-radius: 10px; background: #0d1119; outline: none; }
      .hint { position: fixed; bottom: 10px; left: 0; right: 0; text-align: center; color: #6b7487; font-size: 13px; }
    </style>
  </head>
  <body>
    <canvas id="game" width="640" height="480" tabindex="0" aria-label="Star Dodger game"></canvas>
    <div class="hint">← → / A D to move · Space to start · P to pause</div>
    <script src="game.js"></script>
  </body>
</html>
`;

const CANVAS_GAME = `// Star Dodger: steer the ship, dodge the falling rocks, grab the stars.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

const keys = new Set();
const state = {
  mode: 'title', // 'title' | 'play' | 'paused' | 'over'
  ship: { x: W / 2, y: H - 50, w: 34, h: 28, speed: 360 },
  rocks: [],
  stars: [],
  particles: [],
  score: 0,
  best: 0,
  time: 0,
  spawnRock: 0,
  spawnStar: 0,
};

try {
  state.best = Number(localStorage.getItem('star-dodger-best')) || 0;
} catch {
  state.best = 0;
}

const rand = (a, b) => a + Math.random() * (b - a);

function reset() {
  state.ship.x = W / 2;
  state.rocks = [];
  state.stars = [];
  state.particles = [];
  state.score = 0;
  state.time = 0;
  state.spawnRock = 0;
  state.spawnStar = 1.5;
  state.mode = 'play';
}

function burst(x, y, color, n = 18) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(40, 220);
    state.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.4, 0.9), color });
  }
}

function hit(a, b) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
}

function update(dt) {
  for (const p of state.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
  }
  state.particles = state.particles.filter((p) => p.life > 0);
  if (state.mode !== 'play') return;

  state.time += dt;
  const ship = state.ship;
  const dir = (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('a') ? 1 : 0);
  ship.x = Math.max(ship.w / 2, Math.min(W - ship.w / 2, ship.x + dir * ship.speed * dt));

  const difficulty = 1 + state.time / 20;
  state.spawnRock -= dt;
  if (state.spawnRock <= 0) {
    const size = rand(18, 42);
    state.rocks.push({ x: rand(size, W - size), y: -size, w: size, h: size, vy: rand(120, 200) * difficulty, spin: rand(-3, 3), a: 0 });
    state.spawnRock = rand(0.25, 0.7) / difficulty;
  }
  state.spawnStar -= dt;
  if (state.spawnStar <= 0) {
    state.stars.push({ x: rand(20, W - 20), y: -20, w: 18, h: 18, vy: 140 });
    state.spawnStar = rand(1.5, 3);
  }

  for (const r of state.rocks) {
    r.y += r.vy * dt;
    r.a += r.spin * dt;
  }
  for (const s of state.stars) s.y += s.vy * dt;

  for (const s of state.stars) {
    if (!s.taken && hit(s, ship)) {
      s.taken = true;
      state.score += 50;
      burst(s.x, s.y, '#f5c542', 12);
    }
  }
  for (const r of state.rocks) {
    if (hit({ ...r, w: r.w * 0.8, h: r.h * 0.8 }, ship)) {
      burst(ship.x, ship.y, '#ff5c7a', 40);
      state.mode = 'over';
      state.best = Math.max(state.best, Math.floor(state.score));
      try {
        localStorage.setItem('star-dodger-best', String(state.best));
      } catch {
        /* storage unavailable in some sandboxes */
      }
      return;
    }
  }
  state.rocks = state.rocks.filter((r) => r.y < H + 60);
  state.stars = state.stars.filter((s) => s.y < H + 30 && !s.taken);
  state.score += dt * 10;
}

function drawShip(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#5b8cff';
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(16, 14);
  ctx.lineTo(0, 7);
  ctx.lineTo(-16, 14);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ff8f4d';
  ctx.beginPath();
  ctx.moveTo(-6, 11);
  ctx.lineTo(0, 18 + Math.random() * 8);
  ctx.lineTo(6, 11);
  ctx.fill();
  ctx.restore();
}

function drawStar(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 ? r / 2.2 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function text(str, y, size = 20, color = '#e6e9f0') {
  ctx.fillStyle = color;
  ctx.font = \`600 \${size}px system-ui, sans-serif\`;
  ctx.textAlign = 'center';
  ctx.fillText(str, W / 2, y);
}

function draw() {
  ctx.fillStyle = '#0d1119';
  ctx.fillRect(0, 0, W, H);
  // parallax dots
  ctx.fillStyle = '#1d2433';
  for (let i = 0; i < 40; i++) {
    const y = (i * 53 + state.time * (20 + (i % 3) * 25)) % H;
    ctx.fillRect((i * 97) % W, y, 2, 2);
  }

  ctx.fillStyle = '#f5c542';
  for (const s of state.stars) drawStar(s.x, s.y, 10);

  for (const r of state.rocks) {
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(r.a);
    ctx.fillStyle = '#8892a6';
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = (Math.PI * 2 * i) / 7;
      const rr = (r.w / 2) * (0.8 + ((i * 37) % 5) / 20);
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  for (const p of state.particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  }
  ctx.globalAlpha = 1;

  if (state.mode !== 'over') drawShip(state.ship.x, state.ship.y);

  ctx.fillStyle = '#9aa3b5';
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(\`Score \${Math.floor(state.score)}\`, 14, 26);
  ctx.textAlign = 'right';
  ctx.fillText(\`Best \${state.best}\`, W - 14, 26);

  if (state.mode === 'title') {
    text('STAR DODGER', H / 2 - 20, 40);
    text('Press Space to start', H / 2 + 24, 18, '#9aa3b5');
  } else if (state.mode === 'paused') {
    text('Paused', H / 2, 32);
  } else if (state.mode === 'over') {
    text('Game over', H / 2 - 20, 36, '#ff5c7a');
    text(\`Score \${Math.floor(state.score)} — Space to retry\`, H / 2 + 22, 18, '#9aa3b5');
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  keys.add(k);
  if (k === ' ' && (state.mode === 'title' || state.mode === 'over')) reset();
  else if (k === 'p' && state.mode === 'play') state.mode = 'paused';
  else if (k === 'p' && state.mode === 'paused') state.mode = 'play';
});
window.addEventListener('keyup', (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
window.addEventListener('blur', () => {
  keys.clear();
  if (state.mode === 'play') state.mode = 'paused';
});

canvas.focus();
requestAnimationFrame(frame);
`;

const SNAKE_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Snake</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>Snake</h1>
        <div class="scores"><span id="score">0</span> · best <span id="best">0</span></div>
      </header>
      <canvas id="board" width="400" height="400" tabindex="0" aria-label="Snake board"></canvas>
      <p class="hint">Arrows / WASD to steer · Space to start or pause</p>
    </div>
    <script src="snake.js"></script>
  </body>
</html>
`;

const SNAKE_STYLE = `* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  display: grid;
  place-items: center;
  background: #0b0d12;
  color: #e6e9f0;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
header { width: 400px; max-width: 92vw; display: flex; align-items: baseline; justify-content: space-between; }
h1 { margin: 0; font-size: 22px; letter-spacing: 0.04em; }
.scores { color: #9aa3b5; font-variant-numeric: tabular-nums; }
#score { color: #3ccf91; font-weight: 700; }
canvas {
  width: 400px;
  max-width: 92vw;
  aspect-ratio: 1;
  border-radius: 10px;
  background: #11141b;
  box-shadow: 0 0 0 1px #262d3d;
  outline: none;
}
.hint { margin: 0; color: #6b7487; font-size: 13px; }
`;

const SNAKE_JS = `// Classic snake on a 20x20 grid.
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');

const N = 20;
const CELL = canvas.width / N;
const DIRS = {
  ArrowUp: [0, -1], w: [0, -1],
  ArrowDown: [0, 1], s: [0, 1],
  ArrowLeft: [-1, 0], a: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0],
};

let snake;
let dir;
let queued;
let food;
let score;
let best = 0;
let running = false;
let over = false;
let stepMs;
let acc = 0;
let last = performance.now();

try {
  best = Number(localStorage.getItem('snake-best')) || 0;
} catch {
  best = 0;
}
bestEl.textContent = best;

function placeFood() {
  const free = [];
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) if (!snake.some((p) => p.x === x && p.y === y)) free.push({ x, y });
  }
  food = free[Math.floor(Math.random() * free.length)] || null;
}

function reset() {
  snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
  dir = [1, 0];
  queued = [];
  score = 0;
  stepMs = 140;
  over = false;
  scoreEl.textContent = '0';
  placeFood();
}

function step() {
  if (queued.length) {
    const next = queued.shift();
    if (next[0] !== -dir[0] || next[1] !== -dir[1]) dir = next;
  }
  const head = { x: snake[0].x + dir[0], y: snake[0].y + dir[1] };
  const hitWall = head.x < 0 || head.y < 0 || head.x >= N || head.y >= N;
  const eating = food && head.x === food.x && head.y === food.y;
  const body = eating ? snake : snake.slice(0, -1);
  if (hitWall || body.some((p) => p.x === head.x && p.y === head.y)) {
    running = false;
    over = true;
    if (score > best) {
      best = score;
      bestEl.textContent = best;
      try {
        localStorage.setItem('snake-best', String(best));
      } catch {
        /* storage unavailable */
      }
    }
    return;
  }
  snake.unshift(head);
  if (eating) {
    score += 1;
    scoreEl.textContent = score;
    stepMs = Math.max(60, stepMs - 3);
    placeFood();
  } else {
    snake.pop();
  }
}

function draw() {
  ctx.fillStyle = '#11141b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#161a23';
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) if ((x + y) % 2) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
  }
  if (food) {
    ctx.fillStyle = '#ff5c7a';
    ctx.beginPath();
    ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL * 0.36, 0, Math.PI * 2);
    ctx.fill();
  }
  snake.forEach((p, i) => {
    ctx.fillStyle = i === 0 ? '#3ccf91' : \`hsl(152, 55%, \${Math.max(28, 48 - i)}%)\`;
    ctx.fillRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2);
  });
  if (!running) {
    ctx.fillStyle = 'rgba(11, 13, 18, 0.72)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = over ? '#ff5c7a' : '#e6e9f0';
    ctx.font = '700 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(over ? 'Game over' : 'Snake', canvas.width / 2, canvas.height / 2 - 8);
    ctx.fillStyle = '#9aa3b5';
    ctx.font = '500 15px system-ui, sans-serif';
    ctx.fillText(over ? 'Space to play again' : 'Space to start', canvas.width / 2, canvas.height / 2 + 22);
  }
}

function loop(now) {
  const dt = now - last;
  last = now;
  if (running) {
    acc += dt;
    while (acc >= stepMs && running) {
      acc -= stepMs;
      step();
    }
  }
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (DIRS[k]) {
    e.preventDefault();
    if (queued.length < 3) queued.push(DIRS[k]);
    if (!running && !over) running = true;
  } else if (k === ' ') {
    e.preventDefault();
    if (over) {
      reset();
      running = true;
    } else {
      running = !running;
    }
    acc = 0;
  }
});
window.addEventListener('blur', () => {
  running = false;
});

reset();
canvas.focus();
requestAnimationFrame(loop);
`;

const NOTES_README = `# Notes

A shared, end-to-end encrypted notebook. Everyone in this codespace edits the same files live.

## Structure

- \`notes/ideas.md\` – brainstorming
- \`notes/todo.md\` – a checklist
- \`notes/meeting.md\` – meeting notes template

## Markdown cheat sheet

| You type            | You get        |
| ------------------- | -------------- |
| \`**bold**\`          | **bold**       |
| \`_italic_\`          | _italic_       |
| \`\` \`code\` \`\`        | \`code\`         |
| \`- [ ] task\`        | a checkbox     |
| \`> quote\`           | a block quote  |

Open **Preview** on any \`.md\` file to see it rendered.
`;

const NOTES_IDEAS = `# Ideas

> Drop anything here. Sort it out later.

-
`;

const NOTES_TODO = `# To do

## This week
- [ ]
- [ ]

## Later
- [ ]

## Done
- [x] Create a notes codespace
`;

const NOTES_MEETING = `# Meeting — YYYY-MM-DD

**Attendees:**

## Agenda
1.

## Notes


## Decisions
-

## Action items
- [ ] who — what — by when
`;

const PY_GAME_MAIN = `"""Coin Rush: catch the coins, dodge the rocks.

Arrow keys (or A and D) move the basket. Space starts a new round.
This is real Python with pygame-ce, running in your browser.
"""
import random

import pygame
from js import localStorage  # the game's saved data (kept per game in the Arcade)

from things import Falling

WIDTH, HEIGHT = 480, 360
GOLD, ROCK, SKY, INK = (255, 200, 40), (140, 150, 170), (18, 24, 40), (235, 240, 250)

pygame.init()
screen = pygame.display.set_mode((WIDTH, HEIGHT))
pygame.display.set_caption("Coin Rush")
clock = pygame.time.Clock()
font = pygame.font.Font(None, 28)
big = pygame.font.Font(None, 56)

basket = pygame.Rect(WIDTH // 2 - 30, HEIGHT - 28, 60, 14)
held = set()
items = []
score, lives, ticks, over = 0, 3, 0, False
best = int(localStorage.getItem("coin-rush-best") or 0)
print("Coin Rush! Best score so far:", best)

running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
        elif event.type == pygame.KEYDOWN:
            held.add(event.key)
            if over and event.key in (pygame.K_SPACE, pygame.K_RETURN):
                score, lives, over, items = 0, 3, False, []
        elif event.type == pygame.KEYUP:
            held.discard(event.key)

    if not over:
        right = pygame.K_RIGHT in held or pygame.K_d in held
        left = pygame.K_LEFT in held or pygame.K_a in held
        basket.x = max(0, min(WIDTH - basket.width, basket.x + (right - left) * 7))
        ticks += 1
        if ticks % 28 == 0:
            items.append(Falling(random.randint(8, WIDTH - 8), "coin", 2.2 + score / 30))
        if ticks % 70 == 0:
            items.append(Falling(random.randint(8, WIDTH - 8), "rock", 2.8 + score / 25))
        for item in items[:]:
            item.fall()
            if item.rect().colliderect(basket):
                items.remove(item)
                if item.kind == "coin":
                    score += 1
                else:
                    lives -= 1
                    if lives == 0:
                        over = True
                        if score > best:
                            best = score
                            localStorage.setItem("coin-rush-best", str(best))
                        print(f"Game over: {score} coins (best {best})")
            elif item.y > HEIGHT + 20:
                items.remove(item)

    screen.fill(SKY)
    for item in items:
        pygame.draw.circle(screen, GOLD if item.kind == "coin" else ROCK, (int(item.x), int(item.y)), item.size)
    pygame.draw.rect(screen, INK, basket, border_radius=6)
    screen.blit(font.render(f"Coins {score}   Lives {lives}   Best {best}", True, INK), (12, 10))
    if over:
        text = big.render("Game over", True, GOLD)
        screen.blit(text, text.get_rect(center=(WIDTH // 2, HEIGHT // 2 - 16)))
        hint = font.render("Press Space to play again", True, INK)
        screen.blit(hint, hint.get_rect(center=(WIDTH // 2, HEIGHT // 2 + 24)))
    pygame.display.flip()
    clock.tick(60)

pygame.quit()
`;

const PY_GAME_THINGS = `"""Things that fall from the sky."""
import pygame


class Falling:
    def __init__(self, x, kind, speed):
        self.x, self.y = float(x), -10.0
        self.kind = kind
        self.speed = speed
        self.size = 9 if kind == "coin" else 12

    def fall(self):
        self.y += self.speed

    def rect(self):
        return pygame.Rect(int(self.x - self.size), int(self.y - self.size), self.size * 2, self.size * 2)
`;

const PY_GAME_README = `# Python game

**Coin Rush**, written in Python with [pygame-ce](https://pyga.me/). It runs in your browser on Pyodide
(CPython compiled to WebAssembly).

- \`main.py\` is the entry: open it and press **Preview**, or **Publish game** to put it in the Arcade.
- \`things.py\` is imported by \`main.py\`: split your game into as many \`.py\` files as you like.
- \`print()\` shows up under the game, and \`input()\` asks in a text box.
- The standard library and Pyodide's packages (pygame-ce, numpy …) are available; pip is not.
- The first run downloads Python (about 6 MB, plus 1.5 MB for pygame) and is cached after that.
`;

const TS_GAME_MAIN = `// Brick Breaker in TypeScript. Codehub compiles each .ts file in your browser and runs main.ts
// on a page with a <canvas id="game">.
import { Game, HEIGHT, WIDTH } from './game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const game = new Game(Number(localStorage.getItem('brick-best')) || 0);

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  if (game.best > Number(localStorage.getItem('brick-best') || 0)) localStorage.setItem('brick-best', String(game.best));
  game.draw(ctx);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
`;

const TS_GAME_GAME = `import { State, type Ball, type Brick, type Rect } from './types';
import { isDown, takePressed } from './input';

export const WIDTH = 480;
export const HEIGHT = 320;
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7'];
const SPEED = 260;

const hits = (b: Ball, r: Rect): boolean => b.x + b.r > r.x && b.x - b.r < r.x + r.w && b.y + b.r > r.y && b.y - b.r < r.y + r.h;

export class Game {
  state = State.Ready;
  score = 0;
  lives = 3;
  paddle: Rect = { x: WIDTH / 2 - 40, y: HEIGHT - 22, w: 80, h: 10 };
  ball: Ball = { x: 0, y: 0, r: 6, vx: 0, vy: 0 };
  bricks: Brick[] = [];

  constructor(public best: number) {
    this.reset();
  }

  reset(): void {
    this.score = 0;
    this.lives = 3;
    this.bricks = [];
    for (let row = 0; row < COLORS.length; row++) {
      for (let col = 0; col < 8; col++) {
        this.bricks.push({ x: 16 + col * 56, y: 40 + row * 20, w: 52, h: 14, color: COLORS[row] });
      }
    }
    this.serve();
  }

  private serve(): void {
    this.state = State.Ready;
    this.ball = { ...this.ball, vx: 0, vy: 0 };
  }

  update(dt: number): void {
    for (const key of takePressed()) {
      if (key !== ' ' && key !== 'Enter') continue;
      if (this.state === State.Ready) {
        this.state = State.Playing;
        this.ball.vx = SPEED * (Math.random() < 0.5 ? -0.6 : 0.6);
        this.ball.vy = -SPEED;
      } else if (this.state !== State.Playing) this.reset();
    }
    const dir = Number(isDown('ArrowRight', 'd')) - Number(isDown('ArrowLeft', 'a'));
    this.paddle.x = Math.max(0, Math.min(WIDTH - this.paddle.w, this.paddle.x + dir * 380 * dt));

    const b = this.ball;
    if (this.state === State.Ready) {
      b.x = this.paddle.x + this.paddle.w / 2;
      b.y = this.paddle.y - b.r - 1;
      return;
    }
    if (this.state !== State.Playing) return;

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < b.r || b.x > WIDTH - b.r) b.vx = -b.vx;
    if (b.y < b.r) b.vy = Math.abs(b.vy);
    if (b.vy > 0 && hits(b, this.paddle)) {
      const offset = (b.x - (this.paddle.x + this.paddle.w / 2)) / (this.paddle.w / 2);
      b.vx = SPEED * offset * 1.2;
      b.vy = -Math.abs(b.vy);
    }
    const hit = this.bricks.findIndex((brick) => hits(b, brick));
    if (hit >= 0) {
      this.bricks.splice(hit, 1);
      b.vy = -b.vy;
      this.score += 10;
      this.best = Math.max(this.best, this.score);
      if (this.bricks.length === 0) this.state = State.Won;
    }
    if (b.y > HEIGHT + b.r) {
      this.lives -= 1;
      if (this.lives > 0) this.serve();
      else this.state = State.Lost;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#121826';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    for (const brick of this.bricks) {
      ctx.fillStyle = brick.color;
      ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
    }
    ctx.fillStyle = '#e8ecf4';
    ctx.fillRect(this.paddle.x, this.paddle.y, this.paddle.w, this.paddle.h);
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, this.ball.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(\`Score \${this.score}   Lives \${this.lives}   Best \${this.best}\`, 12, 22);
    if (this.state) {
      ctx.textAlign = 'center';
      ctx.font = '600 18px system-ui, sans-serif';
      ctx.fillText(this.state, WIDTH / 2, HEIGHT / 2 + 40);
    }
  }
}
`;

const TS_GAME_INPUT = `// Keyboard state: which keys are held, and which were pressed since the last frame.
const held = new Set<string>();
let pressed: string[] = [];

addEventListener('keydown', (e: KeyboardEvent) => {
  if (!held.has(e.key)) pressed.push(e.key);
  held.add(e.key);
});
addEventListener('keyup', (e: KeyboardEvent) => held.delete(e.key));
addEventListener('blur', () => held.clear());

export const isDown = (...keys: string[]): boolean => keys.some((k) => held.has(k));

export function takePressed(): string[] {
  const list = pressed;
  pressed = [];
  return list;
}
`;

const TS_GAME_TYPES = `export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Ball {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
}

export interface Brick extends Rect {
  color: string;
}

export enum State {
  Ready = 'Press Space to launch',
  Playing = '',
  Won = 'You cleared it! Space to play again',
  Lost = 'Game over. Space to try again',
}
`;

const TS_GAME_CONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM"],
    "strict": true
  }
}
`;

const TS_GAME_README = `# TypeScript game

**Brick Breaker**, split into typed modules. Codehub compiles TypeScript (also \`.tsx\` and \`.jsx\`) in
your browser with the TypeScript compiler, so there's nothing to install.

- \`main.ts\` is the entry. It runs on a page with a full-size \`<canvas id="game">\` and an on-screen console.
- \`game.ts\`, \`input.ts\` and \`types.ts\` are modules it imports (\`import { Game } from './game'\`).
- npm packages work too: \`import confetti from 'canvas-confetti'\` loads it from jsDelivr. Pin versions in a
  \`package.json\` (\`"dependencies": { "canvas-confetti": "1.9.3" }\`).
- Types aren't checked when the game runs; the editor is where you catch type errors.
`;

/** @type {Array<{id:string, name:string, description:string, icon:string, files: Record<string,string>}>} */
export const TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'An empty codespace. Add files as you go.',
    icon: '∅',
    files: {},
  },
  {
    id: 'web-starter',
    name: 'Web starter',
    description: 'index.html, style.css and main.js wired together. Great with live preview.',
    icon: '</>',
    files: {
      'index.html': WEB_INDEX,
      'style.css': WEB_STYLE,
      'main.js': WEB_MAIN,
      'README.md': WEB_README,
    },
  },
  {
    id: 'canvas-game',
    name: 'Canvas game',
    description: 'A playable keyboard-controlled canvas game (Star Dodger). Publish it to the arcade.',
    icon: '★',
    files: {
      'index.html': CANVAS_INDEX,
      'game.js': CANVAS_GAME,
    },
  },
  {
    id: 'snake',
    name: 'Snake',
    description: 'The classic grid snake game in plain JavaScript.',
    icon: '🐍',
    files: {
      'index.html': SNAKE_INDEX,
      'style.css': SNAKE_STYLE,
      'snake.js': SNAKE_JS,
    },
  },
  {
    id: 'python-game',
    name: 'Python game',
    description: 'Coin Rush in Python with pygame-ce, running in your browser. Publish it to the arcade.',
    icon: 'Py',
    files: {
      'main.py': PY_GAME_MAIN,
      'things.py': PY_GAME_THINGS,
      'README.md': PY_GAME_README,
    },
  },
  {
    id: 'typescript-game',
    name: 'TypeScript game',
    description: 'Brick Breaker in typed TypeScript modules, compiled in your browser.',
    icon: 'TS',
    files: {
      'main.ts': TS_GAME_MAIN,
      'game.ts': TS_GAME_GAME,
      'input.ts': TS_GAME_INPUT,
      'types.ts': TS_GAME_TYPES,
      'tsconfig.json': TS_GAME_CONFIG,
      'README.md': TS_GAME_README,
    },
  },
  {
    id: 'markdown-notes',
    name: 'Markdown notes',
    description: 'A shared encrypted notebook: ideas, to-dos and meeting notes.',
    icon: '¶',
    files: {
      'README.md': NOTES_README,
      'notes/ideas.md': NOTES_IDEAS,
      'notes/todo.md': NOTES_TODO,
      'notes/meeting.md': NOTES_MEETING,
    },
  },
];

export const DEFAULT_TEMPLATE_ID = 'blank';

/** Valid ids match the rules regex /^[a-z0-9-]{1,32}$/. */
export const TEMPLATE_ID_RE = /^[a-z0-9-]{1,32}$/;

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

/** Files of a template as [{ path, content }], in a stable order (README last so code opens first). */
export function templateFiles(id) {
  const t = getTemplate(id);
  if (!t) return [];
  return Object.entries(t.files)
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => (a.path === 'README.md') - (b.path === 'README.md') || a.path.localeCompare(b.path));
}

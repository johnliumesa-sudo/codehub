// Starter templates for new codespaces (F8) and for empty channel workspaces.
//
// Rules for template content:
//  - vanilla HTML/CSS/JS only, no external URLs (no CDNs, fonts, images or fetches), so every
//    template works inside the network-less preview sandbox and as a public game as-is;
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

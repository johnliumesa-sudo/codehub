# Games, live preview and chat Run (the "play" sandbox)

Codehub runs other people's code in three places: **Arcade games**, the **live preview** of a workspace
and the **Run** button under code in chat. All three use the same sandboxed iframe with the **play**
CSP and runtime; chat Run uses the **snippet** variant (no fullscreen or pointer lock). Add-ons keep the
older, stricter **strict** profile, unchanged.

Code: `src/lib/sandbox.js` (profiles, `buildSrcdoc`, bundler, preview documents), `src/lib/sandboxPlay.js`
(play CSP, CDN allowlist and rewrites, the in-frame runtime), `src/lib/esmScan.js` (JavaScript import
lexer), `src/lib/gameSaves.js` (saved game data), `src/lib/gameText.js` (titles, publish errors),
`src/components/sandbox/SandboxFrame.jsx`, `src/components/games/*`,
`src/features/messaging/{components/RunCode.jsx,lib/runnable.js}`, and for games in other languages
`src/lib/gameLangs/*` (see "Games in other languages").
Rule bytes used: **90** (the optional `games/{id}/lang`). No new database paths.

## What works now

Before this change most pasted HTML games did not work (see "Why games broke"). A game can now:

- load libraries from **jsDelivr (npm), cdnjs, unpkg** with `<script src>`, import maps or ES `import`
  (Phaser, p5.js, three.js, Kaboom, confetti …), and fonts from **Google Fonts**;
- be split into **ES modules** (`<script type="module" src="main.js">` plus `import './player.js'`),
  import **npm packages by name** (`import confetti from 'canvas-confetti'`; versions from
  `package.json`), import **CSS from modules** (`import './style.css'`, CSS modules, package
  stylesheets, as Vite and CRA projects do), and read **workspace files** with `fetch('levels.json')`, `XMLHttpRequest`,
  `new Image().src = 'ship.svg'`, `script.src`, `new Worker('worker.js')` and CSS `url(bg.svg)`;
- keep a **high score in `localStorage`** (also `sessionStorage` and `document.cookie`). In the Arcade
  it is saved per game on your device, so Restart, a reload and the next visit continue from it;
- call **`alert`, `confirm` and `prompt`** without breaking (see "Dialogs");
- use `eval` / `new Function` / WebAssembly (React with in-browser Babel, Alpine.js, Pyodide);
- go **full screen**, lock the **pointer**, read **gamepads**, and play **audio** after a click;
- use any language in titles, descriptions and the game itself (CJK, Arabic and other RTL scripts,
  emoji).

Tested with 20 typical games (AI-written single files, multi-file projects, both game templates) in
Chromium, Firefox and WebKit. All run, except pointer lock in headless Chromium and WebKit, which
refuse it even outside any sandbox.

## Sandbox profiles

Both profiles render an `<iframe srcdoc>` **without** `allow-same-origin`. The frame gets an opaque
origin: it can't read the Codehub page, your login session, your keys, your messages or Codehub's own
storage. A CSP `<meta>` is the first thing in the document; a policy the game adds can only tighten it.
Neither profile ever gets `allow-same-origin`, `allow-popups`, `allow-top-navigation`, `allow-forms` or
`allow-modals`.

| | strict (add-ons) | play (games, preview) | snippet (chat Run) |
|---|---|---|---|
| `sandbox` | `allow-scripts` | `allow-scripts allow-pointer-lock` | `allow-scripts` |
| `allow` | (empty) | `fullscreen *; gamepad *; autoplay *` | (empty) |
| CSP | strict | play | play |
| network | none | the CDN paths below, `data:`, `blob:` | same as play |
| runtime | none | compatibility runtime (storage, dialogs, error reports, no WebRTC, no nested frames) | same as play |

Chat Run code comes from any chat author (a DM from a stranger included) and runs after one click, so it
gets no fullscreen or pointer lock: it can't cover Codehub with a fake screen.

`*` in `allow` is needed because Firefox and WebKit don't match a `srcdoc` frame against the default
allowlist. The strict profile is byte-for-byte the original one (`tests/unit/games.test.mjs` checks the
exact string). The add-on Worker inherits its `connect-src 'none'`, and a security fix depends on that.

**Strict CSP** (`STRICT_CSP` = `GAME_CSP`):

```
default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'; img-src data: blob:;
font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'
```

**Play CSP** (`PLAY_CSP`):

```
default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: https://cdn.jsdelivr.net/npm/
  https://cdnjs.cloudflare.com/ajax/libs/ https://unpkg.com/ https://cdn.jsdelivr.net/pyodide/;
style-src 'unsafe-inline' blob: data: https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/
  https://unpkg.com/ https://fonts.googleapis.com/css https://fonts.googleapis.com/css2;
img-src data: blob: <the three CDN paths>; font-src data: blob: <the three CDN paths> https://fonts.gstatic.com/s/;
media-src data: blob: <the three CDN paths>; connect-src data: blob: <the three CDN paths> https://cdn.jsdelivr.net/pyodide/;
worker-src blob: data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'
```

### Why these hosts, and only these

The allowlist names **path prefixes on hosts that serve fixed package files and cannot fetch an
arbitrary URL** for the game:

- `cdn.jsdelivr.net/npm/` and `/pyodide/`: npm packages and Pyodide. Not `/gh/` (any GitHub repository
  at a movable ref) and not `/combine/`. Encoded path traversal (`..%2F`) is refused by jsDelivr.
- `cdnjs.cloudflare.com/ajax/libs/`, `unpkg.com/`: npm/cdnjs packages.
- `fonts.googleapis.com/css`, `/css2` and `fonts.gstatic.com/s/`: Google Fonts.
- **Not allowed:** `esm.sh` and Skypack (they build code on their servers, from GitHub or any URL),
  every other host, WebSockets, WebRTC (removed by the runtime, see below).

`eval` and WebAssembly add no capability inside an opaque origin; `'unsafe-inline'` already allowed any
script.

The bundler rewrites well-known URLs that have an exact allowed equivalent, so pasted code keeps working:
`https://esm.sh/pkg@v[/sub]` and `https://cdn.skypack.dev/pkg@v` become
`https://cdn.jsdelivr.net/npm/pkg@v[/sub]/+esm`, and `https://code.jquery.com/jquery-X.Y.Z(.min).js`
becomes the same file on jsDelivr. The Tailwind Play CDN (`https://cdn.tailwindcss.com[/version]`, in most
AI-made pages) becomes the official browser build `@tailwindcss/browser@4.3.5` on jsDelivr (Tailwind v4:
utility classes work; a v3 `tailwind.config = {…}` object is ignored). `http://` URLs on an allowed CDN
become `https://`.

## The compatibility runtime (play profile)

`playRuntimeScript()` is injected right after the CSP (after the console bridge in preview mode), before
any of the game's markup. It is ES5, self-contained, about 6 KB, and serialized from
`sandboxPlay.js`.

### Storage

- `localStorage` and `sessionStorage` are in-memory `Storage` look-alikes. They support `getItem`,
  `setItem`, `removeItem`, `clear`, `key` and `length`, and also named properties
  (`localStorage.best = 3`), `in`, `delete`, `Object.keys` and `JSON.stringify`. A game may use up to
  **512 KB** (`SAVE_MAX_CHARS`, characters of keys plus values) and 5,000 keys; past that,
  `setItem` throws `QuotaExceededError` like a real browser.
- `document.cookie` works as an in-memory jar for the run. It honours `max-age=0` and past `expires`.
- `indexedDB` still throws `SecurityError`, as in any opaque origin. Libraries such as localForage fall
  back to `localStorage`.
- **Arcade only:** every change is posted to the player within 100 ms (coalesced, and again on
  `pagehide`) as `{__sbx: token, kind: 'storage', area, data}`. The player keeps it on this device:
  - `localStorage`: IndexedDB database `codehub-game-saves`, store `saves`, key
    `<uid>/<gameId>`, shape `{ key, uid, gameId, data, chars, at }`;
  - `sessionStorage`: in memory, for this page load.
  The next render of the game (Restart, reopening, a reload) starts with that data.
  - Total budget: 8 M characters and 200 games. The least recently written games are evicted first,
    never the one you're playing.
  - "Clear saved data" in the player deletes one game's data. Deleting your account deletes all of it.
- **Preview, publish test run and chat Run** start empty every run and save nothing.

### Dialogs

Native dialogs stay blocked: `allow-modals` would let a game draw real browser dialogs over Codehub,
for example a fake password prompt. Instead:

| Call | Returns | Shown |
|---|---|---|
| `alert(m)` | immediately | a notice in the game frame (top, 5 s, click to close), and a console line |
| `confirm(m)` | `true` ("OK") | notice "Confirmed automatically (OK)" |
| `prompt(m, d)` | `d`, or `""` without a default | notice with the answer |
| `print()` | nothing | nothing |

Code after the call runs at once, because nothing blocks. A game that pauses on `alert` keeps running
behind the notice, and `prompt` can't ask the player for text. The notice is a `<codehub-notice>`
element with an open shadow root, so the game's CSS doesn't change it.

### Errors and blocked loads

In the Arcade and the publish test run, the runtime posts uncaught errors, unhandled rejections,
`securitypolicyviolation` events and failed `<script>`/`<link>`/`<img>` loads (up to 20 each, deduplicated)
as `{kind: 'error' | 'blocked', message, url?, directive?}`. In the preview and chat Run they go to the
console instead.

### Network the CSP doesn't cover, and focus

- **WebRTC:** ICE (STUN/TURN) traffic isn't governed by `connect-src`, so a peer connection could reach
  any host. The runtime replaces `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`,
  `RTCIceTransport` and `RTCRtpTransceiver` with non-configurable `undefined`.
- **Nested frames:** `frame-src 'none'` doesn't stop a `srcdoc` or `about:blank` frame, which would bring
  a fresh window with its own WebRTC. A `MutationObserver` (also on open shadow roots, through
  `attachShadow`) removes every `iframe`/`frame`/`object`/`embed` before it loads and logs one warning.
  Nested frames couldn't load anything else anyway.
- **Focus:** the runtime remembers the last element the game focused itself (or an `autofocus` element).
  When the frame gets keyboard focus while nothing inside is focused, that element gets it back, so a
  typing game that calls `input.focus()` on load takes typing in the Arcade without a click.

### Hook for runtimes built on top

`window.__codehub` (frozen, non-enumerable): `{ version: 1, persistent, notice(label, text) }`.

## Messages from the frame

`SandboxFrame` creates a fresh random token for every render. It accepts a message only when
`e.source` is **this** frame's window and `data.__sbx` is the token. Strict frames that aren't in preview
(add-ons) still have no listener at all. Payloads are validated by `readRuntimeMessage`: storage
snapshots must be plain objects of strings within the budget, and texts are capped. They are rendered
as React text only.

- **Storage messages:** accepted only when the host passed `storage.save` (the Arcade player). The
  storage is bound to the document's token when it renders: a document's messages (including its
  last flush while it unloads) only ever reach the storage it was rendered with, even if the `storage`
  prop changes. The Arcade also remounts the player per game (`key={gameId}`).
- **Self-reload:** a document that reloads itself (`location.reload()`) would restart from the data
  embedded in its `srcdoc`. The runtime says `hello` with a per-document id. When a second id appears
  for the same token, the frame is re-rendered from the latest saved data, and the old token's messages
  are dropped.

## Bundling a workspace (`bundle(entry, files, opts)`)

Publishing and the preview turn an HTML entry and the workspace's text files into one self-contained
document:

- **Classic scripts and styles:**
  - `<script src>`: inlined (or a `data:` URL for `defer`/`async`).
  - `<link rel=stylesheet>`: inlined, including `@import` of workspace CSS and `url()` of workspace SVGs.
  - `<img src="*.svg">`: a `data:` URL.
  - A `<script src>` whose file uses `import`/`export` runs as a module.
- **ES modules:**
  - Every workspace module reachable through relative imports (static and `import("…")`, `.js`,
    `.mjs`, `.cjs`, `.json`) is embedded.
  - Its specifiers are rewritten to `@codehub-ws/<path>` (found by `esmScan.js`, which skips
    comments, strings, templates and regexes).
  - A boot script at the top of the document makes each module a `blob:` URL and inserts **one**
    import map before the first module runs.
  - The page's own import maps are merged in, and their entries win. A page map with nothing to add
    stays a static `<script type="importmap">`.
- **npm imports:**
  - A bare import (`three`, `canvas-confetti`, `three/addons/…`) maps to
    `https://cdn.jsdelivr.net/npm/<name>@<version>[/sub]/+esm`. The version comes from the root
    `package.json` (`dependencies`, `devDependencies`, `peerDependencies`).
  - A simple range (`^1.2.3`, `~1.2.3`, `>=1.2.3`) becomes the exact version (`exactVersion`): jsDelivr's
    `+esm` builds import their dependencies by exact version, so a range would load a second copy of a
    shared package.
  - `react`, `react-dom` and `react/jsx-runtime` always use **one** exact version (`reactVersion`): the
    exact one from `package.json`, else the last release of the major line named there (16.14.0, 17.0.2,
    18.3.1, 19.3.1), else 19.3.1. The `react-dom` build of that version imports exactly that `react`, so
    hooks work.
  - Another package without a version (or with a URL, git or file version) loads the latest. The publish
    modal lists these as "unpinned".
- **CSS imported from modules:** `import './style.css'` becomes a module that adds a `<style>` (with
  `@import` and SVG `url()` inlined). `x.module.css` also default-exports `{ className: className }`
  (class names stay as written). `import 'pkg/dist/x.css'` becomes a module that adds a `<link>` to the
  file on jsDelivr.
- **Workspace files read at run time:**
  - A text file named by a string literal in the code (`'levels.json'`, resolved against the page)
    is embedded and served to `fetch`, `XMLHttpRequest.open`, `HTMLImageElement.src`,
    `HTMLScriptElement.src` and `Worker`.
  - A folder prefix (`'levels/'`, or the head of `` `levels/${n}.json` ``) embeds the files in that
    folder (up to 100).
  - The workspace holds text only, so there are no binary images or sounds.
- **External references:** reported with whether the play CSP allows them
  (`external: [{url, kind, allowed, from?}]`). The preview shows a banner and the publish modal a
  warning for blocked ones.
- **Options for language runtimes:**
  - `html` renders given markup instead of the entry file.
  - `transform(path, text)` with `moduleExts` (e.g. `['ts', 'tsx', 'jsx']`) compiles other module
    languages. Resolution then also finds `.ts` for `import './a.js'`.

Limits: a published game is ≤ **262,144 characters** after bundling (rules); a preview ≤ 2 MB (client).

## Games in other languages

`src/lib/gameLangs/` turns a workspace and an entry into one play document. The live preview
(`LivePreviewPane`) and the publish modal (`PublishGameModal`) both call `buildGameDoc`, so the preview
is exactly what gets published and what the Arcade plays. The play CSP is unchanged: it already allows
`cdn.jsdelivr.net/npm/` and `/pyodide/`, `eval` and WebAssembly.

| File | Role |
|---|---|
| `langs.js` | Languages (`html`, `js`, `ts`, `py`, `lua`), `entryKind`, `findEntries`, `autoGameEntry`, `needsTranspiler`, unsupported languages and their message. Pure. |
| `index.js` | `buildGameDoc(entry, files, { ts, title })`, `buildGamePreview` (2 MB limit), `gameTitle`. |
| `jsShell.js` | The JS/TS page (`<canvas id="game">`, console) and the `codehub-lang` marker (`langMarker`, `langOfDoc`). |
| `transpile.js` | TypeScript 6.0.3 `transpileModule` per file; `loadTypeScript()` imports it as a lazy chunk. |
| `python.js`, `pyTurtle.js` | The Pyodide page, the Python prelude and the turtle shim. |
| `lua.js` | The wasmoon page and the Lua API. |

### Entries

- Runnable: `.html/.htm/.xhtml`, `.js/.mjs`, `.jsx`, `.ts/.mts`, `.tsx`, `.py`, `.lua` (not `.d.ts`, not under
  `node_modules/` or dot folders).
- A file is offered as an entry unless another file loads it: a page's `<script src>`, a relative
  `import`/`export … from`/`import()` (with the `.js` → `.ts` convention), a Python `import`/`from … import`
  of its module name (`lib/util.py` = `lib.util`; `__init__.py` never), a Lua `require("a.b")` (`a/b.lua`).
  A module an HTML page loads (directly or through imports, `.js`/`.ts`/`.tsx`/`.jsx` alike) is never an
  entry. When every file of a language is imported (a cycle) and no page loads any of them, its
  `main`/`index`/`game` file is offered.
- Order: HTML pages, then TypeScript, JavaScript, Python, Lua; `main`/`index`/`game`/`app` first.
- The preview's "Auto" entry, and the publish modal's default, for a module is the page that loads it,
  else the main entry of its language.
- `.c/.h/.cpp/.cc/.cxx/.hpp/.hh/.rs/.java/.kt/.kts`: never runnable. The publish modal names the languages
  it found and shows `UNSUPPORTED_MESSAGE`; the preview shows it for such a file.

### JavaScript and TypeScript

- Without an HTML page, the entry runs on a generated page: `<canvas id="game" tabindex="0">` sized to the
  frame (until the game sets its own size; then it is centred and scaled down to fit), and an on-screen
  console that shows `console.*` output and uncaught errors (hidden until there is output, closable).
  The canvas hides itself when the game never calls `getContext` on it (a DOM game).
- Plain scripts load as a classic `<script>` (top-level functions stay global, like a `<script src>`);
  files with `import`/`export`, `.mjs` and every TS/JSX file load as ES modules.
- **TypeScript/TSX/JSX** compile per file with `ts.transpileModule` (ES2022, ESNext modules, `isolatedModules`):
  - types are erased, not checked; enums, namespaces, parameter properties, TC39 and (with
    `experimentalDecorators`) legacy decorators work;
  - JSX uses the automatic React runtime (`react/jsx-runtime`, from jsDelivr) unless `tsconfig.json` (or
    `jsconfig.json`, comments allowed) sets `jsx`, `jsxFactory`, `jsxFragmentFactory` or `jsxImportSource`;
  - a syntax error becomes `file:line:col message`, shown in the preview banner and the publish modal, and
    the module throws it;
  - the compiler is about 3.6 MB (1 MB gzipped) and only downloads when a TypeScript/JSX entry (or a page
    that loads a `.ts/.tsx/.jsx` script) is previewed or published. TypeScript 7 is the Go-native compiler
    with no JavaScript API, so 6.0.x is the newest usable version.
- Everything else is `bundle()`: workspace modules, npm imports pinned from `package.json`, data files,
  CSS imports. React loads once whatever the ranges in `package.json` (see "npm imports").
- A `.jsx`/`.tsx` entry that only **exports a component** (`export default`, no `react-dom` import, no
  `createRoot`/`hydrateRoot`, React's JSX) is mounted: the page gets a `<div id="root">` and
  `createRoot(root).render(createElement(Default))`. A default export that isn't a component logs a clear
  error instead.

### Python

- **Runtime:** Pyodide **314.0.7** (CPython 3.14.2) from `https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`
  (`pyodide.js`, then its wasm, standard library and lock file). About 6.1 MB on first load; pygame-ce
  2.5.7 adds 1.5 MB. Ready in about 2.5 s with a warm CDN, 5 to 8 s when the CDN edge is cold.
- **Files:** every `.py` and text data file (`txt json csv tsv md ini cfg toml yaml yml dat xml svg`) is
  embedded as JSON and written to `/home/pyodide/game/`, the working directory; the entry's own folder is
  put first on `sys.path` (like `python path/to/main.py`), and the entry runs with
  `runpy.run_path(entry, run_name='__main__')`.
- **Packages:** `loadPackagesFromImports` loads what the code imports from the Pyodide lock (pygame-ce,
  numpy …). micropip/PyPI are not reachable (`connect-src` doesn't allow them); a `ModuleNotFoundError`
  says so.
- **Console:** stdout and stderr (red) on screen, mirrored line by line to `console.log`/`console.error`
  (so the preview's console shows them too). A status line shows each loading step with the elapsed time.
- **Pausing (JSPI):** `input()` shows a text box and suspends Python until Enter; `time.sleep()`,
  `pygame.time.Clock.tick`, `delay`, `wait`, `display.flip/update` and `event.get` give the browser a frame.
  These use `pyodide.ffi.run_sync` (needs `WebAssembly.Suspending`). Without it, `input()`/`sleep` raise a
  `RuntimeError` that says the browser can't pause Python, and pygame games don't start (a loop would freeze
  the tab).
- **Watchdog:** a `sys.monitoring` JUMP callback (tool id 3) yields a frame when Python ran more than
  50 ms without one, only where `can_run_sync()` is true (not inside JS event callbacks). Tight loops run
  2.7 to 5.5 times slower.
- **Graphics:** a `<canvas id="canvas">` stage appears when the code uses pygame, turtle or a canvas.
  pygame draws on it (`pyodide.canvas.setCanvas2D`); `import turtle` gets a ~200-line canvas turtle
  (`pyTurtle.js`, unless the workspace has its own `turtle.py`); `from js import document` works for DOM
  and canvas games (`create_proxy` for callbacks).
- **Errors:** tracebacks keep only the game's frames (runpy, Pyodide internals and Codehub's prelude are
  dropped) with workspace-relative file names. The summary (`ValueError: … (helpers.py line 7)`) is also
  reported to the Arcade's error panel and the preview console.
- **Files the game writes persist:** after the game's files are written (and before the entry runs), the
  files saved under the `localStorage` key `__codehub_python_files__` are written back. Every second while
  the game runs, and when it ends, new or changed text files in `/home/pyodide/game/` (not `__pycache__`
  or `.pyc`; at most 64 K characters each, 256 K in all, 200 files) are saved under that key. In the
  Arcade that is the game's saved data, so `open('best.txt', 'w')` survives Restart and a reload; the
  preview keeps it for one run.
- `from js import localStorage` reaches the play runtime's storage too.
- The turtle shim's `goto`, `distance` and `towards` take `x, y`, a pair (tuple, list) or another turtle.

### Lua

- wasmoon **1.16.0** (Lua 5.4): `https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm` and `dist/glue.wasm`,
  about 145 KB, ready in 0.1 to 0.2 s.
- Workspace `.lua` and text files are mounted (so `require("util")` works); the entry runs with `loadfile`.
- API: `print`, `input(prompt)`, `sleep(seconds)`, `frame()` (next animation frame, returns dt), `keydown(key)`,
  `now()`, `canvas`, `ctx` (2D context: `ctx:fillRect(…)`, `ctx.fillStyle = "…"`), `document`, `window`.
- A `debug.sethook` count hook stops a loop that ran 4 s without `frame()`, `sleep()` or `input()`.

### Language of a published game

- The document starts with `<meta name="codehub-lang" content="js|ts|py|lua">` (none for HTML). The player
  reads it with `langOfDoc` when the record has no `lang`.
- `games/{id}/lang` (`html|js|ts|py|lua`, validated by a regex; optional) is written with the publish or
  code update. Arcade cards and the player show it as a badge; Python games also show the first-load size.
- **Older rules:** until the owner pastes rules with `lang`, `$other: false` refuses it. `publishGame` and
  `updateGame` then retry the same update once without `lang`, and stop sending it for the rest of the
  session. A refusal that has another cause fails again and is reported as before.

### Templates

- **Python game** (`python-game`): Coin Rush, pygame-ce, `main.py` + `things.py`, best score in
  `localStorage`.
- **TypeScript game** (`typescript-game`): Brick Breaker, `main.ts`, `game.ts`, `input.ts`, `types.ts`,
  `tsconfig.json` (strict); type-checks cleanly.

## Arcade player

- Keyboard focus goes to the game on load, after Restart and after full screen. Tab stays inside the
  player, and closing it returns focus to the game's Play button.
- One player per game (`key={gameId}`): opening another game while one plays (a notification, the
  admin panel) starts a fresh player, and the old game's saved data can't reach the new one.
- When focus is elsewhere (the toolbar, another window), a "Click the game to play with the keyboard"
  pill appears; only the pill takes clicks.
- **Full screen** shows the game stage. Games may also call `requestFullscreen` themselves. Inside full
  screen there's an exit button (touch devices have no Esc).
- **Restart** re-renders the frame and keeps saved data. **Clear saved data** (footer) deletes it.
- **Error panel:** "This game stopped with an error" or "The sandbox blocked part of this game", with
  the messages as text, which hosts are allowed, Restart and Dismiss. A failed code download has its
  own message and "Try again".
- Titles, owner names and descriptions are `dir="auto"`. The cover letter is the first grapheme, so an
  emoji or a CJK character stays whole. The title taken from `<title>` decodes numeric entities and is
  clipped without splitting a character.
- A refused publish says what is likely wrong: the once-a-minute limit, or (when this tab hasn't
  published in the last minute) server rules that are out of date.

## Live preview

- Runs with the play profile in preview mode (console bridge).
- The publish dialog takes keyboard focus (its first field once the files are read), keeps Tab inside,
  and returns focus to **Publish game** when it closes.
- Game entries (any language) are built by `buildGameDoc`; the entry list shows each with its language.
  "Loading the TypeScript compiler…" shows while the lazy chunk loads.
- The first run waits until the other workspace files are decrypted, so a page never starts without
  its scripts.
- A lone `.js` file runs on the game page (canvas and console); one that uses `import`/`export` (or any
  `.mjs`) runs as a module through the bundler.
- Blocked external URLs show in a banner and as console errors.

## Chat

- **Run** under HTML/CSS/JS uses the snippet profile: the play CSP and runtime (CDN libraries, storage,
  dialogs) with `sandbox="allow-scripts"` and `allow=""` (no fullscreen or pointer lock). The button's
  tooltip says it can load public libraries from jsDelivr, cdnjs, unpkg and Google Fonts. The frame is
  380 px tall (300 px on phones).
- A message longer than 4,000 characters that is code goes out as a **code snippet** (≤ 45 KB) when you
  press Enter; the composer says "Sends as a code snippet". The cases:
  - one fenced block, or several in one language: that code;
  - HTML with CSS/JS blocks: merged into one runnable page;
  - an unfenced HTML document: as is.
  - Text outside the fences becomes the caption.

## Security notes

- Nothing changes for add-ons (strict profile, explicit `profile="strict"` in `AddonFrame`).
- **What play frames can reach:**
  - the network only at the pinned CDN paths, `data:` and `blob:` (WebRTC removed);
  - no Codehub data, no other frames (`frame-src 'none'`, and nested `srcdoc` frames removed), no forms,
    no popups;
  - from the parent page, only the validated storage snapshot of the game being played.
- **Residual risks** (documented in the README):
  - A frame can navigate itself to any page. That page still has no access to Codehub.
  - WebRTC is not covered by CSP. Play frames remove it (and nested frames, which would bring it back),
    but a closed declarative shadow root (`<template shadowrootmode="closed">`) can hide a nested frame
    from the observer. Add-ons are not affected (their code runs in a Worker, which has no WebRTC).
  - jsDelivr's public per-file statistics are a slow, aggregate side channel.
  - Running a chat snippet or a game reveals your IP address to the CDNs it loads from.
- Saved game data is the game's own data, kept unencrypted on your device and never uploaded.
- Games in other languages add no capability: they are documents in the same play frame. Pyodide and
  wasmoon come from the pinned jsDelivr paths the CSP already allowed. The generated pages embed workspace
  text as JSON with `<` escaped (`jsonForScript`), so a file can't close the script element. The TypeScript
  compiler runs in the Codehub page but only transforms text; it never executes the game.

## Why games broke (round 3 diagnosis)

1. CDN scripts were blocked: the CSP allowed no `https:` source.
2. `localStorage` threw `SecurityError` in the opaque origin, killing games at start.
3. `alert`/`confirm`/`prompt` were silently ignored (`confirm` returned `false`).
4. Files referenced only from code (`import './x.js'`, `fetch('levels.json')`, `new Image().src`) were
   not bundled; the requests went to the Codehub origin and were blocked.
5. `eval`/`new Function` were blocked.
6. Fullscreen and pointer lock were blocked (`allow=""`).
7. Real-size games didn't fit in a chat message (4,000 characters).

Also fixed: the live preview's first render ran before the other files loaded, a refused publish
always blamed the rate limit, and the Arcade cut emoji titles in half.

## Tests

- `tests/unit/games.test.mjs`:
  - the strict profile equals the original output, and the play CSP and flags;
  - URL allowlist and rewrites, the import lexer, and the bundler (modules, import maps, npm
    pinning, data files, CSS, transform hook);
  - the runtime in a VM (storage semantics, quota, persistence messages, cookies, dialogs) and message
    validation;
  - eviction, title helpers, publish errors, long-paste snippets.
- `tests/e2e/49-games.spec.mjs`:
  - the Canvas game and Snake templates (preview, test run, Arcade);
  - a multi-file module game with a CDN library, an npm import, JSON data, dialogs and a high score
    that survives Restart and a reload;
  - a non-Latin title, focus and full screen, a p5.js preview, and a long HTML game pasted into chat.
  - CDN files are served by `page.route` from a cache (`CODEHUB_CDN_CACHE`, default
    `<tmp>/codehub-cdn-cache`). It is filled from the network on first use (Pyodide, pygame-ce and
    wasmoon included: about 8 MB).
  - Other languages: a multi-file TypeScript/TSX game (enum, namespace, `tsconfig.json` JSX factory) previewed,
    published and played; a JavaScript-only game published under rules without `lang` (the retry, and the
    player's marker fallback); a Python console game (print, `input()`, imports, traceback) published and
    played; the Python game (pygame-ce) and TypeScript game templates; Lua (input, require, canvas, busy-loop
    guard); the C/C++/Rust/Java message.
  - Python's JSPI paths need Chrome 137+. With Playwright's bundled Chromium 130 the tests check the
    "can't pause Python" behaviour; set `CODEHUB_E2E_CHROMIUM` to a newer Chromium/Chrome executable to run
    `input()` and pygame for real.
- Review fixes: `games.test.mjs` (the snippet profile, one React version, CSS imports, the Tailwind
  rewrite, WebRTC and nested-frame removal, focus restore in a VM DOM), `game-langs.test.mjs` (modules of
  a page are never entries, component mounting, the Python file-save hooks, the turtle shim run in
  CPython when `python3` is installed) and `49-games.spec.mjs` (a Vite-style React game with caret
  versions, CSS imports and a module open in the editor, a component-only JSX file, an AI-style page with
  Tailwind, a self-focused field, no WebRTC or nested frames and publish-dialog/player focus, Python files
  and turtle `distance`, and saved data that stays with its game when a notification switches games).
- `tests/unit/game-langs.test.mjs`: entry detection, TypeScript transpiling (and its errors), the JS/TS page,
  Python and Lua documents, the marker, titles, and the two templates (they build; the TypeScript one
  type-checks under `strict`).
- `tests/rules/games-lang.test.mjs`: `games/{id}/lang` accepts the five ids and rejects anything else.

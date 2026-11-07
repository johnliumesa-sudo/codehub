# Games, live preview and chat Run (the "play" sandbox)

Codehub runs other people's code in three places: **Arcade games**, the **live preview** of a workspace
and the **Run** button under code in chat. All three use the same sandboxed iframe with the **play**
profile. Add-ons keep the older, stricter **strict** profile, unchanged.

Code: `src/lib/sandbox.js` (profiles, `buildSrcdoc`, bundler, preview documents), `src/lib/sandboxPlay.js`
(play CSP, CDN allowlist and rewrites, the in-frame runtime), `src/lib/esmScan.js` (JavaScript import
lexer), `src/lib/gameSaves.js` (saved game data), `src/lib/gameText.js` (titles, publish errors),
`src/components/sandbox/SandboxFrame.jsx`, `src/components/games/*`,
`src/features/messaging/{components/RunCode.jsx,lib/runnable.js}`.
Rule bytes used: **0**. No new database paths.

## What works now

Before this change most pasted HTML games did not work (see "Why games broke"). A game can now:

- load libraries from **jsDelivr (npm), cdnjs, unpkg** with `<script src>`, import maps or ES `import`
  (Phaser, p5.js, three.js, Kaboom, confetti …), and fonts from **Google Fonts**;
- be split into **ES modules** (`<script type="module" src="main.js">` plus `import './player.js'`),
  import **npm packages by name** (`import confetti from 'canvas-confetti'`; versions from
  `package.json`), and read **workspace files** with `fetch('levels.json')`, `XMLHttpRequest`,
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

| | strict (add-ons) | play (games, preview, chat Run) |
|---|---|---|
| `sandbox` | `allow-scripts` | `allow-scripts allow-pointer-lock` |
| `allow` | (empty) | `fullscreen *; gamepad *; autoplay *` |
| network | none | the CDN paths below, `data:`, `blob:` |
| runtime | none | compatibility runtime (storage, dialogs, error reports) |

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
  every other host, WebSockets.

`eval` and WebAssembly add no capability inside an opaque origin; `'unsafe-inline'` already allowed any
script.

The bundler rewrites well-known URLs that have an exact allowed equivalent, so pasted code keeps working:
`https://esm.sh/pkg@v[/sub]` and `https://cdn.skypack.dev/pkg@v` become
`https://cdn.jsdelivr.net/npm/pkg@v[/sub]/+esm`, and `https://code.jquery.com/jquery-X.Y.Z(.min).js`
becomes the same file on jsDelivr. `http://` URLs on an allowed CDN become `https://`.

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

### Hook for runtimes built on top

`window.__codehub` (frozen, non-enumerable): `{ version: 1, persistent, notice(label, text) }`.

## Messages from the frame

`SandboxFrame` creates a fresh random token for every render. It accepts a message only when
`e.source` is **this** frame's window and `data.__sbx` is the token. Strict frames that aren't in preview
(add-ons) still have no listener at all. Payloads are validated by `readRuntimeMessage`: storage
snapshots must be plain objects of strings within the budget, and texts are capped. They are rendered
as React text only.

- **Storage messages:** accepted only when the host passed `storage.save` (the Arcade player).
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
  - A package without a version (or with a URL, git or file version) loads the latest. The publish
    modal lists these as "unpinned".
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

## Arcade player

- Keyboard focus goes to the game on load, after Restart and after full screen.
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
- The first run waits until the other workspace files are decrypted, so a page never starts without
  its scripts.
- A lone `.js` file that uses `import`/`export` (or any `.mjs`) runs as a module through the bundler.
- Blocked external URLs show in a banner and as console errors.

## Chat

- **Run** under HTML/CSS/JS uses the play profile (CDN libraries, storage, dialogs). The frame is 380 px
  tall (300 px on phones).
- A message longer than 4,000 characters that is code goes out as a **code snippet** (≤ 45 KB) when you
  press Enter; the composer says "Sends as a code snippet". The cases:
  - one fenced block, or several in one language: that code;
  - HTML with CSS/JS blocks: merged into one runnable page;
  - an unfenced HTML document: as is.
  - Text outside the fences becomes the caption.

## Security notes

- Nothing changes for add-ons (strict profile, explicit `profile="strict"` in `AddonFrame`).
- **What play frames can reach:**
  - the network only at the pinned CDN paths, `data:` and `blob:`;
  - no Codehub data, no other frames (`frame-src 'none'`), no forms, no popups;
  - from the parent page, only the validated storage snapshot of the game being played.
- **Residual risks** (documented in the README):
  - A frame can navigate itself to any page. That page still has no access to Codehub.
  - WebRTC is not covered by CSP in Chromium.
  - jsDelivr's public per-file statistics are a slow, aggregate side channel.
  - Running a chat snippet or a game reveals your IP address to the CDNs it loads from.
- Saved game data is the game's own data, kept unencrypted on your device and never uploaded.

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
    `<tmp>/codehub-cdn-cache`). It is filled from the network on first use.

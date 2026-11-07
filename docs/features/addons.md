# Add-ons (round 3, workstream `addons`)

Add-ons are small apps (one HTML document with inline JS and CSS) that anyone can publish and that run
in a locked-down sandbox beside a conversation. They talk to Codehub only through a permission-checked
bridge (`window.codehub`). Code: `src/features/addons/` (registrations in `register.jsx`, pure logic in
`lib/`, UI in `components/`, first-party examples in `examples/`). Rule bytes used: **0** (generic
blocks only; minified rules stay at 98,157 bytes).

Not to be confused with the shop's cosmetic "Add-ons" (themes, badges; Settings → Add-ons): these are
"Add-on apps" in Settings.

## Features

### 4. Add-on builder and public directory

- **Purpose.** Command palette "Create an add-on" / "Browse add-ons" (`paletteActions`), the
  "Browse add-ons" button in the chat panel and Settings → Add-on apps open the hub dialog (mounted
  once via `appMounts`, loaded lazily): **Directory** (search, sort by newest or name, details),
  **Your add-ons** (your published ones: view, edit) and **Create** (the builder).
- **Builder.** Name (≤ 48), icon (an emoji or ≤ 8 characters), version (`major.minor.patch`; an
  update that changes code or permissions must raise it), description (≤ 500), permissions from the
  fixed list, and a CodeMirror editor (same base setup and one-dark theme as the collab editor, own
  lazy chunk) for the document (≤ 64 KB UTF-8). "Start from…" offers a hello template and the two
  examples. A live preview runs the code in the same sandbox with a **mock bridge**: sample
  conversation, in-memory storage, `insertText` / `sendMessage` only logged, console output and
  uncaught errors shown in a log.
- **Details** show icon, name, version, publisher (with the app-admin chip), date, size, description,
  the **permissions with what each one means (before install)**, the code checksum, "Try with sample
  data" (the mock-bridge preview of the published code), Install / Review update / Uninstall,
  Report, and for the publisher Edit / Unpublish, for app admins "Remove (app admin)".
- **Report** uses the existing reports flow (`reports/{rid}` + `reportLog`, one per 30 s). The reports
  rules only accept the kinds `game|user|shopItem|message` and this workstream has no rule budget, so
  an add-on report is filed as kind `shopItem` with target `addon:{id}` (`lib/report.js`). The admin
  reports queue shows such reports as "Add-on" with the add-on's name and a "Remove add-on" action
  (through the new `reportTargets` registry, see "Shared-file changes").
- **App-admin removal**: from the details view, the admin panel's "Add-ons" tab (list of all
  published add-ons) or the reports queue.

### 5. Personal add-ons panel and bridge

- **Purpose.** Install from the directory (the permissions dialog lets you untick any requested
  permission; calls that need an unticked one fail with `PERMISSION_DENIED`). The chat header button
  "Add-ons" (`chatHeaderButtons` → `chatPanels` id `addons`) lists your add-ons (and, in a server
  channel, the server's) and runs one in the panel. Settings → **Add-on apps** (`userSettingsTabs`
  id `addonApps`) lists installs (update review, "Send messages without asking me", uninstall),
  server add-ons you allowed (revoke, auto-send) and stored data (size, clear).
- **Bridge** (`lib/bridge.js`). Before the add-on's code, the frame runs `addonSdk`, which defines a
  frozen, non-writable `window.codehub` and opens a `MessageChannel`. It posts one hello
  `{ __addon: token, hello: 1 }` with the channel's port to the parent. The host accepts it only when
  `e.source` is that exact iframe's `contentWindow`, the per-frame random token matches, and no port
  is bound yet; every later call and reply goes over that private port. API:
  - `ready()` → `{ context, theme, perms }`; `getContext()` → `{ kind, name, me: { name }, scope }`
  - `getMessages(n)` (perm `readMessages`): the last `n ≤ 100` visible decrypted messages
    `{ id, author, text, ts }` (deleted, pending and undecryptable ones skipped; a code snippet is
    appended as a fenced block). Event `messages` `{ count }` when the conversation changes.
  - `insertText(text)` (perm `composer`, ≤ 4000 characters): into the composer at the caret.
  - `sendMessage(text)` (perm `send`, ≤ 4000, may not start with `/`, at most one per 3 s): a
    confirm dialog shows the exact text every time unless the user ticked "Allow … to send without
    asking" for that add-on. The message goes through the normal send pipeline (send hooks such as
    AutoMod run) and carries `extra.addon = { id, name, icon }`; readers see a "via 🧩 Name" badge
    (`messageBadges`, validated and rendered as text).
  - `storage.get / set / remove / keys` (perm `storage`): JSON values, ≤ 32 KB per add-on.
  - `theme` / `getTheme()` / event `theme`: `{ mode: 'dark'|'light', tokens }` from the app's CSS
    variables (only plain `#hex` / `rgb()` values pass), also applied in the frame as `--ch-<token>`
    variables (`--ch-bg-2`, `--ch-text`, `--ch-accent`, …) and `data-theme`. Shop themes and theme
    switches are pushed live.
  - Every call is permission-checked, validated (types, lengths, JSON-only values, ≤ 70 KB per
    request) and rate-limited (token bucket: 30 burst, 10 per second); errors reject with
    `err.code` (`PERMISSION_DENIED`, `RATE_LIMITED`, `INVALID_ARGUMENT`, `CANCELLED`, `QUOTA_EXCEEDED`,
    `UNAVAILABLE`, `BUSY`, `UNKNOWN_METHOD`, `FAILED`).
- **Pinning.** Installing pins the reviewed code: its SHA-256 goes into the install record and a copy
  of the code into `addonPin`. The runner loads the pinned copy and refuses it unless it hashes to the
  pinned sha. When the publisher changes the code, you keep running the approved version; the panel,
  the settings tab and the details view show "Update available" and a review dialog (version, added
  and removed permissions, newly requested permissions unticked by default, line diff against the
  pinned copy) re-pins it on "Accept update".

### 6. Server add-ons

- **Purpose.** Server settings → **Add-ons** (`serverSettingsTabs`, visible with `manageApps`):
  install from the directory with the permissions the installer grants, review updates (same
  dialog), uninstall. While a server is open, an `appMounts` entry registers one channel-header
  button and chat panel per installed add-on (first 4; all of them are in the "Add-ons" panel),
  labelled "Name (add-on)". Each member's first open shows the granted permissions and asks for
  consent ("Allow and open"); consent is stored per member and asked again when the server grants
  permissions the member hasn't accepted. Members who aren't managers can't change anything.
- **Examples.** `examples/pomodoro.html` ("Pomodoro timer", `storage`: focus/break timer that keeps
  its end time in storage, so it keeps counting while closed) and `examples/wordcloud.html`
  ("Channel word cloud", `readMessages`: top 40 words of the last 100 messages, refreshes on new
  messages). An app admin publishes or updates them from Admin panel → **Add-ons** (`adminTabs`);
  they are then ordinary add-ons by that admin (manifest field `seed` lets the tab find them again).

## Data paths

| Path | Shape | Who |
|---|---|---|
| `pub/addons/{id}` | `{ name, icon, version, sha, size, perms?: 'readMessages,composer,send,storage', desc?, seed?, by, ts }` | public catalog: signed-in read; publisher writes; publisher or app admin deletes |
| `pub/addonCode/{id}` | `{ code (≤ 65536 chars), sha, by, ts }` | same; written in the same update as the manifest |
| `udata/{me}/addons/{id}` | `{ sha, perms?, at, v, name, icon, auto? }` | my install (pinned sha + granted permissions) |
| `udata/{me}/addonPin/{id}` | `{ sha, n, c0…c(n-1) }` (≤ 16000-char chunks) | my approved copy of the code |
| `udata/{me}/addonStore/{key}` | `{ iv, n, c0… }` = `sealForMe` box, ciphertext chunked | add-on storage; key `{id}` (personal) or `{sid}~{id}` (server add-on) |
| `udata/{me}/addonConsent/{sid}~{id}` | `{ sha, perms?, at, auto? }` | my consent to a server add-on |
| `sconf/{sid}/addons/{id}` | `{ sha, perms?, by (installer), at, v, name, icon }` | server install; members read, `manageApps` writes |
| `sconf/{sid}/addonPin/{id}` | `{ sha, n, c0… }` | the server's approved copy |
| `reports/{rid}` | `{ by, kind: 'shopItem', target: 'addon:{id}', reason, note?, ts }` | existing reports flow |

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

- **Sandbox.** Add-ons run only through `SandboxFrame` (`sandbox="allow-scripts"`, opaque origin, no
  same-origin/popups/top-navigation/forms/modals, CSP `default-src 'none'; connect-src 'none'; …`):
  no network (fetch/XHR/WebSocket, external scripts, images, fonts), no access to the app's storage,
  keys, cookies or DOM. Nothing from an add-on is ever rendered as HTML in the app; strings it sends
  (message text, composer text) are handled exactly like typed text.
- **Bridge binding.** Only the first hello from the exact iframe window with the per-render token
  binds a private `MessageChannel`; nothing else on `window` is listened to. A page the frame
  navigates to can never reach the bridge (the port belonged to the old document), and the host
  **stops a frame that loads a second document** ("tried to load another page") and closes the port.
- **Residual risk, stated in the permission text:** a frame can still navigate itself, so an add-on
  holding `readMessages` could leak what it was shown in a URL before it is stopped. Permissions are
  all-or-nothing per call type; grant `readMessages` and `send` only to add-ons you trust.
- **Untrusted data.** Manifests, code records, installs and consents are parsed and validated on read
  (`lib/manifest.js`: lengths, characters, version format, sha format, known permission names only;
  anything off is dropped). Before running or pinning, the manifest and code record must have the
  **same `by`**, the same `sha`, and the code must **hash to that sha**; pinned copies are re-hashed
  on every load. `m.body.addon` badges are type-checked and rendered as text.
- **Consent.** Personal installs show the permissions before install; server add-ons show them to
  every member on first open and again when permissions grow; `sendMessage` asks every time unless
  the user opted out for that add-on (Settings → Add-on apps can turn it back on).
- **Encryption.** Add-on storage is sealed with the user's vault key (AAD above), so only the user
  can read it. Messages an add-on reads are decrypted locally and handed to the sandbox only with
  `readMessages`; messages it sends are encrypted like any other message.
- **No server.** Add-ons run in the browser of the user who opens them; nothing runs when nobody has
  one open.

## Limits

| Limit | Enforced by |
|---|---|
| Code ≤ 64 KB (65536 UTF-8 bytes; `code` ≤ 65536 chars) | builder + rules (`pub` `code` field) |
| Name ≤ 48, icon ≤ 8, description ≤ 500, version `x.y.z` | builder + read-side validation (rules: strings ≤ 20000) |
| `ts` = server time on every `pub` write; only the publisher edits; publisher or app admin deletes | rules |
| 20 published add-ons per user | UI only (rules can't count) |
| Storage ≤ 32 KB of JSON per add-on (sealed, chunked into ≤ 16000-char fields) | bridge (rules: 20000 per field) |
| `getMessages` ≤ 100, text ≤ 4000, ≤ 70 KB per call, 30-call burst / 10 per s, one send per 3 s | bridge |
| Header buttons for the first 4 server add-ons | UI |

## Shared-file changes (for the integrator)

- `src/components/admin/AdminPanel.jsx`: renders entries of a new **`adminTabs`** registry
  (`{ id, label, render({ me }) }`) after the built-in tabs (additive).
- `src/components/admin/ReportsQueue.jsx`: entries of a new **`reportTargets`** registry
  (`{ id, label, match(report), render(report), actions?(report, { act, dismiss, busy }) }`) take over
  the kind pill, target line and extra actions of matching reports (additive). Bots can use both.
- If the integrator ever has bytes to spare, adding `addon` to the reports `kind` regex would let
  add-on reports use their own kind; change `ADDON_REPORT_KIND` in `lib/report.js` then.

## Tests

- `tests/unit/addons.test.mjs`: manifests, permissions, chunking, SHA-256, rate limiter, bridge host
  (permissions, validation, send rules, quota), the SDK end to end over a real `MessageChannel`, and
  the example files.
- `tests/rules/addons.test.mjs`: every write the store makes on `pub`, `udata`, `sconf` and the report.
- `tests/e2e/42-addons.spec.mjs`: builder preview → publish → install → every bridge call (confirmed
  send with badge, encrypted storage across reload, navigation stop) → uninstall; admin seeding,
  install of the Pomodoro example (state survives reopening), report → admin removal; server install,
  member consent, publisher update pinned until a manager accepts it.

# Premium membership (feature 32)

Members unlock premium for 30 days by redeeming the owner's **monthly code**. The owner manages codes and members
from a passcode-locked dashboard in the Admin panel. Everything runs on the free Spark plan: the database rules are
the only gatekeeper, there is no server and no payment integration (how the owner hands out codes is up to them).

Code: `src/features/premium/` (`index.js` registers the UI; `lib/status.js` is the shared status contract;
`lib/codes.js` and `lib/lookCore.js` are pure and unit-tested; `lib/premium.js` holds the Firebase actions; the
agent mode lives in `agent/`, see [Agent mode](#agent-mode-in-codespaces) below). Rules: `premium`, `premiumCodes`, plus small changes in
`wallets`, `inventory` and `shop/items` in `database.rules.json`.

## Purpose and UI

- **Settings → Premium** (`userSettingsTabs` id `premium`; palette "Open Premium settings"): status (active until,
  redeemed on), the redeem / renew form, "Leave premium", the perk list, and, while active, the **premium look**
  editor with a live preview. An **Agent mode** card lists what the agent needs (premium, the API key from
  Settings → Assistant, with a button there while the key is missing or locked) and where to find it.
- **Admin panel → Owner** (`adminTabs` id `owner`, app admins only): locked until the owner passcode is entered.
  Unlocked, it shows this month's and next month's code (large, Copy), **Generate codes**, **Replace this month's
  code** (with confirmation), all codes with their state, the member list (name, redeemed, expiry, Revoke, optional
  expired rows) and the **Database rules** panel. It locks again after 15 minutes or on **Lock**.
- **Perks**
  - Double daily coins: the shop's daily claim gives +200 instead of +100 (the first claim, which opens the wallet,
    stays 100). The button says "(+200, premium)".
  - Premium-only shop items: the item form (creators and app admins) has "Premium members only". The card shows a
    "Premium" tag; non-members see "Premium only" instead of Buy / Get.
  - Premium badge (a diamond) after the name in messages (`messageBadges` id `premium.badge`), server and group
    member lists, the profile card and the user panel.
  - Custom role tag: up to 24 characters (emoji count as one), one colour or a two-colour gradient.
  - Profile banners: aurora, animated gradient, starfield, or the standard banner with an animated frame.
  - Effects: name effects (gradient, glow, shimmer, rainbow), profile-card effects (sparkles, snow, confetti) and an
    avatar frame (glow, gradient, rainbow ring) on messages and the profile card.
  - Agent mode in codespaces: Claude edits the workspace's files with the member's own Anthropic API key; see
    [Agent mode](#agent-mode-in-codespaces).

All animations stop when Settings → Appearance → Reduce motion is on (`html.ap-reduce-motion`) or the device asks for
reduced motion; card particles are then hidden. The pieces use the theme tokens and work in dark and light theme and
at phone width.

## Data paths

```
premium/{uid}              { at, until, m }        at = server now; until = now + 30 days (within the minute
                                                    before); m = 'YYYYMM' of the code redeemed
premiumCodes/{YYYYMM}      { c, from, until }      c = code (8–64 chars), from/until = UTC month start / next month start
promoAttempts/{uid}        { code, at }            existing: the last guess (code or passcode), 30 s per account
config/ownerPass           string ≥ 12 chars       set only in the Firebase console
upub/{uid}/premium/look    { tag?, tagA, tagB?, nameFx, fxA, fxB, cardFx, banner, frame }   generic public block
shop/items/{id}/premium    true                    optional: premium-only item
```

Codes look like `HXQ7-K4MW-TN3C`: 12 symbols from a 23-letter alphabet without look-alikes (no 0/O, 1/I/L, 2/Z,
5/S, 8/B, U/V), drawn with `crypto.getRandomValues` and rejection sampling (about 54 bits). The redeem form accepts
them in any case, with or without dashes or spaces.

### Writes

- **Redeem / renew** (member): `set(promoAttempts/{me}, { code, at: now })`, then `set(premium/{me}, { at: now,
  until, m })` for the month of the server clock; within 36 hours of a month boundary also the neighbouring month.
  `until` is computed from the server time offset, 10 s below now + 30 days.
- **Leave** (member) / **Revoke** (app admin): `remove(premium/{uid})`.
- **Unlock** (owner): `set(promoAttempts/{me}, { code: passcode, at: now })`, then a test read of `premiumCodes`.
  **Lock** overwrites the stored guess with random filler (after the 30 s cooldown if needed) so access ends before
  the 15 minutes are over.
- **Generate codes**: one multi-path update of `premiumCodes/{m}` for this month and the next 11 calendar months
  that have no code. **Replace**: `set(premiumCodes/{thisMonth})` with a fresh code (same window).
- **Daily claim**: `wallets/{me}` `{ balance + 200, lastClaim: now }` while premium; if refused (the membership just
  ended, or older rules are published) the client retries with +100.
- **Premium look**: `set(upub/{me}/premium/look)`; account deletion removes `upub/{me}` and `premium/{me}`.

## What the rules enforce

- `premium/{uid}`: signed-in users read one record; only app admins read the whole list. A **create or overwrite**
  is allowed only by `uid` itself, with `at = now`, `until` in `(now + 30 d − 60 s, now + 30 d]`, fields `at`,
  `until`, `m` only, `m` six digits, and:
  - `premiumCodes/{m}/c` equals `promoAttempts/{uid}/code`, written at most 2 minutes ago;
  - `premiumCodes/{m}/from <= now < premiumCodes/{m}/until` (expired and future months fail);
  - `m` differs from the stored record's `m` (renewal needs a later month's code; the same code can't be replayed to
    push `until` forward).
  A **delete** is allowed for `uid` itself and for app admins. Admins can't grant premium.
- `premiumCodes`: read and write only when `admins/{auth.uid}` exists, `config/ownerPass` is a string of at least 12
  characters, `promoAttempts/{auth.uid}/code` equals it and was written less than 15 minutes ago. Entries need
  `$m` = six digits, `c` 8–64 characters, numeric `from` and `until > from`, nothing else.
- `wallets`: a daily claim adds exactly 200 while `premium/{uid}/until > now`, else exactly 100.
- `inventory`: an item with `premium` set can be added (bought or taken free) only while `premium/{uid}/until > now`.
- `shop/items/{id}/premium`: `true` or absent; the existing item rules decide who may edit (creator or app admin).
- `config` stays unreadable and unwritable for every client.

## Threat model and security notes

- **Secrets.** The owner passcode and the codes exist only in the database (`config/ownerPass` is console-only,
  `premiumCodes` is owner-only) and in the browser of whoever types them. The client clears the input before the
  request, never logs, persists or echoes them in errors, and no secret appears in source, rules, docs or tests (tests
  generate random values at runtime). The Owner dashboard does show the codes on screen once unlocked: that is its job.
- **Guessing.** `promoAttempts` accepts one guess every 30 s per account, shared by the admin code, premium codes and
  the passcode. A premium code has about 2^54 possibilities; the passcode has at least 12 characters. Rate limiting
  is per account, so many throwaway accounts guess faster (still far from feasible).
- **Two factors for codes.** Being an app admin is not enough to see codes: an admin also needs the passcode. A
  stolen admin session without the passcode can only list and revoke memberships.
- **Shared codes.** A monthly code works for everyone who has it, during its month. A leaked code can be stopped with
  "Replace this month's code"; members who already redeemed keep their 30 days (revoke them individually).
- **Revoke is not a ban.** A revoked member who still has this month's code can redeem it again (their record is gone,
  so it is a first redemption). Replace the code if that matters.
- **Leave and redeem again.** A member who deletes their own record can redeem the same month's code again and
  restart 30 days from that moment, at most until 30 days after the month ends.
- **Cosmetics are untrusted.** Anyone can write `upub/{uid}/premium/look` (generic block); readers show it only
  while `premium/{uid}` is active, re-validate every field (`normalizeLook`: known effect names, `#rrggbb` colours,
  tag cleaned of control and bidi characters, at most 24 characters, no links or HTML) and render the tag as React
  text. Colours are applied through CSS custom properties only.
- **Clock.** Expiry uses the server clock on writes (rules `now`) and the server-corrected clock on reads
  (`isPremiumActive`). Month windows are UTC; near a boundary the client tries both months.
- **Database rules file.** The build emits the minified rules as `rules.min.json` next to `index.html` (Vite plugin in
  `vite.config.js`, also served by the dev server). Rules contain no secrets; the file is fetched only when the
  Database rules panel opens.
- **Older rules.** Until the new rules are published, `premium/*` reads are refused (everyone shows as non-premium),
  the dashboard explains that the passcode or rules are not set up, double coins fall back to +100, and the
  "premium only" flag can't be saved.

## Plaintext by design

Membership records (who is premium, when they redeemed, which month's code, until when) are readable by every
signed-in user so others can render perks. The premium look is public like the rest of `upub`. Codes and the
passcode are never readable by members.

## Limits

- 30 days per redemption; a new month's code renews (until = redemption + 30 days, not stacked).
- Codes: up to 12 months ahead per "Generate codes"; 8–64 characters (generated codes are 14).
- Role tag ≤ 24 characters (UI), upub strings ≤ 2000 (rules).
- Owner unlock: 15 minutes; one guess per 30 s per account.
- Rule bytes: premium adds about 1.8 KB to the minified rules; the minifier's new `isString()` guard drop saves about
  2.7 KB across the existing rules (full suite green on source and minified output, emulator probes in
  `tests/rules/premium.test.mjs`). Minified total with premium: 99,850 bytes.

## Agent mode in codespaces

An **Agent** panel beside every collab workspace (server code channels and codespaces): the member
describes a task and Claude works on the workspace's files with a fixed set of tools. Premium only
(`usePremium` from `src/features/premium/lib/status.js`); it runs on **the member's own Anthropic API
key** from Settings → Assistant, straight from their browser to `https://api.anthropic.com` (no Codehub
server, Spark plan).

Code: `src/features/premium/agent/` (`index.js` registers; `lib/` is logic, `components/` the UI).
Tests: `tests/unit/premium-agent.test.mjs`, `tests/e2e/53-premium-agent.spec.mjs`.

### Where it shows

- **Agent** button (🤖) in the workspace toolbar and in the empty workspace's start actions
  (`collabTools` registry, `aria-pressed`), and the panel beside the editor (`collabMounts` registry). Both
  registries are new and additive, rendered by `src/components/collab/CollabExtras.jsx`:

  | Registry | Entry | Where |
  |---|---|---|
  | `collabTools` | `{ id, order?, render(ctx, place) }` | CollabView toolbar (`place` `'toolbar'`) and the empty workspace's welcome actions (`'welcome'`). `ctx` is the CollabExtras ctx |
  | `collabMounts` | `{ id, order?, render(ctx) }` | Once per open workspace, as the last child of `.cx-root` (a flex row: a panel there becomes a right column); stays mounted while files open and close |

- The panel is a right column (400 px); at 900 px and below it covers the workspace. While it is open
  the toolbar's ghost buttons become icons and the toolbar scrolls. Esc (focus in the panel, no dialog
  open) or ✕ closes it. The run keeps going while the panel is closed; leaving the workspace stops it.
- **Not premium** (no record, or `until` in the past): the panel explains what agent mode does and offers
  **Get Premium** (`openSettings('premium')`). It unlocks live when the record appears.
- **No key / locked key**: the assistant's key gate (add a key in Settings → Assistant, or the passphrase
  unlock form).
- **Consent** (once per account and browser, `codehub.agent.prefs.<uid>.consent`): the files the agent reads
  are decrypted in the browser and sent, with the task, to Anthropic under the member's key, outside
  Codehub's end-to-end encryption; nothing is sent until a task runs. A one-line reminder stays under the
  input.

### What it can do (tools)

| Tool | Input | Notes |
|---|---|---|
| `list_files` | – | paths, sorted |
| `read_file` | `path`, `start_line?`, `end_line?` | line-numbered (`12\| code`), ≤ 100,000 characters per call, says where to continue |
| `search_files` | `query`, `regex?`, `case_sensitive?`, `path_prefix?` | `path:line: text`, ≤ 200 matches; regexes run in a Web Worker stopped after 4 s |
| `create_file` | `path`, `content` | fails if the path (or a folder / parent file) exists |
| `edit_file` | `path`, `old_str`, `new_str` | `old_str` must occur exactly once; inserted literally |
| `write_file` | `path`, `content` | whole-file replace of an existing file |
| `delete_file` | `path` | |
| `rename_file` | `path`, `new_path` | |
| `preview` | `entry?` | bundles the entry with the live-preview pipeline (`buildPreviewHtml`), runs it ~3 s in `SandboxFrame` (opaque origin, CSP, no network) and returns console output and uncaught errors (≤ 20,000 characters) |

Paths must already be clean workspace paths (no leading `/`, no `.`/`..`), ≤ 300 characters. Read-only
members (codespace viewers) only get the reading tools and `preview`; every write is also refused in the
tool layer and in the collab adapter (and by the rules).

### Changes, approval, checkpoints, undo

- Every changing tool is **planned** first (validated, before/after text computed) and shown as a diff
  card. Default **Ask before each change**: **Apply**, **Skip** (Claude is told it was skipped) or
  **Apply all** (the rest of this run). **Apply automatically** (Changes picker) skips the question.
- Applying re-reads the file: an `edit_file` is re-applied to the current text if `old_str` is still
  unique; a `write_file` (or an edit that no longer matches) is refused with "changed while waiting for
  approval"; a file renamed or deleted meanwhile is refused.
- Edits go through the **shared Yjs documents**: the open editor's provider for the file on screen,
  otherwise a short-lived `CollabProvider` for that file (synced, one minimal-replace transaction via
  `replaceYText`, flushed, closed). Collaborators see the changes live, like typing. Create / delete /
  rename use `createFile` (content seeded atomically), `deleteFile`, `updateFileMeta`.
- **Checkpoint before the first change**: before a run first changes an existing file, a checkpoint of
  that file is saved with the existing checkpoints feature (`saveCheckpoint`, label
  `Before agent run YYYY-MM-DD HH:MM`). These count toward the per-file checkpoint list like any other.
- **Undo this run** (one click + confirmation) puts every file the run touched back: files it created are
  deleted, deleted files recreated, renames reversed and contents restored (later edits by others to those
  files are replaced too; the confirmation says so). It uses an in-memory record of the run; after a
  reload the checkpoints remain for manual restore (a deleted file's checkpoints go with it, as with any
  delete).

### Claude API usage

| | |
|---|---|
| Client | the assistant's: `@anthropic-ai/sdk` loaded on first use as its own chunk, `dangerouslyAllowBrowser: true`, `maxRetries: 0`, key from `currentKey()` (memory / localStorage only) |
| Loop | manual streamed loop (`lib/loop.js`): `messages.stream` (or `beta.messages.stream`) + `finalMessage()`; the full assistant content (thinking included) is appended unchanged; all tool results of a turn go back in one user message |
| Request | `max_tokens` 64000, `thinking: { type: 'adaptive' }`, `output_config.effort` (Low / Medium / **High** default / Extra high), top-level `cache_control: { type: 'ephemeral' }`, a static system prompt, the tools above with `eager_input_streaming: true`. Opus and Sonnet go through the beta endpoint with `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'` |
| Models | `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5` (shared with the assistant) |
| Validation | every parsed tool input is checked against its schema (`validateInput`) before anything runs; a failure goes back as an `is_error` result `{"INVALID_JSON": …, "error": …}`. A stream the SDK can't parse is re-issued (at most twice in a row); API errors never are |
| Stop reasons | `refusal` (tools of that turn never run; the assistant's refusal note), `max_tokens` with a tool_use (not run), `model_context_window_exceeded`, `pause_turn` (continued, ≤ 5) |
| Limits | 50 tool calls per run (the rest are answered "not run" and the run stops; "continue" resumes), task ≤ 20,000 characters |
| Stop | aborts the request; a change waiting for approval is not applied; open tool_use blocks are closed with "not run" results so a follow-up is valid |
| Errors | `describeError` from the assistant (401 key rejected, 403, 429 with retry-after, 529 overloaded, 402, 404 model, 400, 5xx, network) with a link to Settings → Assistant where it helps |
| Usage | per-workspace session counter (input, output, cached tokens, tool calls) and the assistant's session counter |

### Data paths

No new database paths and **0 rule bytes**. Reads and writes use the existing collab paths
(`collab/{sid}/{cid}/…`, `csCollab/{csid}/…`: files, updates, snapshots, awareness, checkpoints) exactly as
the editor does, encrypted with the space key and the existing AAD strings. `premium/{uid}` is read through
`usePremium`.

| Where | What |
|---|---|
| localStorage `codehub.agent.prefs.<uid>` | `{ model, effort, auto, consent }` |
| memory | the conversation, transcript (decrypted file text in diffs), undo records, usage. Cleared on vault lock / sign-out; a reload drops it |

### Security notes

- **Prompt injection**: workspace files are written by other members and can say anything. The system
  prompt says file names, contents, search results and console output are data, never instructions. The
  agent can only call the tools above, scoped to this workspace; nothing it produces runs in the app
  origin (preview runs only in the sandbox frame, with no network); every change is shown as a diff first
  unless the member chose "Apply automatically"; and a run can be undone. Tool output and the reply render
  as React text / through `renderMarkdown` (DOMPurify).
- **The key** stays in the browser and is only sent to api.anthropic.com by the SDK; it is never put in a
  prompt, the database or a log.
- **Where data goes**: decrypted file contents the agent reads leave Codehub's E2EE under the member's own
  Anthropic account (consent card + reminder).
- **Premium gate** is a client check: the feature runs on the member's own key and costs Codehub nothing,
  so a modified client gains nothing from bypassing it.
- **Regex search** runs in a worker with a timeout, so a pathological pattern can't freeze the page.

### Limits

- 50 tool calls per run; one run per workspace at a time; previews ≈ 3 s each, 2 MB bundle limit; files up
  to ~900 KB per change (collab insert limit); 200 files for preview bundling.

## Tests

- Rules: `tests/rules/premium.test.mjs` (redeem right / wrong / expired / future / stale / no code / wrong shape;
  renew; delete own; admin revoke; list access; dashboard access with fresh passcode, after 15 minutes, wrong
  passcode, non-admins, short or missing passcode; malformed codes; config unreadable; double coins; premium-only
  purchases; the premium item flag; probes for the dropped `isString()` guards).
- Unit: `tests/unit/premium.test.mjs` (code generation and alphabet, normalization, UTC month windows, candidate
  months, code planning and replacement, look validation, the minifier's guard drop).
- E2E: `tests/e2e/52-premium.spec.mjs` (owner unlocks with a random passcode, generates and copies codes; a member
  redeems and gets the badge, tag, effects and double coins; a non-member's look shows nothing; premium-only item
  purchase; revoke; lock; the Database rules panel's size and Copy).
- Agent mode: `tests/unit/premium-agent.test.mjs` (tool schemas and input validation, path rules, planning and
  applying changes, search, the loop's stop reasons) and `tests/e2e/53-premium-agent.spec.mjs` (list, read, an
  approved diff seen live by a collaborator, preview console output, checkpoint, Undo, Stop, non-premium upsell).

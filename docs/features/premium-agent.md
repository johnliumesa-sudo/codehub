# Premium: agent mode in code workspaces

An **Agent** panel beside every collab workspace (server code channels and codespaces): the member
describes a task and Claude works on the workspace's files with a fixed set of tools. Premium only
(`usePremium` from `src/features/premium/lib/status.js`); it runs on **the member's own Anthropic API
key** from Settings → Assistant, straight from their browser to `https://api.anthropic.com` (no Codehub
server, Spark plan). Part of the premium feature set documented in `docs/features/premium.md`.

Code: `src/features/premium/agent/` (`index.js` registers; `lib/` is logic, `components/` the UI).
Tests: `tests/unit/premium-agent.test.mjs`, `tests/e2e/53-premium-agent.spec.mjs`.

## Where it shows

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

## What it can do (tools)

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

## Changes, approval, checkpoints, undo

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

## Claude API usage

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

## Data paths

No new database paths and **0 rule bytes**. Reads and writes use the existing collab paths
(`collab/{sid}/{cid}/…`, `csCollab/{csid}/…`: files, updates, snapshots, awareness, checkpoints) exactly as
the editor does, encrypted with the space key and the existing AAD strings. `premium/{uid}` is read through
`usePremium`.

| Where | What |
|---|---|
| localStorage `codehub.agent.prefs.<uid>` | `{ model, effort, auto, consent }` |
| memory | the conversation, transcript (decrypted file text in diffs), undo records, usage. Cleared on vault lock / sign-out; a reload drops it |

## Security notes

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

## Limits

- 50 tool calls per run; one run per workspace at a time; previews ≈ 3 s each, 2 MB bundle limit; files up
  to ~900 KB per change (collab insert limit); 200 files for preview bundling.

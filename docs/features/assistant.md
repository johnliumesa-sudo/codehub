# Assistant (features 7–11)

A personal assistant powered by Claude, using **each user's own Anthropic API key**. Requests go
straight from the user's browser to `https://api.anthropic.com` through the official SDK
(`@anthropic-ai/sdk`, loaded on first use as its own chunk). There is no Codehub server in between
(Spark plan: no Functions), and nothing is sent unless the user runs an assistant action.

Code: `src/features/assistant/` (`index.js` registers everything; `lib/` is pure logic, `components/`
the UI). Tests: `tests/unit/assistant.test.mjs`, `tests/e2e/43-assistant.spec.mjs`.

## Claude API usage

| | |
|---|---|
| Client | `new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 })` (the SDK then sends `anthropic-dangerous-direct-browser-access: true`) |
| Models | `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5` — exact ids, no date suffixes |
| Requests | streamed with `client.messages.stream(...)`; text comes from `content_block_delta` / `text_delta` events, then `finalMessage()` gives `stop_reason` and `usage`. `max_tokens: 64000`. No `thinking`, no `temperature`/`top_p`/`top_k` (Opus 5.5 rejects them). `output_config: { effort }` from the settings: `low` (default), `medium`, `high` |
| Refusal fallback | Opus and Sonnet go through `client.beta.messages.stream` with `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`; Haiku uses the plain endpoint without fallbacks. When a fallback model answered (`usage.iterations` has a `fallback_message`, or a `fallback` content block), the reply says "answered by …" |
| Stop reasons | `refusal` → "Claude declined this request (category)…" with Retry; `max_tokens` / `model_context_window_exceeded` → "cut off" note; aborted → "Stopped." |
| Errors | `AuthenticationError` (401: key rejected, link to settings), `PermissionDeniedError` (403, with Anthropic's message), `RateLimitError` (429, "Try again in N s" from `retry-after-ms`/`retry-after` when the browser can read it), `APIConnectionTimeoutError` / `APIConnectionError` (network, firewall, CORS), then `APIError` by `.status`/`.type`: 529 `overloaded_error`, 402 `billing_error`, 404 (model not available to the key), 413, 400 (Anthropic's message), 5xx. No automatic retries: every failed reply has a Retry button |
| Test key | one non-streamed `messages.create` with `max_tokens: 64` on the selected model |
| History | the panel resends earlier turns as plain text pairs; failed, refused and empty replies are left out so roles alternate. Thinking blocks are never stored or resent |
| CSP | the app sets no Content-Security-Policy. If one is added, allow `https://api.anthropic.com` in `connect-src` (and nothing else for this feature) |

## 7. Assistant setup — Settings → Assistant (`userSettingsTabs` `assistant`)

- **Key**: pasted into a password field, stored **only in this browser's localStorage**, per account:
  `codehub.assistant.key.<uid>`. Plain: `{ v: 1, mode: 'plain', key }`. Optionally locked with a
  passphrase (≥ 8 characters): PBKDF2-SHA256 (600,000 iterations, 16-byte random salt) → AES-256-GCM,
  stored as `{ v: 1, mode: 'locked', salt, iter, iv, ct, hint }` where `hint` is `…` + the last 4
  characters. **AAD `assistant-key:<uid>`** binds the ciphertext to the account. A locked key is
  decrypted once per page session (unlock form in the panel or in settings) and kept in memory only;
  "Lock now" drops it from memory. "Forget key" removes the entry.
- **Test key**, **model** and **effort** pickers, **translation language** (default from the browser
  language). Preferences: `codehub.assistant.prefs.<uid>` = `{ model, effort, lang, ctxCount, draftContext }`,
  validated on read.
- **Session token counter** from each reply's `usage` (requests, input, output, cache read/write);
  memory only, reset button.
- **Privacy notice** (in the tab): what you choose to send — including decrypted channel messages and
  DMs for Catch me up, Translate, Explain code, Summarize thread, writing help and "Include last
  messages" — goes to Anthropic under your key; nothing is sent unless you use an assistant action; the
  key is never stored in Codehub's database.

## 8. Assistant panel (`chatPanels` `assistant`)

- Opened by the header button **Assistant** (`chatHeaderButtons` `assistant.panel`), the palette action
  **Toggle assistant panel**, the **Assistant** toggle at the top of the channel and DM sidebars
  (`sidebarSections`, `aria-pressed`) and **Ctrl/⌘ + Shift + Y** (`appMounts`). The toggle is
  workspace-level: while it is on, the panel opens in every conversation you switch to; closing the
  panel (✕, Esc, another side panel) turns it off.
- Streaming replies rendered with the app's Markdown renderer (`renderMarkdown` → DOMPurify), with code
  copy buttons; **Stop**, **Copy**, **Insert into composer**, **Retry** (errors, refusals, stopped).
- The conversation is kept in memory for the page session (one per account; cleared on reload, on
  "New chat" and when the vault locks).
- **Include last N messages** (10/20/50/100, off by default, per session) adds the decrypted recent
  messages of the open conversation to the next question.

## 9. Catch me up

Header button ⚡ **Catch me up** (`chatHeaderButtons` `assistant.catchup`), palette action **Catch me up on
this conversation**, or the panel's picker (Unread, Last 50/100/200). "Unread" uses the conversation's
read marker (`reads/{uid}/{scope}`), captured when the composer mounts — before ChatView moves the
marker — and reads from the first message by someone else after it (your own messages in between stay
for context; at most 200). With nothing unread it falls back to the last 50. Older pages are loaded
through `ChatContext.loadOlder()` as needed (up to 8 pages). The reply has four sections: Key points,
Decisions, Questions for me, Mentions of me.

## 10. Message AI actions (`messageActions`, "More actions" menu)

- **Explain code** (messages with a code snippet or fenced code): explanation in the panel.
- **Translate** (messages with text): streamed inline under the message (`messageExtras`
  `assistant.translation`), marked "only you see this", with Hide/Retry. Never sent; memory only.
- **Summarize thread** (a message with loaded replies or a parent): the root it replies to, every loaded
  reply below it, oldest first; summary in the panel.

## 11. Writing help and /ask

- Composer button ✨ **Writing help** (`composerButtons` `assistant.write`, a menu): Improve, Fix
  grammar, Make shorter, More formal (rewrite the composer text) and **Draft a reply** (uses the
  composer text as notes, and the last N messages only if the user ticks "Let Claude read the last N
  messages here", remembered in prefs, off by default). The result streams into an editable preview;
  **Replace my draft** / **Put in message box** puts it in the composer. Nothing is sent to the chat.
- **`/ask <question>`** (`slashCommands`): the question and answer appear only in the user's panel. The
  answer has **Share to #channel**, which sends a normal message `**Asked Claude:** <question>` +
  answer (shortened to the 4,000-character message limit) with body extra
  `assistant: { v: 1, model }`. Readers see an **AI** badge (`messageBadges` `assistant.ai`, with a
  `groupKey` so the shared answer starts its own header). The panel follows the open conversation, so
  Share appears only while the conversation the question was asked in is open; elsewhere the answer
  says "Asked in #general: open it to share this answer there." (round 3 security review a6: an answer
  can quote the conversation it was asked in, and must not leak into another one).

## Data paths

None in the database. Everything is client-side:

| Where | What |
|---|---|
| localStorage `codehub.assistant.key.<uid>` | the API key (plain or passphrase-locked, see above) |
| localStorage `codehub.assistant.prefs.<uid>` | model, effort, translation language, context count, "Draft a reply" context permission |
| memory | unlocked key, panel conversation, translations, token counter, panel toggle, captured read markers |
| message body (E2EE like any message) | `assistant: { v: 1, model }` on answers shared with "Share to chat" |

Reads: the open conversation's decrypted messages through `ChatContext`, and `reads/{uid}/{scope}`
(existing path) for Catch me up.

## AAD strings

- `assistant-key:<uid>` — the passphrase-locked API key in localStorage (not a database AAD; listed so
  kinds stay unique).

## Security notes

- **Where data goes**: requests go from the browser to `api.anthropic.com` only, under the user's own
  key and Anthropic account. Decrypted messages leave Codehub's end-to-end encryption when the user
  sends them to the assistant; the settings tab and the panel say so. Nothing is sent in the background.
- **The key** never touches the database or any Codehub-controlled server. In plain mode it is readable
  by anything that can run script on Codehub's origin or read the browser profile; the passphrase lock
  protects it at rest (PBKDF2 600k + AES-GCM). It is per account, so another account on the same
  browser can't use it. Admin keys (`sk-ant-admin…`) are refused.
- **Prompt injection**: chat content is wrapped in `<transcript>`/`<message>`/`<text>` tags, and the
  system prompt tells Claude to treat it as material, never as instructions. Tag look-alikes in message
  text are neutralised (`<` → `‹`) and continuation lines are indented, so a message can't close the
  section or forge a "[time] Name:" line. Display names, forwarded-from names and conversation names
  are untrusted too (anyone picks their own): `promptName()` makes them one line (control characters and
  line breaks become spaces), neutralises the tags the same way, drops a "(me)" look-alike (only the
  transcript adds "(me)", to my own lines) and caps them at 64 characters (round 3 security review a6).
  Claude has no tools: the worst a hostile message can do is skew the reply the user reads.
- **Rendering**: replies and translations render through `renderMarkdown` (DOMPurify, raw HTML shown as
  text, remote images become links). The `assistant` body extra is validated (`v === 1`, model id
  pattern) and rendered as React text.
- **Shared answers** are authored by the member who clicked Share; the AI badge is a claim in an
  E2EE body and can be set or omitted by a modified client.
- Locking the vault (or signing out) stops running requests and clears the unlocked key, the
  conversation and translations from memory.

## Limits

- Transcript per request ≤ 120,000 characters (oldest lines dropped first, and the prompt says how
  many); one message ≤ 4,000 characters inside a transcript; Catch me up and thread summaries read at
  most 200 messages; panel questions ≤ 20,000 characters.
- One panel reply streams at a time; translations can run alongside.
- Rule bytes used: **0** (no database paths).

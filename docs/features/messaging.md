# Messaging (round 3): voice messages, reminders, message links, run code, chat export, drafts

Code: `src/features/messaging/` (registrations in `index.js`, pure helpers in `lib/`, UI in
`components/`, styles in `messaging.css` with the `mx-` prefix). Voice messages extend the media
pipeline in `src/lib/media/{audio,attachments}.js` and `src/components/media/{AudioAttachment,Attachments}.jsx`.
Tests: `tests/unit/messaging.test.mjs`, `tests/rules/messaging.test.mjs`, `tests/e2e/45-messaging.spec.mjs`.

Two pieces of glue are shared by several features:

- **Chat bridge** (`lib/bridge.js`, `components/ChatBridge.jsx` `ChatPublisher`): a `chatMounts` entry
  (mounted with the ChatView, whether or not its composer is shown) that publishes the open chat's
  ChatContext, so workspace-level code (links, reminders, palette) can call `jumpTo` / `openPanel` on it,
  also while a timeout, a block or the rules gate hides or locks the composer. Drafts stay in an
  invisible `composerButtons` entry (`messaging.drafts`), since they need the composer's text box.
- **Opening a message** (`lib/jump.js` `openTarget`): checks access (reading the channel needs server
  membership; a DM id must contain my uid; groups need `userGroups/{me}/{gid}`), calls
  `WorkspaceContext.openConv`, waits for that chat's first page of messages and calls `jumpTo(mid)`,
  which pages older history in, highlights the message, or toasts that it is gone.

## 16. Voice messages

- **Purpose**: the microphone button in the composer (`composerButtons`) records up to 60 s with
  `MediaRecorder` (WebM/Opus or Ogg/Opus; MP4/AAC on Safari) at 32 kbit/s. While recording, a local-only
  card above the composer shows the time, a live level meter, Cancel / Stop / Send; after Stop it shows a
  preview player with Discard / Record again / Send. The waveform (48 bars) comes from decoding the clip
  locally. Messages show a player: play/pause, scrub (a range input over the waveform, keyboard
  accessible), elapsed/total time and speed (1×, 1.5×, 2×). One clip plays at a time. The clip is only
  downloaded and decrypted when someone presses play.
- **Data paths**: exactly the image attachment paths: `att/{scope}/{attId}/meta` and `att/{scope}/{attId}/c/{i}`
  plus the shared `attLog/{uid}` upload window. The message body gets one attachment entry
  `{ attId, kind: 'audio', mime: 'audio/webm'|'audio/ogg'|'audio/mp4', size, dur (s), wave (48 hex digits) }`.
  Message deletion, failed sends and conversation/account cleanup remove it like an image.
- **AAD strings**: the existing `att-meta:{scope}/{attId}` (meta JSON `{ kind: 'audio', mime, dur, name }`)
  and `att:{scope}/{attId}/{i}` (chunks), under the conversation key.
- **Security notes**: the audio, its type and duration are end-to-end encrypted; the server sees the
  attachment size and chunk count, like images. Body entries are validated on render (`cleanAudioAtt`:
  id pattern, allowed mime types, size ≤ 512 KB, duration, waveform pattern); the meta must say
  `kind: 'audio'` and an allowed mime before the decrypted bytes are played, from a `blob:` URL only.
  Forwarding does not copy voice messages (like images: they are encrypted under the source conversation).
- **Limits**: ≤ 512 KB (UI) inside the rules' 600,000-byte / 8 × 100,000-character chunk caps,
  ≤ 60 s (UI), one voice message per message (UI), uploads share the 24-per-10-minutes attachment limit
  (rules). No rules change.

## 17. Reminders

- **Purpose**: "Remind me…" in a message's More actions menu (`messageActions`) opens a dialog with
  In 20 minutes / In 1 hour / In 3 hours / Tomorrow at 9:00 / Custom (date and time) and an optional note.
  `/remind <when> <what>` (`slashCommands`) sets one for the conversation, e.g. `/remind 20m stretch`,
  `/remind tomorrow 9:00 standup`, `/remind fri 15:00 demo`, `/remind 2026-12-24 present` (relative
  `s/m/h/d/w`, clock times, `today`/`tomorrow`, weekdays, dates; never posted). A scheduler
  (`appMounts`) fires due reminders: it writes a notification to my notification center (the bell), shows
  a desktop notification when the tab isn't focused (respecting the desktop and preview settings), and
  shows an in-app card with Open message / Snooze / Done. Reminders that came due while no tab was open
  fire on the next load. The "Reminders" chat panel (header button ⏰, palette "Show reminders") lists Due,
  Upcoming and Done reminders with Open, Snooze (10 min, 1 h, 3 h, tomorrow 9:00), Done/Undo and Delete.
- **Data paths**: `udata/{me}/reminders/{id}` = `{ iv, ct, fired?: ms, done?: ms }` (generic block). Firing
  is a transaction on the record that sets `fired` only if nobody did, so one tab or device fires each
  reminder. Then `notifs/{me}/{nid}` = `{ kind: 'reminder', from: me, ts: now, ref: { sid, cid | dmId | gid, mid? } }`.
- **AAD strings**: `reminder:{uid}/{id}` (`sealForMe`): `{ due, note, conv: { kind, ids }, mid?, title,
  excerpt, author, createdAt }`.
- **Security notes**: everything the user typed or saw (note, message excerpt, author name, conversation
  title, due time) is sealed with the vault key. Plaintext: the `fired`/`done` timestamps and, in the
  notification, opaque ids only (no text), like every other notification.
- **Rules change** (121 bytes minified): `notifs/{uid}/{nid}` also accepts a new entry written by its owner
  with `from === auth.uid` and kind `reminder` (no notifLog stamp needed: it's your own list); `reminder`
  joins the kind list. A user still can't write any other kind to themselves or a reminder to anyone else.
  Client side `reminder` was added to `NOTIF_KINDS` (`lib/notifSend.js`) and `KIND_LABEL` (`lib/notifications.js`).
- **Limits**: 200 reminders per user, note ≤ 500 characters, at most a year ahead (UI). Reminders only fire
  while Codehub is open in a tab (no push on the Spark plan).

## 18. Message links and jump

- **Purpose**: "Copy link" (`messageActions`) copies an in-app link
  `{origin}{path}#/m/ch/{sid}/{cid}/{mid}`, `#/m/dm/{dmId}/{mid}` or `#/m/grp/{gid}/{mid}`. Message links in
  a message's text get a "Jump to message in #channel" chip under the message (`messageExtras`; the label
  shows `#channel` (plus the server name for another server), `@name` for DMs, or the group name).
  Clicking the chip or the link itself, opening the link in the address bar, or changing the hash to it
  opens the conversation and jumps to the message (a link opened before signing in is handled once the
  workspace loads). Modified clicks (Ctrl/⌘/Shift/middle) still open a new tab.
- **Data paths**: none written. Reads `servers/{sid}/channels/{cid}` or `userGroups/{me}/{gid}` for the
  access check.
- **Security notes**: a link only carries ids; opening it needs the same membership and keys as opening
  the conversation. Only links whose origin and path equal this app's are handled (`parseMessageLink`);
  others stay normal external links behind the link guard. The hash is removed from the address bar once
  read.

## 19. Run code snippets

- **Purpose**: messages with JavaScript, HTML or HTML + CSS code (fenced blocks with `js`/`javascript`/`html`/
  `css`, or a shared snippet with that language or file extension) get "Run …" buttons (`messageExtras`).
  Nothing runs until clicked. A message with an HTML block runs as one page with its CSS (in `<head>`) and
  JS (end of `<body>`) blocks; otherwise each JavaScript block runs on its own. The output panel under the
  message shows console output as text (log/info/warn/error, uncaught errors with line numbers), the
  rendered page for HTML, and Stop / Clear / Run again / Close.
- **Sandbox**: always `SandboxFrame` in preview mode: `sandbox="allow-scripts"` only (opaque origin, no
  access to the app, its storage or keys), the CSP meta with `connect-src 'none'` (no network), and the
  console bridge (token + `e.source` checked; text only, 200 lines). JavaScript runs in a Web Worker
  started inside the frame (blob: URL, falling back to a data: URL, then to the page itself), so a busy loop
  never blocks the app: the frame terminates the worker after 5 s ("Stopped: still running after 5 s"), and
  the parent removes the frame if no end report arrives 1.5 s later. An HTML page sends a heartbeat every
  500 ms; the parent removes the frame when none arrived for 5 s. Status markers travel as console lines
  with an invisible prefix and are never shown.
- **Limits**: 100,000 characters per runnable unit (UI). A page that blocks its own thread forever stalls
  the tab in browsers that run sandboxed frames in the app's process; the heartbeat guard removes it once
  the page yields.

## 20. Chat export

- **Purpose**: the "Export chat" panel (header button ⤓, palette "Export this conversation") exports the
  current channel, DM or group as Markdown or JSON: the whole history (paged from newest to oldest), a date
  range, or only the loaded messages. Messages are decrypted in this browser and saved as a download, with
  progress (loading, then decrypting N of M) and Cancel. The panel says plainly, before the button
  ("Export unencrypted file"), that the file is not encrypted.
- **Content**: author name, time, text, code (Markdown fences longer than any backtick run inside), images
  and voice messages as listed placeholders (not their bytes), GIF URL, poll question and options,
  forwarded-from, reply-to id, edited, pinned, reaction counts; deleted and undecryptable messages are marked.
- **Data paths**: reads `messages/{sid}/{cid}`, `dmMessages/{dmId}` or `groupMessages/{gid}` (pages of 200)
  and `users/{uid}/name`. Nothing is written.
- **Limits**: 20,000 messages per export (UI).

## 21. Drafts

- **Purpose**: unsent composer text is kept per conversation and restored when you come back (also after a
  reload). Conversations with a draft appear in a "Drafts" section with a pencil marker at the top of the
  channel sidebar (this server's channels) and of the DM sidebar (DMs and groups) (`sidebarSections`); the
  open conversation is left out. Sending (the composer becoming empty) clears the draft.
- **Data paths**: none in the database. `localStorage['codehub.drafts:{uid}']` =
  `{ [convKey]: { kind, sid?, cid?, dmId?, gid?, at, iv, ct } }`, convKey `ch:{sid}/{cid}` | `dm:{dmId}` | `grp:{gid}`.
- **AAD strings**: `draft:{uid}/{convKey}` with the vault key (`sealForMe`, local only): `{ text, title }`.
- **Security notes**: drafts never leave the browser. The text and the conversation title are sealed, so
  another person using the same browser profile after sign-out can't read them; conversation ids (the
  same kind of ids the app already keeps in localStorage for navigation) are plaintext so the sidebar can
  mark drafts without decrypting.
- **Limits**: 100 drafts per user (oldest dropped) and 8,000 characters per draft, saved 0.4 s after typing
  stops, when switching conversations and when the page is hidden.

## Rule bytes

One change (feature 17): 98,157 → 98,278 bytes minified (+121 of the 300-byte budget).

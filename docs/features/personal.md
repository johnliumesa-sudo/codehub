# Personal features (round 3, workstream `personal`)

Features 22 to 25: custom status, Do Not Disturb and auto-idle; favorites and server folders; private
notes on users; appearance settings. Code: `src/features/personal/` (pure helpers in `lib/*Core.js`,
unit-tested), plus small edits in core files listed at the end. Rule bytes used: **0** (generic
`udata` / `upub` blocks and the existing `presence` rule only).

## 22. Custom status, Do Not Disturb, auto-idle

**Purpose.** A status button in the user panel (next to the gear) opens a menu: Online, Idle, Do not
disturb, Invisible, and "Set a custom status…" (emoji + text up to 80 characters + "Clear after":
30 minutes, 1 hour, 4 hours, today, never; with presets). The same actions are in the command palette
("Set status: …", "Set a custom status…", "Clear custom status"). Other people see:

- the presence dot (green online, yellow idle, red with a bar for do not disturb, grey for offline) and
  the "Do not disturb" label in the member list, DM list, profile card, DM header, friends list and the
  composer's @mention list (`usePresence` now returns `'dnd'` too);
- the custom status (emoji + text) in the member list, group member list, DM list, profile card
  (`profileSections` entry `personal.status`) and the @mention list. It replaces the old profile status
  line while it is set.

**Auto-idle.** `src/lib/presence.js` writes `idle` after 10 minutes without input in *any* open Codehub
tab of this browser (the last input time is shared through `localStorage['codehub.activity']`; a hidden
tab receives no input, so it goes idle after 10 minutes too) and `online` again on the next input.
When another tab of mine closes, its `onDisconnect` marks me offline; the remaining tabs notice and
write their state again (at most every 5 s).

**Modes.** `online` and `dnd` use the automatic online/idle state; `idle` always writes `idle`;
`invisible` always writes `offline`. The first presence write of a session waits for the mode (up to
6 s), so an invisible user never flashes online.

**Do Not Disturb** suppresses desktop notifications for messages (`Notifier` in `lib/notify.js`), for
notification-center items (`useNotificationAlerts` in `lib/notifications.js`) and the incoming-call
ringtone (`IncomingCallModal`; the call card still shows). Unread badges, the bell count and the tab
title count are unchanged. The "Send a test notification" button in Settings still works.

**Data.**
| Path | Shape | Who |
|---|---|---|
| `udata/{me}/status/mode` | `'online' \| 'idle' \| 'dnd' \| 'invisible'` | private; read by `presence.js` |
| `upub/{uid}/status/now` | `{ mode?: 'dnd', emoji?, text?, until? }` | public to signed-in users; owner writes |
| `presence/{uid}` | unchanged: `{ state: 'online' \| 'idle' \| 'offline', lastChanged }` | |

A mode change is one multi-path update of `udata/{me}/status/mode` and `upub/{me}/status/now/mode`
(`dnd` or removed). `until` is a client timestamp: readers hide an expired status on their own, and the
owner's `PersonalHost` app mount deletes it when it expires (or on the next load).

**Security notes.**
- The custom status and the DND flag are **public plaintext** (any signed-in user can read `upub`).
  The status dialog says so.
- Invisible is never written anywhere public: presence says `offline` and `upub` carries no mode. Other
  signals still show activity while invisible: messages and reactions you send, typing indicators, call
  slots, and edits to your custom status (a public write).
- Records from other users are untrusted: `readCustomStatus` keeps only a single emoji grapheme
  (`\p{Extended_Pictographic}`, flags, keycaps) and one line of text without control or bidi
  characters, capped at 80 characters, and everything renders as React text.

**Limits.** Text 80 characters and one emoji (UI and readers; the `upub` rule caps strings at 2,000).
`presence` still only accepts `online | idle | offline`, which is why DND lives in `upub`.

## 23. Favorites and server folders

### Favorites
**Purpose.** Star text channels, DMs and groups; they appear in a collapsible "Favorites" section at the
top of both the server sidebar and the home (DM) sidebar (`sidebarSections` entry
`personal.favorites`), with the decrypted name, the server name / "Direct message" / "Group", unread dot
(muted conversations excluded, like elsewhere) and a presence dot for DMs. Ways to star: the star in a
channel row or DM row (hover or keyboard focus), the chat header button ("Add to Favorites" /
"Remove from Favorites", `chatHeaderButtons`), and the palette ("Add this conversation to Favorites").
Reorder by drag and drop, or with the "Move up" / "Move down" buttons on each row (also reachable by
keyboard); remove with ✕. A channel or group that disappeared shows "No longer available".

**Data.** `udata/{me}/favorites/{key}` = `{ kind: 'channel'|'dm'|'group', sid?, cid?, dmId?, gid?, pos }`
with `key` = `c_{sid}_{cid}` \| `d_{dmId}` \| `g_{gid}`. Ids only, no names; reading checks that the key
matches the record's ids. A reorder is one update of the changed `pos` fields.

**Limits.** 50 favorites (UI only). Collapsed state of the section: `localStorage['codehub.favoritesCollapsed']`.

### Server folders
**Purpose.** Group servers in the server rail into named, colored, collapsible folders. A folder sits
where its first server (in join order) would be. Collapsed folders show up to four mini server icons,
the unread pill if any server inside is unread, and the active pill if the open server is inside.
- Drag and drop: a server onto a folder (append) or onto a server inside a folder (insert before it),
  onto a server outside any folder (new folder with both), or onto the "Take out" drop zone that
  appears at the end of the rail while dragging a server out of a folder.
- Accessible menu alternative: right-click, Shift+F10 or the Menu key on a server: "New folder with this
  server…", "Move to “…”", "Take out of “…”", "Manage server folders…". On a folder: "Edit folder…",
  "Expand/Collapse", "Delete folder (keeps the servers)". The folder editor dialog (name, color radio
  group, server checklist) and "Manage server folders…" (palette) do everything without dragging.

**Data.** `udata/{me}/serverFolders/{fid}` = `{ iv, ct, color: '#rrggbb', sids: 'sid1,sid2,…', collapsed, at }`.
The name is sealed: `iv`/`ct` = `sealForMe('sfolder:{me}/{fid}', { name })`. Color, server id list,
collapsed flag and creation time are plaintext in my private `udata` (ids and flags only). Moving a
server is one update that also takes it out of any other folder; a folder left empty is deleted.

**Limits.** 30 folders, 32-character names (UI only). Servers I left are skipped on render and dropped
from the list on the folder's next write.

## 24. Private user notes

**Purpose.** A "Note" field on other people's profile cards (`profileSections` entry `personal.note`,
hidden on my own card). It saves on blur, Ctrl/⌘+Enter, or when the card closes, and shows
"Saving…/Saved". Users I have a note about get a small note icon next to their name in the server member
list and the group member list.

**Data.** `udata/{me}/userNotes/{uid}` = `sealForMe('unote:{me}/{uid}', { text })` stored as `{ iv, ct }`.
Emptying the note deletes it. The member-list icon only checks which keys exist (no decryption).

**Security notes.** Owner-only rules plus vault-key encryption: the subject, other users, admins and the
database operator can't read it. Decrypted text stays in memory only.

**Limits.** 1,000 characters (UI), control/bidi characters removed.

## 25. Appearance settings

**Purpose.** Settings → Appearance, below the theme picker: message density (cozy / compact), font size
90–130 % in 5 % steps (message text, names, composer and most of the interface), chat width (full /
1100 / 880 / 720 px for messages and composer), timestamps (automatic, 12-hour, 24-hour; chat message
times), reduce motion (also on whenever the device asks for reduced motion; the checkbox then shows it
locked on), high-contrast focus rings (3 px yellow ring with a dark halo in the dark theme, dark blue
with a white halo in the light theme), "Sync across my devices", and "Reset display settings". Palette:
"Appearance settings", "Toggle compact message density".

**How it applies.** Classes and attributes on `<html>`: `ap-compact`, `ap-font` + `--ap-font-scale`,
`ap-reduce-motion`, `ap-focus-rings`, `data-ap-width`, `data-ap-clock`. No flash on load:
`APPEARANCE_BOOT_SNIPPET` (`lib/appearanceCore.js`) is inlined in `index.html` right after the theme
script and sets them before the body exists; a unit test keeps the two identical and checks the snippet
produces exactly what the app applies. Other tabs follow through the `storage` event.

**Data.** `localStorage['codehub.appearance']` = `{ density, font, reduceMotion, focusRings, chatWidth,
clock, sync, seen, ts }`. With sync on: `udata/{me}/appearance/prefs` = the six settings + `ts`
(plaintext enums and numbers in owner-only data, nothing typed by the user). A device with sync on
uploads its changes and adopts a newer copy; a browser with nothing stored yet adopts an existing copy
(and turns sync on); turning sync off removes the copy, and a device that synced before and finds it
gone turns its own sync off.

## AAD strings (new kinds)
| Kind | Key | Used for |
|---|---|---|
| `sfolder:{uid}/{fid}` | vault key (`sealForMe`) | server folder name `{ name }` |
| `unote:{uid}/{subjectUid}` | vault key (`sealForMe`) | private note `{ text }` |

## Plaintext by design
Public: custom status emoji/text/expiry, the DND flag, presence (as before). Private to me but not
encrypted: status mode, favorites (conversation ids and order), folder colors / server id lists /
collapsed state, synced appearance settings.

## Core files touched (small edits)
- `src/lib/presence.js`: modes, 10-minute cross-tab auto-idle, self-heal after another tab closes,
  `'dnd'` from `upub` in `usePresence`; exports `getMyStatusMode`, `isDoNotDisturb`, `onStatusModeChange`.
- `src/lib/notify.js`, `src/lib/notifications.js`, `src/components/calls/IncomingCallModal.jsx`: DND checks.
- `src/components/layout/ui.jsx`: `PRESENCE_LABEL.dnd`.
- `src/components/layout/UserPanel.jsx`: status button, status line, my own dot (invisible / DND).
- `src/components/layout/ServerRail.jsx`: folders (`FolderedServers`), `RailButton` / `ServerIcon` accept
  drag, menu and hidden props and report unread / name / color.
- `src/components/layout/ChannelSidebar.jsx`, `DmSidebar.jsx`: star toggles; custom status in DM rows.
- `src/components/layout/MemberList.jsx`, `src/components/groups/GroupMembersPanel.jsx`: note icon and
  custom status in rows.
- `src/components/chat/Composer.jsx`: presence + custom status in the @mention list.
- `src/components/chat/Message.jsx`: 12/24-hour message times (`useClockFormat`).
- `src/components/settings/SettingsModal.jsx`: `AppearanceSettings` under the theme picker.
- `index.html`: the appearance boot script.

## Tests
- Rules: `tests/rules/personal.test.mjs` (status mode + public record, presence for modes, favorites,
  folders, notes, appearance sync, account cleanup).
- Unit: `tests/unit/personal.test.mjs` (status cleaning/expiry/effective presence, favorites keys and
  ordering, folder layout and moves, notes, appearance validation, clock formats, boot snippet vs. app).
- E2E: `tests/e2e/46-personal.spec.mjs` (two-user status/DND/invisible incl. muted desktop alerts with a
  positive control; auto-idle after 10 minutes (fake clock) and back on input; favorites and folders with keyboard menu, collapse and drag and drop; notes;
  appearance applied before paint, 24-hour times, reduced-motion media, sync upload and removal).

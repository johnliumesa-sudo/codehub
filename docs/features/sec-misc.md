# Round 3 security fixes: size/rate limits and smaller findings (sec-misc)

Fixes from the independent review of round 3 (`a186da5..fc30588`). The add-on runtime findings (A1, A3,
a1, a2) are a separate workstream (sec-addons). Each exploit the reviewer demonstrated is now a test.

| Finding | Fix | Where |
|---|---|---|
| R1 (medium) size and rate limits | `udata/{uid}`, `upub/{uid}` must be objects; `pub` and `sitems` field allowlists with per-field caps; a `pub` create must stamp the shared one-per-minute publish window, bound to one id | rules, `src/lib/ext/store.js`, bots/add-ons/discovery publish code |
| A2 (medium) AutoMod ReDoS | token glob matcher, no regex built from patterns; word length and work caps | `src/features/community/lib/automod.js` |
| M1 (medium) discovery publishes the server key | listing warning, "I understand" tick and a new unlist confirmation say plainly what it means; limit documented (no server key rotation exists) | `Discovery.jsx`, `community.md` |
| a4 (low) calls ghost pruning after a blip | `onDisconnect` stamps `hb` with the server time and sets `away`; clients only prune stale slots | rules, `src/lib/calls/*`, `calls.md` |
| a6 (low) assistant | names neutralised in prompts; "Share to chat" only in the conversation the answer came from | `assistant/lib/prompts.js`, `AssistantPanel.jsx`, `assistant.md` |
| a7 (low) bot welcome messages | every @mention in the welcome escaped; marked as an automatic bot welcome | `bots/lib/template.js`, `runtime.js`, `MessageParts.jsx`, `bots.md` |
| a5 (low) creator earnings farming | documented as a known limit (economy is cosmetic) | `shop.md` |

## R1: size and rate limits (generic rules blocks)

**What was possible.** Any signed-in user could write a 5 MB `pub/bots` entry (250 fields of 20,000
characters), create 150 `pub` entries in one update, write a 5 MB `sitems` event, and store a 2 MB
string directly at `udata/{uid}` or `upub/{uid}` (the `$feat` rules only apply below an object).

**Rules now.**
- `udata/$uid`, `upub/$uid`: `.validate: newData.hasChildren()` (deleting the whole node still works).
- `sitems/$sid/$feat/$id/$f`: `$f` must be one of `by iv ct s v ts` (exactly what events, RSVPs and the
  rules-accepted marker write); `ct` ≤ 20,000 characters, every other string ≤ 200. An item is at most
  about 21 KB.
- `pub/$kind/$id/$f`: `$f` must be one of `by ts name desc glyph def img imgType ver created icon version
  sha size perms seed rt code tags color members iid k` (every field bots, add-ons, add-on code and
  discovery listings write; `rt` is the add-on runtime version added by the sec-addons fix); `code` ≤ 65,536, `def` and `img` ≤ 20,000, every other string ≤ 1,000. An
  entry is at most about 145 KB.
- `pub/$kind/$id` create (`!data.exists()`): the same update must set `publishLog/{me}` = `now` (the
  existing path; its rule already enforces the 60 s window shared by games and community shop items),
  `publishLog/{me}` must not already equal `now` (so a second update in the same millisecond can't reuse
  the stamp), and `udata/{me}/pub/last` must equal `$id` (one stamp creates entries with one id: an
  add-on's `pub/addons/{id}` and `pub/addonCode/{id}` together, never a flood). App admins are exempt
  (they seed the first-party add-on examples back to back). Updates of an existing entry by its
  publisher are not rate-limited (they overwrite one bounded entry).

**Client.** `src/lib/ext/store.js` (additive): `PUB_FIELDS`, `SITEM_FIELDS`, `PUBLISH_WINDOW_MS`,
`pubCreateStamp(id)`, `commitPubCreate(patch)`, `pubCreateWaitLeft()`, `pubWaitText(ms)`; `putPub(kind,
id, fields, { create })` stamps creates itself (`create` defaults to "no id given"). A create this tab
knows would be refused fails early with "You can publish one new bot, add-on, server listing, game or
shop item per minute. Try again in N seconds."; a refusal from the rules says "Codehub refused to publish this" plus the same limit and "Wait a minute and try again." (the window
is shared with games and shop items, which this tab can't see). Bots (`publishBot` via `putPub`),
add-ons (`publishAddon`: new add-ons stamp, the admin examples tab passes `stamp: false`) and discovery
(`publishListing`: a new listing checks the window before creating its invite) use them.

**Data paths added.** `udata/{uid}/pub/last` = id of my last created `pub` entry (string). Removed with
`udata/{uid}` on account deletion; `publishLog/{uid}` stays, as before.

## A2: AutoMod without regex backtracking

See `community.md` "Matching without regex backtracking". Summary: tokens (word runs and single other
characters), word globs matched with anchored prefix/suffix and ordered `indexOf`, only positions
holding the pattern's first token tried, patterns whose literal tokens are absent skipped; words over
256 characters are checked on their first 256; a 2,000,000-comparison budget per message, after which
the message counts as breaking the word rule (fail closed). Existing caps: 200 patterns of 60
characters. A randomized test checks the matcher against the old regex on small inputs.

## M1: discovery and the server key

A listing must let strangers join, so it carries the server key. The warning, the "I understand" tick
and a new confirmation before unlisting (`alertdialog`, focus on Cancel, Esc cancels) now say: anyone
who read the listing can read the server's past and future messages, and unlisting does not make it
private again; only a new server would. Codehub has no server key rotation (only groups rotate keys),
so none is offered.

## a4: call slots survive a short blip

`armSlotDisconnect` registers `onDisconnect(slot).update({ hb: serverTimestamp(), away: true })`; each
heartbeat writes `{ hb: serverTimestamp(), away: null }`. Rules: `hb` must be `now` (0 is refused),
`away` must be `true`; removal by other members still requires `hb < now - 45000`, which now really
means 45 s. Clients (`canPruneSlot`): others' slots are removed only when stale (45 s); an away slot is
hidden (6 s without media in the call, 20 s in participant lists) but never removed before its grace;
my own away slot (a crashed tab of mine) can still be cleared when I join again.

## a6: assistant

`promptName()` cleans every display, forwarded-from and conversation name before it goes into a
prompt: one line, our delimiter tags neutralised (`<` → `‹`), no fake "(me)", ≤ 64 characters.
"Share to chat" appears only while the conversation the `/ask` question came from is open; elsewhere
the answer says where it was asked ("Asked in #general: open it to share this answer there.").

## a7: bot welcome messages

`welcomeDraft` runs `escapeMentions` on the rendered welcome: every `@name` outside code becomes
`\@name` (shown as "@name", no mention chip, no notification), including `@everyone`, `@here` and the
newcomer's own `{mention}`; e-mail-like `a@b` and code are untouched. The builder preview and hint
match. Readers see "Automatic bot welcome, posted from {name}'s account when they joined. They didn't
write it." under the message.

## Tests

- `tests/rules/sec-misc.test.mjs`: the reviewer's probes P1–P4 as deny tests, the legitimate writes of
  every feature, and the publish window (no stamp, wrong id, second create within 60 s, shared with
  games, updates without stamp, admin exemption).
- Updated to the new contract: `tests/rules/ext.test.mjs`, `bots.test.mjs`, `addons.test.mjs`,
  `community.test.mjs` (creates stamp the window), `calls.test.mjs` (away slots can't be pruned before
  45 s; a real `onDisconnect` stamps the server time). Helper: `pubStamp(uid, id)` in `helpers.mjs`.
- `tests/unit/sec-misc.test.mjs`: the reviewer's ReDoS pattern (< 50 ms up to 45,000 characters),
  adversarial patterns, the randomized comparison with the old regex, `slotLiveness` / `canPruneSlot`,
  `promptName` and transcripts, `escapeMentions`.
- e2e: `41-bots` (welcome note, no mention chip), `43-assistant` (no Share in another channel),
  `44-calls` (a crashed tab is hidden at once, its slot removed only after 45 s), `47-community`
  (warning text, unlist confirmation).

## Limits

Rule bytes: +551 (minified 100,218 → 100,769 of 102,400): `udata`/`upub` objects 72, `sitems` fields 35,
`pub` create stamp 267, `pub` fields and caps 127, calls `away`/`hb` 50.

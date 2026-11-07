# Bots (round 3, workstream `bots`)

Features 1–3: built-in slash commands, a no-code bot builder with a public directory, and bots
installed in servers. Code: `src/features/bots/` (registered from `index.js`). Tests:
`tests/unit/bots.test.mjs`, `tests/rules/bots.test.mjs`, `tests/e2e/41-bots.spec.mjs`.

**How bots run, plainly:** bots run in members' browsers. There is no bot server. A bot message is
written and sent by the member who triggered it (who used the command, whose message contained the
keyword, or who just joined), from their own account, and the message header says so
("Helper · BOT · via @Alice"). Bots can't act when nobody is online: nothing is scheduled, nothing
answers while the people involved are offline, and a member whose browser isn't running Codehub
never runs a bot.

Rule bytes used: **0** (only the generic blocks `pub`, `sconf` and `udata`; no rules were changed).

---

## 1. Slash commands and built-ins

**Purpose.** `slashCommands` entries (all conversation kinds, order 50, `group: 'builtin'`, so the "/"
menu lists them under "Built-in" with `/help`): `/shrug [text]`, `/tableflip [text]`,
`/unflip [text]`, `/me <action>` (the action in italics), `/roll [NdM]` (default `1d6`, also `d20`,
`2d6+3`; 1–100 dice, 2–1000 sides, modifier ±1000; posts e.g. "🎲 rolled 2d6: 3 + 5 = **8**"),
`/flip` (heads or tails), `/spoiler <text>` (a `||spoiler||`), `/poll` (opens the existing poll
creator) and `/gif <query>` (opens the existing GIF picker with the search filled in; refused with an
explanation when no GIPHY key is configured). Results are ordinary messages from the member. Every
command result carries the body extension key `cmd` (`{ cmd: 'roll' }`), and readers see a small
"used /roll" note under the message (`messageExtras`). A `/me` message never joins the header of
the member's previous ordinary message, so the italic action reads under their name.

**Randomness.** Dice, coins and `{random:…}` use `crypto.getRandomValues` with rejection sampling (no
modulo bias). The result is computed in the sender's browser and written into the message text; other
members can't verify it (a modified client could post any number). Don't use `/roll` for anything
that needs to be provably fair.

**Data.** Nothing new: the message body (end-to-end encrypted as usual) gains `cmd: string`
(`/^[a-z0-9][a-z0-9_-]{0,31}$/`, validated before rendering). `/poll` and `/gif` send the existing
`poll` / `gif` bodies plus `cmd`.

**Shared-file edit.** `src/components/media/GifPicker.jsx` gained an optional `initialQuery` prop
(additive; the composer's own GIF button is unchanged). The poll creator and GIF picker are rendered
by the bots composer host (below), not by Composer, so `Composer.jsx` is untouched.

---

## 2. Bot builder and public directory

**Purpose.** Settings → **Bots** (`userSettingsTabs` id `bots`; palette actions "Open the bot
directory" and "Create a bot"):
- **Directory**: every published bot, validated, with search (name, description, command names),
  sort (newest, recently updated, name), "Load more", details (all commands, triggers and the welcome
  message shown as plain text), **Report**, and for the publisher **Edit** / **Unpublish**, for app
  admins **Remove (app admin)**.
- **My bots**: my published bots (at most 20, a UI cap), Create / Edit / Unpublish.
- **Builder**: name (≤ 32), icon (emoji ≤ 16 chars, or a small image), description (≤ 300), up to 20
  slash commands (`/name` + arguments hint ≤ 40 + description ≤ 100 + response template ≤ 1500),
  up to 20 keyword triggers (word or phrase ≤ 100 → response ≤ 1500, cooldown 5–86400 s), an optional
  welcome message (≤ 1500), a live preview through the normal markdown renderer, and a size meter.
  Command names can't reuse the built-ins (`help`, `shrug`, … `gif`).

**Template language** (pure text substitution, no code; one pass, so text a member types is never
expanded again):

| Placeholder | Value |
|---|---|
| `{user}` | display name of the member who used the bot |
| `{mention}` | `@mention` of that member |
| `{channel}` / `{server}` | channel name / server name (decrypted in the member's browser) |
| `{args}` | everything typed after the command |
| `{arg1}`…`{arg9}` | one word typed after the command (`"double quotes"` group words) |
| `{random:a\|b\|c}` | one of the choices |
| `{dice:NdM}` | the total of a dice roll |
| `{date}` / `{time}` | the sender's local date / time |
| `{count}` | how many times this command or trigger ran, counted in the sender's browser (`localStorage`) |

Unknown placeholders stay as written. Everything a member typed (names, channel and server names,
arguments) is markdown-escaped: whitespace collapses to one line, and backslashes, backticks,
`*`, `_`, `~`, `[`, `]`, `|`, `<`, `>`, `:shortcode` colons, `@mention` at-signs and line-start
`#`, `-`, `+`, `=` and `1.` are backslash-escaped, so
input shows literally and can't add formatting, spoilers, links, emotes or mentions (including
`@everyone`). The bot author's own text is markdown, except that `@everyone` / `@here` in a template
are escaped too (a bot never mass-pings). Output is capped at 4000 characters and never starts with
`/` (it would run as a command).

**Data paths.**
- `pub/bots/{botId}` (generic `pub` block; signed-in read, publisher writes, publisher or app admin
  deletes, `ts` = server time on every write):
  `{ def, ver, name, desc, glyph, created, img?, imgType?, by, ts }`.
  `def` is the definition JSON string (≤ 20000 chars, one leaf):
  `{ v: 1, name, glyph, desc, commands: [{ name, usage, desc, response }], triggers: [{ id, match, response, cooldown }], welcome }`.
  `ver` starts at 1 and increases with every saved edit. `img` is base64 WebP/JPEG/PNG from the
  shared image pipeline (`processImage`: re-encoded, metadata stripped, ≤ 128 px, ≤ 14 KB so it fits a
  20000-char leaf), `imgType` its MIME type. Publishing a new bot (`putPub`) is one update that also
  stamps the shared one-per-minute publish window (`publishLog/{uid}` = now, `udata/{uid}/pub/last` =
  the bot id; round 3 security review R1); a second new bot (or add-on, listing, game or shop item)
  within a minute is refused with "Try again in N seconds". Saving a new version is not rate-limited.
  The rules accept only the fields above (plus the other `pub` kinds' fields) and cap every field
  except `def` and `img` at 1000 characters.
- Reports use the existing `reports` flow (`submitReport`, one per 30 s, app admins only) with kind
  `bot`, `target` = the bot id (`pub/bots/{botId}`) and the note prefixed with the reported version
  (`[vN]`). The admin reports queue shows the bot (avatar, name, version, publisher) and a "Remove bot"
  action through a `reportTargets` entry (`components/AdminReport.jsx`). The integration pass added the
  kind to the rules; earlier bot reports (kind `user`, target = the publisher) still show as user reports.

**AAD strings.** None: directory entries are public plaintext by design (like games and shop items);
anyone signed in can read every bot definition. The builder says so.

**Security notes.** Definitions are untrusted: `parseBotEntry` / `parseBotDef` check the size first,
then JSON, then the schema (types, lengths, control characters, name patterns, unique command names
and trigger ids, cooldown range, total size) and drop unknown keys; invalid entries are hidden from
everyone except their publisher and app admins (who can remove them). Names, descriptions and
templates render as React text; only the builder's preview and bot messages go through the existing
DOMPurify markdown path. Images render only through `dataUrl()` (MIME allow-list, base64 check,
≤ 512 px header check).

---

## 3. Bots in servers

**Purpose.** Server settings → **Bots** (`serverSettingsTabs` id `bots`; palette "Manage this
server’s bots"): everyone sees the installed bots with their commands, triggers and welcome message;
members with **Manage apps** (owner, admins, custom roles with `manageApps`) add bots from the
directory (at most 25 per server, a UI cap), see **Update available (vN)** when the publisher saved a
newer version and apply it, see "No longer in the directory" when it was unpublished (the pinned copy
keeps working), and uninstall.

In the server's channels (the composer host, a `composerButtons` render entry that draws nothing
itself):
- **Commands**: each installed bot's commands are registered as `slashCommands` (scope `channel`,
  `group: 'bot'`, listed last in the "/" menu under "Bots in this server", order 100+, so built-in commands, other features' commands and earlier installs win a name) while a channel of that server is open, and
  unregistered when it closes. Running one turns the member's message into the bot's reply: body
  `extra.bot = { id, name, glyph, via: 'cmd' }` and `cmd = name`.
- **Keyword triggers** (`sendHooks` id `bots.triggers`, order 1e6 so it sees the final text): when my
  own outgoing channel message contains a trigger phrase (whole words, any case, not inside code), my
  browser queues the reply (`via: 'trigger'`, `trig: id`) and sends it as a separate message right
  after my message appears, so it always lands below it. At most one reply per message (first match
  in install order, then trigger order); messages carrying `bot` never trigger anything; a trigger
  answers again only after its cooldown, checked against the loaded channel history (any member's
  reply counts, so the cooldown is channel-wide) and against this browser's own record. In a
  slowmode channel trigger replies are skipped for members without `manageMessages` (a second message
  would be refused).
- **Welcome messages**: when a member who joined after the bot was installed first opens the
  server's first text channel (the one the sidebar lists first), their browser claims
  `udata/{me}/botWelcome/{sid}~{botId}` with a transaction (so two tabs can't both post) and posts the
  bot's welcome (`via: 'welcome'`). Once per member per bot; at most 3 welcome messages per join (any
  further bots' welcomes are skipped). In a slowmode channel the welcome is shown to the new member
  only (an "Only you can see this" card) instead of being posted. Because the newcomer didn't choose to
  send it, a welcome never mentions anyone (round 3 security review a7): `welcomeDraft` escapes every
  `@mention` outside code (`escapeMentions`: `@name` becomes `\@name`, which shows "@name" as plain
  text and notifies nobody, the newcomer's own `{mention}` included; e-mail-like `a@b` and code are left
  alone), and the builder's preview and hint show the same.

**How a bot message looks.** `messageBadges` entry `bots.badge`: for a bot installed in this server
the header reads "🛠 **Helper** · BOT · via @Alice" (the installed copy's name and icon, chosen by the
server's managers; the plain author name is hidden because "via @Alice" names the real author), and
bot messages start their own header group. A message whose `bot` names a bot this server doesn't have
(uninstalled since, or forged by a member) keeps the real author first and is marked "(not installed
here)". A small note under the message says "used /hello", "replied to a keyword", or for a welcome
"Automatic bot welcome, posted from Bob's account when they joined. They didn't write it." (italic).

**Data paths.**
- `sconf/{sid}/bots/{botId}` (generic `sconf` block; members read; owner, admins and `manageApps`
  write): the pinned copy `{ def, ver, by (publisher uid), author (installer uid), at (install time,
  server timestamp; kept on update), img?, imgType? }`. Validated on read like the directory
  (`parseInstalled`); invalid copies never run.
- `udata/{uid}/botWelcome/{sid}~{botId}` = ms timestamp: my welcome for that bot was handled.
- Message body extension keys (inside the end-to-end encrypted body): `bot: { id, name, glyph?,
  via: 'cmd'|'trigger'|'welcome', trig? }` and `cmd`. Validated with `cleanBotTag` / `cleanCmd`
  before rendering; rendered as React text.
- Local only (`localStorage`, never the database): `codehub.bots.counts` (`{count}` counters) and
  `codehub.bots.cooldowns` (this browser's trigger cooldowns).

**AAD strings.** None new. Bot replies are ordinary channel messages (`msg:{sid}/{cid}/{mid}:{uid}`).
The pinned copy in `sconf` is plaintext by design: it is a copy of a public directory entry, so it
reveals nothing that isn't already public except *which* bots a server installed (visible to the
database, like other server configuration metadata).

**Security notes.**
- A bot message is authored by a member; it has exactly that member's rights (membership, timeouts,
  slowmode and every send hook such as AutoMod apply). Bots add no new write path.
- Because the member's browser composes the reply, a modified client can post anything with a `bot`
  tag. Readers therefore only show a bot's name/icon from the server's installed copy, keep "via
  @member" visible, and mark tags of bots that aren't installed.
- Commands only run in channels of the server that installed the bot (checked again at run time) and
  only with the installed copy's current definition.
- Trigger phrases are matched with escaped literal regexes (no user-controlled patterns).

## Limits (UI-enforced unless noted)

| What | Limit |
|---|---|
| Definition JSON / image base64 | ≤ 20000 chars each (rules: one generic-block leaf) |
| Name / icon / description | 32 / 16 / 300 chars |
| Commands / triggers per bot | 20 / 20 |
| Response templates / welcome | 1500 chars each; rendered output ≤ 4000 |
| Trigger cooldown | 5–86400 s |
| Bots per publisher / per server | 20 / 25 |
| Welcome messages per join | 3 |
| Image | ≤ 128 px, ≤ 14 KB (WebP/JPEG/PNG, re-encoded) |
| `/roll` | 1–100 dice, 2–1000 sides, modifier ±1000 |

Other limits: `{count}` and cooldowns are per browser (a member on two devices counts twice); the
channel-wide cooldown only sees loaded history; a trigger reply whose original message is refused
or doesn't appear within 20 s is dropped; nothing runs while nobody is online.

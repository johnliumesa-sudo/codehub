# Community features (round 3, workstream `community`)

Server events with RSVP (26), server templates (27), the welcome screen and rules gate (28), server
discovery (29) and AutoMod (30). Code: `src/features/community/` (pure logic in `lib/*.js`, database
access in `lib/data.js`, UI in `components/`). Everything is registered from
`src/features/community/index.js`; no shared hot file was edited.

## AAD strings

| Kind | Key | AAD | Plaintext JSON |
|---|---|---|---|
| Event | server key | `event:{sid}/{id}` | `{ title, desc, start, end, loc, color, cancelled?, rid?, orig? }` |
| Welcome screen | server key | `welcome:{sid}/msg` | `{ text, rules: [] }` |
| AutoMod config | server key | `automod:{sid}/cfg` | `{ words: [], invites, links, maxMentions, caps, action, exemptMods }` |
| Saved template | vault key (`sealForMe`) | `tmpl:{uid}/{tid}` | template (below) |
| Category names (templates) | server key | `category:{sid}/{catId}` (existing serverx string) | `{ name }` |

## Rules (database.rules.json)

Two additions, **272 bytes** of the 300-byte budget (minified total 98,429):

1. `messages/{sid}/{cid}/{mid}` create: when `sconf/{sid}/welcome/req === true`, the author must be the
   owner or an admin, or have `sitems/{sid}/accepted/{auth.uid}/by === auth.uid`. Edits, deletes,
   reactions and votes are not gated.
2. `sitems/{sid}/{feat}/{id}` `.validate`: for the features `accepted` and `rsvp`, the key must end
   with the writer's uid (`$id.endsWith(auth.uid)`). Without it, any member could create
   `accepted/{victim}` or `rsvp/{event}~{victim}` first and lock the victim out (the generic block only
   lets the author update an item). Deletes are not validated, so moderators can still remove them.

Everything else uses the generic blocks (`sconf`, `sitems`, `udata`, `pub`).

---

## 26. Server events with RSVP

**Purpose.** Members plan events (title, description, start/end, place = a voice channel or free text,
cover color) and answer Going / Maybe / Can't go.
- `sidebarSections` `community.events`: the next event of the server (time, place, going count, "Join
  voice" when it is on), buttons for a new event and all events, and a "Welcome & rules" link.
- `chatHeaderButtons` + `chatPanels` `community.events`: Upcoming / Past lists with full cards.
- `slashCommands` `/event [title]` (channels): opens the creator; "Announce it in #channel" posts a
  message whose body carries `srvEvent: { id }`, rendered as a live event card (`messageExtras`
  `community.event`).
- `appMounts` `community.host`: the creator, a detail modal and the reminder scheduler.
- `paletteActions`: "New server event", "Show server events".
- Cards: RSVP buttons with counts, who is coming, "Join voice" from 10 minutes before the start until
  the end (exactly like clicking the voice channel: `WorkspaceContext.openVoice` shows the server, joins
  without ringing and opens the call view; an open event dialog closes), "Add to
  calendar" (a local `.ics` download), "Share in chat", and Edit / Cancel event / Delete for the
  organizer and members with `manageMessages`.
- Reminders: 15 minutes before the start of an event I'm going to, an in-app card (Join voice / View
  event / Dismiss) and, if desktop notifications are on in my notification settings and I'm not in Do
  Not Disturb, a desktop notification (the title only when message previews are on; never the description). They fire while a Codehub tab is open; a reminder missed
  while offline fires on the next load as long as the event has not started. Fired reminders are
  remembered per device in `localStorage['codehub.eventReminders']` (ids only, pruned after 3 days).

**Data.**
```
sitems/{sid}/events/{id}        { by, iv, ct }                        // sealed body, see AAD table
sitems/{sid}/rsvp/{rid}~{uid}   { by: uid, s: 'going'|'maybe'|'not', ts }
udata/{uid}/rsvp/{sid}~{rid}    'going'|'maybe'|'not'                 // my index, drives reminders
```
`rid` is the id RSVPs are keyed by: the event's own id, except for a moderator's copy (below).
Answers are written together with my index in one update. Clients read RSVPs by `by` (a key whose uid
differs from `by` is ignored; the rules prevent it anyway), one answer per member and event.

**Editing.** The generic block lets only the author update an item. The organizer edits and cancels in
place. A moderator (`manageMessages`, owner, admins) editing or cancelling someone else's event replaces
it in one update: a new record by the moderator whose body keeps `rid` (so the answers stay) and
`orig` = the original organizer, and the old record deleted. Cards show "Organized by X · edited by Y"
only if the record's author really has `manageMessages` (otherwise `orig` is ignored), and a copy's
`rid` is ignored while an event with that id still exists. Deleting: the organizer removes the event
and their own answer; a moderator also removes every answer to it.

**Security.** Title, description, time, place and color are end-to-end encrypted (server key). Plaintext:
the event's author uid, and who answered what (like poll votes), with client timestamps. Bodies from
other members are validated (`sanitizeEvent`: types, lengths, times, `#rrggbb`, voice channel id
format) and rendered as React text.

**Limits.** Title 100, description 2000, free-text place 100 characters; an event lasts at most 7 days
and starts at most two years ahead (new events not more than a day in the past). UI cap: 200 stored
events per server (the rules can't count). Answers to an event deleted by a non-moderator organizer
stay behind as small orphans until a moderator or the server deletion clears them.

## 27. Server templates

**Purpose.** "Add a server" offers "Start from a template" (`serverCreateOptions`
`community.templates`): Study group, Open-source project, Game jam, Hackathon and Friends, plus my saved
templates. Each sets up text / code / voice channels with topics, categories, roles (name, color,
position, permissions), a welcome screen (the Hackathon one turns on the rules gate) and a first
message in the first text channel. The server is created in one update by `createWith`; categories
(and each channel's `cat`) follow in one update, then roles, the welcome screen and the message.
"Template" in server settings (`serverSettingsTabs` `community.template`, every member) saves the
current server's structure as a private template and lists / deletes saved ones.

**Data.** `udata/{uid}/templates/{tid}` = `{ iv, ct }` (vault key, `tmpl:{uid}/{tid}`).
```
{ v: 1, name, desc?, icon?, serverName?, color?,
  categories: [{ key, name }], channels: [{ type, name, topic?, cat? }],
  roles: [{ name, color, position, perms }], welcome?: { text, rules, require }, message? }
```
Structure only: no messages, members, invites, emotes, keys, AutoMod settings or events.

**Security.** Saved templates are readable only by me (vault key). Templates are validated on read
(`cleanTemplate`: names, channel types, category keys, role positions 1..899, known permission flags).

**Limits.** 50 channels, 20 categories, 20 roles per template; 20 saved templates (UI). If a sealed
template would not fit one 20,000-character leaf, it is saved without channel topics (the UI says so).

## 28. Welcome screen & rules gate

**Purpose.** Managers (`manageApps`: owner, admins, custom roles with the flag) write a welcome message
(Markdown), a rules list and "Require members to accept the rules before posting" in the server
settings tab "Welcome" (`serverSettingsTabs` `community.welcome`), with a live preview, an accepted
count and, for moderators, "Make everyone accept again" (deletes the markers). New members see the
welcome modal on their first visit (`appMounts`); with acceptance required they must press "I accept
the rules" before they can post. Until then the composer shows a local notice ("Accept the rules to
post", with a button that opens the rules), the `community.gate` send hook refuses sends with an
explanation, and the database refuses the message anyway. A "Server rules" button in the composer
(`composerButtons` `community.bridge`) and the sidebar link reopen it. Owners and admins are exempt.
When the welcome screen is saved with "Show it again", members who saw (or accepted) an older version
see it again; with acceptance required they are asked to accept the new version (client-side
re-prompt; the database still accepts their earlier marker).

**Data.**
```
sconf/{sid}/welcome/msg         { iv, ct, v, by }   // v = version (ms), by = who saved it
sconf/{sid}/welcome/req         true                // absent = not required
sitems/{sid}/accepted/{uid}     { by: uid, v, ts }  // the marker the rules check
udata/{uid}/welcomeSeen/{sid}   v                   // the version I've seen
```

**Security.** The text and rules are end-to-end encrypted. The gate itself is enforced by the database
rules (above). Plaintext: whether acceptance is required, who accepted and when (client time), the
welcome version number and who saved it. Welcome text is rendered through the existing DOMPurify
Markdown path; rules are React text.

**Limits.** Welcome text 2000 characters, 25 rules of 300 characters.

## 29. Server discovery

**Purpose.** Owners list a server publicly from the server settings tab "Discovery"
(`serverSettingsTabs` `community.discovery`; managers see the status read-only): public name,
description, up to 5 tags, an icon (emoji or letters) and color, with a preview. A warning says plainly
that listing publishes an invite: anyone signed in can join and read every message, including older
ones; listing needs an "I understand" tick. The "Discover servers" view (search, tag filter, sort by
members or recently updated) opens from "Add a server" in the server rail (`serverCreateOptions`
`community.discover`) and from the palette ("Discover public servers"). "Join" uses the existing invite
flow (it sets `#/join/{sid}/{iid}/{key}`, so the app's "You've been invited" dialog takes over);
servers I'm already in show "Open". App admins can remove a listing from the directory. Unlisting
removes the listing and revokes its invite in one update.

**Data.**
```
pub/servers/{sid}               { name, desc, tags: 'a,b', glyph, color, members, iid, k, by, ts }   // PLAINTEXT
servers/{sid}/invites/{iid}     the dedicated invite: no expiry, no use limit
sconf/{sid}/discovery/listing   { iid }
```
`k` is the server key (the same key every invite link carries after `#`). The member count is a
snapshot, refreshed when the listing is saved or the owner opens the Discovery tab. Creating and
revoking the invite are written to the audit log ("public discovery listing").

**Security.** Only the server's owner can write `pub/servers/{sid}` (rules); listings are sanitized on
read (`sanitizeListing`) and rendered as React text. Unlisting revokes the invite but cannot take back
the key: people who joined stay members (remove them from Members if needed); non-members still can't
read anything without joining. If the invite is revoked elsewhere (Invites tab), the Discovery tab says
so and offers "Create a new invite". Deleting the server removes the listing.

**Limits.** Name 64, description 300 characters, 5 tags of 20; the directory loads the 200 most recently
updated listings.

## 30. AutoMod (client-enforced)

**Purpose.** Managers (`manageApps`) configure, in the server settings tab "AutoMod"
(`serverSettingsTabs` `community.automod`): blocked words and phrases (one per line; whole words,
case- and accent-insensitive; `*` matches any letters, e.g. `spam*`, `*coin`), block invite links
(Codehub `#/join/` links and common chat-app invites), block all links (anything the renderer would
link, plus GIFs and invite cards), max mentions per message, max percentage of capital letters (messages
with at least 12 letters), and the action: block sending with an explanation, or allow but hide for
readers. A "Try a message" box shows the verdict live. Moderators (`manageMessages` or `manageApps`)
can be exempted; owners and admins always are.
- Sender: the `community.automod` send hook (runs after the other hooks) refuses a breaking message
  with the reason ("block"), or sends it and warns that it is hidden from others ("hide").
- Readers: `messageExtras` `community.automod` checks every server message against the current config
  and, when it breaks a rule, collapses it to "Hidden by AutoMod: reason · Show message" (CSS `:has()`
  hides the body and other extras). The author sees their own message with a note.

**It runs in members' browsers.** Messages are end-to-end encrypted, so nothing on the server can check
them. A modified client can skip the send check; readers' apps still hide breaking messages. The
settings tab says this. Edited messages are not checked when sent, only when shown.

**Data.** `sconf/{sid}/automod/cfg` = `{ iv, ct }` (server key, `automod:{sid}/cfg`); absent = off.

**Security.** The word list is end-to-end encrypted, and the notices never repeat the matched word.
Reply previews and search results of a hidden message still show its text (only the message itself is
collapsed).

**Limits.** 200 patterns of 60 characters; max mentions 0..50; caps 0 (off) or 50..100 %.

---

## Notes for other workstreams
- Generic-block feature names taken: `sconf` `welcome`, `automod`, `discovery`; `sitems` `events`,
  `rsvp`, `accepted` (the last two are key-bound by the rules); `udata` `rsvp`, `welcomeSeen`,
  `templates`; `pub` `servers`.
- Body extra key used: `srvEvent` (`{ id }`), validated before rendering.
- Send hooks: `community.gate` (order -1e8) and `community.automod` (order 1e6).
- Event reminders call `showNotification` from `lib/notify.js` directly when desktop notifications are
  on; if a Do-Not-Disturb mode should silence them, route them through it.

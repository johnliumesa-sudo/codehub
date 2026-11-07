# Codehub

An end-to-end-encrypted, Discord-style chat app with a real-time code collaboration tab.
Servers, text channels, DMs, reactions, replies, pins, typing indicators and presence on the
chat side; a shared CodeMirror editor backed by Yjs, plus a GitHub panel (browse, diff, commit,
branch, pull request) on the collab side.

Built with Vite + React 18 and Firebase. It uses **Email/Password and Google Authentication** and the
**Realtime Database**. No Firestore, Storage or Cloud Functions. Every security property is enforced by
`database.rules.json`; the client is untrusted.

### Features

End-to-end encrypted (the server only stores ciphertext):

- **Servers, channels and DMs** with Markdown, code snippets, reactions, replies, pins, mentions and typing indicators.
- **Private group chats**: up to 25 people, owner-managed. A fresh group key is created whenever someone is removed or leaves.
- **Code workspaces** inside servers, plus standalone **Codespaces** with owner/editor/viewer roles. Both are real-time
  CodeMirror + Yjs editors with a GitHub panel (browse, diff, commit, branch, pull request). Codespaces start from
  **templates**: blank, web starter, canvas game, snake, markdown notes.
- **Checkpoints**: named versions of a file you can restore. **Zip export and import** of a workspace.
- **Personal snippet library**, encrypted with your vault key. Insert snippets into the editor or the chat composer.
- **Server roles** with eight permissions, **timeouts**, and an **encrypted moderation audit log**.

Other features:

- **Live preview and run console** for HTML/CSS/JS/Markdown in a sandboxed iframe. It runs locally and nothing is uploaded.
- **Arcade**: publish a workspace as a **public** game that anyone signed in can play, like or report. Games are plaintext.
- **Add-on shop**: daily coins, app themes, editor themes, editor add-ons, name colors and badges. Data only, plaintext.
- **App admins** (promo code), **global announcement banner**, and **reports** to app admins.
- **Safety**:
  - blocking, enforced by the rules for DMs and friend requests;
  - verified contacts and key-change alerts;
  - a confirmation prompt before opening external links;
  - desktop notifications with per-conversation, per-server and timed mute.
- **Command palette / quick switcher**: Ctrl/⌘ K.

---

## Voice/video calls, notifications, media and themes

- **Calls:** 1:1 DM calls, group calls and drop-in server voice channels (create a channel of type *Voice*). WebRTC full mesh, up to 6 people, with mic/camera/screen share. Signaling is end-to-end encrypted with the conversation key. Peers see each other's IP addresses; calls only ring while the app is open (no push).
- **Notification center:** bell in the header; mentions, replies, DMs, group adds, friend requests, role changes, game likes and call rings. Stores only ids and kinds, never message text.
- **Media:** profile pictures, server icons, custom server emotes (`:name:`), encrypted image attachments (paste or button; up to 4 per message) and GIPHY GIFs. No video upload (stays on the free Spark plan).
- **Theme:** dark / light / system toggle in Settings -> Appearance.

### Admin setup for GIPHY and TURN
1. Get a GIPHY API key at developers.giphy.com. In the app, open Admin panel -> *GIFs & calls* and paste it. The key is readable by every signed-in user (any browser-side key is). Without a key the GIF button is hidden.
2. Optional TURN servers (up to 4) in the same form, for users behind strict NATs. TURN credentials are also client-visible; use a restricted/time-limited account. Without TURN, calls use Google STUN only and some networks will fail to connect.
3. GIPHY sees viewers' IP addresses and search terms.

## Round 3 features

Built on the round 3 extension points (ARCHITECTURE.md, "Round 3: extension points"). Each feature is
documented in [`docs/features/`](docs/features/).

## Chat and server extras

- **Polls** (📊 in the composer), **spoilers** (`||hidden||`, click to reveal), **saved messages** (🔖 on a message; 🔖 in the header lists them, encrypted to your vault) and a "Forwarded" tag on forwarded messages.
- **Slowmode** per text channel (channel settings; moderators are exempt), **channel categories** (server menu → Manage categories; names are encrypted), **profile bio, pronouns, links and banner color** (Settings → My profile), and a **keyboard shortcut overlay** (press `?`).
- Plaintext by design: poll vote indices (not the option text), slowmode timers, category order, profile bio/pronouns/links. Poll votes can be read by any signed-in user who knows the message id.

## 1. Setup

### Firebase project (already done)

The app is already wired to Firebase project `codehub-dc9a4` (`src/lib/firebase.js`,
`.firebaserc`). In that project you have already:

- enabled **Authentication → Sign-in method → Email/Password** and **Google**, and
- created a **Realtime Database** (`https://codehub-dc9a4-default-rtdb.firebaseio.com`).

That is everything the app needs. The site is hosted on GitHub Pages (see section 3).

> The Firebase web config in `src/lib/firebase.js` is public by design. Access is enforced by
> `database.rules.json`, so **deploy the rules before you invite anyone** (section 2).

### Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173). `localhost` is an authorized auth
domain by default. If you serve from another host, add it under
**Authentication → Settings → Authorized domains**.

First run:

1. **Sign up** with email and password, or **Continue with Google**. Your encryption keys are
   created and unlocked automatically; there is no separate passphrase.
2. Add friends from the **Friends** page (home screen), create a server, and invite friends by DM
   from **Server menu → Invite people**, or share an invite link.

### App admin promo code (project owner, one time)

App admins can do four things: manage the shop catalog, unpublish games, review reports and post the global
announcement. A user becomes an admin by entering a secret code in **Settings → Codes & admin**. The code is never
part of the app or this repository. To set it:

1. Open **Firebase console → Realtime Database → Data**.
2. Under the root, add the key **`config`**. Under `config`, add the child **`adminPromo`** with a string value.
3. Make the value a **long random string**: 32 or more random characters, generated with a password manager.
   Never commit it, put it in code or paste it in chat. Share it only with the people who should become admins.

Nobody can become an admin until the key exists and is at least 8 characters long; the rules ignore a shorter code. The rules make `config`
unreadable and unwritable for every client, so it can only be changed in the console. To revoke an admin, delete
`admins/{uid}` and `adminBadges/{uid}` in the console. Rotating the code does not demote existing admins.

After becoming an admin, open **Admin panel → Catalog → Seed default catalog** to fill the shop with the bundled items.

### Test locally against emulators

`npm run emulators` (needs Java) starts the Auth and Database emulators with `database.rules.json`;
`npm run dev:emu` serves the app on http://localhost:5174 against them. Nothing touches the live
project, so you can sign up throwaway test accounts in two browser windows.

---

## 2. Deploy the database rules

A new Realtime Database starts in "locked" or "test" mode. Neither will work correctly with
Codehub, and test mode leaves everything open. Replace those rules with `database.rules.json`.

### Option A: Firebase CLI (recommended)

No global install is needed. `npx` runs the CLI on demand:

```bash
npx firebase-tools login
npx firebase-tools deploy --only database   # or: npm run deploy
```

`firebase.json` already points at `database.rules.json`, and `.firebaserc` already selects
`codehub-dc9a4`.

### Option B: Paste the rules into the console

The console cuts pastes off at 100 KiB (102,400 bytes) and `database.rules.json` is bigger than
that, so paste the minified copy instead:

1. Run `npm run -s rules:min | pbcopy` (macOS; elsewhere redirect to a file). It prints the size and
   warns if it is still too big, in which case use Option A.
2. Open **Firebase console → Realtime Database → Rules**.
3. Replace the whole editor contents with the copied rules.
4. Click **Publish**.

The minifier strips whitespace, merges `.child()` chains, renames `$wildcards` to short names and writes
`===`/`!==` as `==`/`!=` (identical in database rules). To check a minified copy, save it
to a file and run `RULES_PATH=<file> npm run test:rules`.

### Tests

`npm test` runs everything against local emulators (needs Java, and Node 20 or 22 for the browser tests):
`npm run test:unit` (pure helpers), `npm run test:rules` (security rules on the Database emulator) and
`npm run test:e2e` (Playwright: real sign-ups, chat, and two- and three-browser voice/video calls with a
fake camera and microphone).

Several checkouts can run tests at the same time on separate ports: set `CODEHUB_PORT_BASE` (default
9000 = database 9000, auth 9099, Vite 5199). A base `B` such as 9100, 9200 … uses database `B`, auth
`B+99`, Vite `B+80`, emulator hub `B+50` and logging `B+51`; the runner writes a gitignored
`firebase.test-<B>.json` and only stops processes on its own ports. Pass files to run a subset:

```bash
CODEHUB_PORT_BASE=9300 npm run test:rules -- tests/rules/ext.test.mjs
CODEHUB_PORT_BASE=9300 npm run test:e2e -- 40-ext
node scripts/test-env.mjs ports   # this block's ports; `kill` stops leftovers on them
```

The console also has a **Rules Playground** for testing reads and writes as a specific uid.

> Re-deploy the rules any time `database.rules.json` changes. The rules define indexes
> (`users/name`, `ts`, `pinned`, `uid`, `lastTs`, `createdAt`, `likes`, `ownerId`) too. Without them, queries still work but download more
> data and log index warnings.

---

## 3. Hosting on GitHub Pages

`.github/workflows/deploy.yml` builds the app and publishes `dist/` to GitHub Pages on every push
to `main`. `vite.config.js` uses `base: './'`, so the site works from the repo sub-path
(`https://<user>.github.io/codehub/`). Invite links use the `#` fragment, so no 404 fallback is needed.

One-time setup:

1. In the GitHub repo, open **Settings → Pages → Source** and choose **GitHub Actions**.
2. In Firebase, open **Authentication → Settings → Authorized domains** and add `<user>.github.io`.
3. Deploy the database rules (section 2). Pages only hosts the static site; rules always go to Firebase.

Optional: in Google Cloud Console → **APIs & Services → Credentials**, restrict the Firebase API key
to the HTTP referrers `https://<user>.github.io/*` and `http://localhost:5173/*`.

---

## 4. GitHub token (optional)

You can browse and open files from public repositories without a token (read-only and
rate-limited). You need a token to commit, create branches, open pull requests or read private
repositories.

Create a **fine-grained personal access token**:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**.
2. **Repository access:** choose **Only select repositories** and pick the repositories you will
   link to workspaces. Avoid "All repositories".
3. **Repository permissions:**
   - **Contents: Read and write** (read files and trees; commit files; create branches)
   - **Pull requests: Read and write** (list and open PRs)
   - **Metadata: Read-only** (GitHub adds this automatically)
   - Optional: **Issues: Read-only** to list issues in the GitHub panel.
4. Set a short **expiration** (for example 30 to 90 days).
5. In Codehub open **Settings → GitHub**, paste the token, then **Save** and **Test**.

The token is encrypted with your vault key before it is stored (`vaults/{uid}/ghToken`). It is
decrypted only in your browser and sent only to `api.github.com`. Each person uses their own
token, and commits are authored as that person.

---

## 5. Security model

### What is end-to-end encrypted

Every ciphertext is AES-256-GCM, created and read only in the browser (WebCrypto). The Firebase
server, and anyone with database access, sees only `{ iv, ct }`.

| Data | Key |
| --- | --- |
| Channel messages, edits, code snippets | Server (room) key |
| Server names, channel names and topics | Server key |
| Collab file paths and contents (Yjs updates and snapshots), cursors and selections, linked repo name | Server key |
| Direct messages | Per-pair DM key: ECDH(P-256) + HKDF |
| Your private identity key, GitHub token, personal snippets | Vault key: random AES-256 key stored at `vaults/{uid}/autoKey`, readable only by you |
| Group names and messages | Per-group key, a new random key per **epoch**, ECIES-wrapped for each member |
| Codespace names, files, cursors, repo link, checkpoints | Per-codespace key, ECIES-wrapped for each member |
| Workspace checkpoints, custom role names, moderation audit entries | Server key |

- **Identity:** each user has an ECDH P-256 key pair. The public key is published at
  `users/{uid}/pubKey`. The private key exists only encrypted in your vault and, once you unlock,
  in memory.
- **Server keys:** each server has a random AES-256 key. Every member stores a copy wrapped to
  their own public key (`servers/{sid}/keys/{uid}`, ECIES).
- **Invite links** carry the server key in the URL **fragment**
  (`#/join/{sid}/{inviteId}/{key}`). Browsers never send the fragment to any server, so Firebase
  never sees it. Anyone holding the full link can read that server, so share links privately.
- **Associated data (AAD)** binds each ciphertext to its location, for example
  `msg:{sid}/{cid}/{mid}:{authorUid}`. Someone with database access cannot move or replay a
  ciphertext elsewhere, or re-attribute a message to another author, without decryption failing.
  (Messages written before author binding are still readable; their author is not bound.)
- **Safety numbers:** a DM header shows a safety number derived from both public keys. Compare it
  with your contact out-of-band (in person or on a call) to detect a swapped public key.

### What is public or plaintext by design

These are **not** end-to-end encrypted. The rules control who can read or write them, but the server and anyone
with database access can read them.

- **Public games** (`games`, `gameCode`, `gameLikes`):
  - Publishing decrypts the workspace files on your device, bundles them into one HTML document and uploads it as
    **public plaintext**. Anyone signed in can play it and read its code.
  - Titles, descriptions, like counts and *who liked which game* are public too.
  - You must tick an explicit confirmation before publishing, and you can publish or update at most once a minute.
- **Shop**:
  - The catalog is readable by every signed-in user.
  - Your coin balance and the items you own (`wallets`, `inventory`) are readable only by you.
  - Equipped cosmetics (`equipped`) are public, so others see your name color and badge.
- **Announcements, admin badges and reports.**
  - A report holds only ids. It includes message text only if the reporter explicitly opts in.
  - Admins see opted-in text labelled as unverified.
- **Server roles and moderation**: role color, position and permission flags (the rules must read them),
  members' `roleId`, timeouts, and audit-entry author and time. Role names and audit details are encrypted.
- **Group and codespace metadata**: membership, roles, key epochs, the message `epoch` field, who posted last and when,
  and the codespace template id.
- **Private to their owner, but not encrypted**: blocks, verified-contact fingerprints and notification
  preferences. Trusted link domains and the key-change acknowledgement stay in your browser's storage.

### Games and live preview are sandboxed

Games and the live preview run in an `<iframe sandbox="allow-scripts">` with an opaque origin and a strict
Content-Security-Policy (`connect-src 'none'`, no external scripts, styles, images or fonts).

- Code in the frame can't read your login session, your encryption keys, your messages or the Codehub page.
- It can't make network requests.
- Popups, forms, dialogs (`alert`) and top-level navigation are blocked.
- The preview console only displays text.
- Nothing runs until you press Play, and game code is fetched only then.

Two gaps remain:

- A game can still navigate *its own frame* to an external page (for example a fake "sign in again" screen shown
  inside Codehub). That page has no access to anything of yours, but never enter a password inside a game frame.
- `connect-src 'none'` does not cover **WebRTC** in Chromium-based browsers, so a game can open a peer connection
  through a STUN/TURN server. That can reveal your IP address and send out anything you type into the game.

Treat anything you type into a game as public.

### Shop items are data, not code

A shop item is only one of these:
- a set of `#rrggbb` color tokens;
- the id of an editor theme or add-on that ships with the app;
- a badge glyph of 1 to 8 characters, rendered as text;
- a name color.

The rules reject every other field, and nothing from the database is ever executed. The economy is enforced
entirely by the rules:
- The first claim gives 100 coins. After that, +100 at most once every 20 hours, by server time.
- A purchase is one atomic update. It debits exactly the item's current price, and an item can't be bought twice.
- There is no real money, no refunds and no transfers.

### App admins

Admins **cannot read or decrypt** private messages, servers, groups, codespaces, collab workspaces, vaults or
snippets. The rules give them no access to any encrypted path, and they never receive wrapped keys. Admin power
covers only the plaintext surfaces above.

How a promo code is checked: the client first writes your guess to `promoAttempts/{uid}`. Nobody can read that node,
and it accepts at most one guess every 30 seconds per account. The client then creates `admins/{uid}`. The rules
allow that only if the stored guess equals `config/adminPromo` and is less than two minutes old.

### What the database rules enforce

Deny by default, then:

- Profiles are readable by signed-in users and writable only by their owner. Vaults are readable
  and writable only by their owner.
- Server data, messages and collab data are readable only by **current members**.
- You can join a server only through an existing, unexpired invite that has uses left, and only
  if you are not banned. The join and the invite's use counter are one atomic write, so
  `maxUses` is enforced. Joining always gives the `member` role.
- **Server roles.**
  - The owner and admins hold every permission.
  - The owner can give a member one **custom role**. Its flags are manageChannels, manageInvites, kick, ban,
    manageMessages, manageRoles, timeout and viewAudit.
  - Every moderation action also requires the actor to **outrank** the target:
    - the owner outranks everyone;
    - admins outrank plain members;
    - a custom-role holder outranks members with no role or a lower role position.
  - Nobody can grant a permission they don't hold, or a role positioned at or above their own.
  - A deleted role grants nothing.
  - Only the owner can make admins or delete the server.
- **Timeouts** last up to 28 days. While timed out, a member can't send, edit, react or type in that server.
  Timeouts cover chat only: a timed-out member can still edit files in the server's code channels.
- **Bans.** The owner and admins can ban anyone they outrank, members or not. A custom-role holder with `ban` can only
  ban current members they outrank. Anyone holding `ban` can **lift any ban**, including one the owner placed, so
  give `ban` only to trusted roles.
- Kicking or banning also removes the target's server-list entry. Moderators can remove someone else's entry only
  while that person is being removed from the server (or is already gone).
- **Audit log** entries are append-only and attributed to their writer. Only the owner, admins and holders of a
  moderation permission can write them. They are readable by the owner, admins and viewAudit holders.
- **Checkpoints.** Members delete only their own checkpoints; the owner and admins can delete any. All of a file's
  checkpoints can be removed at once only together with the file itself.
- **Game likes** are one per account. A game's like records can only be cleared together with the game.
- Only the author can edit a message. The author or someone with manageMessages can delete it (soft delete leaves a
  tombstone). In channels only manageMessages holders can pin.
- **Groups.** Only the owner adds or removes members.
  - Removing someone must happen in the same write as a move to a new key epoch.
  - A message must carry the current epoch.
- **Codespaces.** Only owners and editors can change files, and viewers are read-only.
- **Blocking.**
  - Someone you blocked can't send to your DM, react or pin there, re-add your DM index entry or send you a friend request.
  - They also can't add you to a group or codespace.
- **Rate limits.** One game publish per minute, one report and one promo guess every 30 seconds, and one coin claim every 20 hours. A new message cannot be created
  with reactions, pins or edit/delete flags. Reactions, typing, read markers, presence and collab
  cursors can be written only for your own uid.
- Typing indicators are readable only by members of that channel or participants of that DM.
- Only the two participants of a DM can read or write it.
- Shapes and sizes are validated: message ciphertext ≤ ~64 KiB, collab updates ≤ ~1 MiB,
  snapshots ≤ ~2 MiB. Timestamps cannot be set in the future.

### Limitations: read before trusting this with secrets

- **Metadata is visible to the server.** Firebase, and anyone with admin access to the project,
  can see uids, display names, emails (in Auth), who is in which server, roles, who messaged whom
  and when, message counts and sizes, reaction emoji (but not which message text they react to),
  presence, typing and read times. Only content is hidden.
- **Group key rotation after a voluntary leave waits for the owner.** The rules cut off the leaver's read access
  immediately. Until the owner's client is next online, new messages still use a key the leaver held. A removed member
  keeps whatever they already decrypted.
- **Codespaces don't rotate keys** when a member is removed. The member loses access through the rules immediately,
  but keeps any key or ciphertext they already had.
- **Blocking in servers and groups is client-side.** Messages from a blocked user are hidden behind a "Show" button,
  but they are still delivered. The rules enforce blocking only for DMs, friend requests and adding members.
- **Notifications** work only while a Codehub tab is open and unlocked; there is no push server. Message previews in
  notifications are **off by default**. When you turn them on, decrypted text reaches your OS notification center.
- **The audit log is best effort.** The acting client writes it right after the action, and the rules can't force it.
- **Promo guessing is rate-limited per account only**, so a longer random code is safer (the rules require at
  least 8 characters; one guess per account every 30 s). The guess, including
  the correct one, is stored unhashed in `promoAttempts/{uid}`. No client can read it, but it is visible in the console.
- **Caps that only the UI enforces**, because rules can't count: 25 members per group or codespace, 20 checkpoints
  per file, 500 snippets.
- **Storage quota.** The Spark plan has 1 GB of database storage and 10 GB/month of downloads for the whole app.
  Without Cloud Functions, the rules can cap the size of each write but not the total a user stores: anyone can create a
  codespace and push collab updates (≤ ~1 MiB each), snapshots and checkpoints without a total limit, and each account
  can publish a 256 KB game every minute. A malicious account could fill the quota, after which writes fail for
  everyone. Set up **usage alerts** in the Firebase console (Usage and billing → Realtime Database), and delete the
  offender's data and Auth account in the console if it happens.
- **Zip export is an unencrypted download** of the decrypted files. The UI says so.
- **Games have no network access.** CDN scripts and fonts won't load, and imports between ES modules in workspace
  files aren't bundled.
- **No key rotation on kick or ban.** A removed member loses database access immediately, but they
  may already have the server key. If they ever regain the ciphertext (for example through a
  leaked backup or a compromised Firebase project), they can decrypt **past and future** messages
  until a new server is created. Old invite links keep containing a valid key. Revoking an invite
  stops new joins, but anyone who saw the link knows the key.
- **Keys unlock with your login.** The key that unlocks your private identity key is stored in
  the database under rules that let only your account read it. That removes the passphrase, but
  it means anyone with **admin access to the Firebase project** (or your account) could read your
  keys and decrypt your messages. Other signed-in users still can't. Accounts created with the
  old passphrase are asked for it once, then converted.
- **Trust in the served code.** As with any web-based E2EE app, whoever serves the JavaScript
  could ship code that leaks keys. Self-host and pin your build if that matters to you.
- **Public keys are not verified automatically.** Without comparing safety numbers, a malicious
  database operator could substitute a public key when a server key is wrapped or a DM key is
  derived.
- **Typing and presence** are readable by any signed-in user who knows the scope id. They are
  plaintext by design.
- **No forward secrecy.** DM keys are static per user pair, and server keys are static per server.
- **GitHub PAT scopes:** the token can do anything its permissions allow on the selected
  repositories, from your browser. Keep the repository list narrow, the expiry short, and revoke
  the token on GitHub if a device is lost. Locking or signing out clears it from memory.
- **Deleting your account** (Settings → Account) asks you to sign in again, then removes your
  profile, keys, friends, read markers, every message you sent in servers, the servers you own,
  and your DM conversations (both people's messages: once your profile is gone the rules let you
  wipe DM threads you were part of).
  - Also removed:
    - groups and codespaces you own, plus your messages in other groups;
    - your public games and your likes;
    - blocks, verifications, notification settings, snippets and equipped cosmetics.
  - Collab edits, checkpoints you saved and reactions you left stay.
  - A DM you hid from your list before deleting is not found and stays.
  - **Never deletable by a client, by design:**
    - `wallets/{uid}` and `inventory/{uid}`. Otherwise deleting and re-creating would reset coins. They hold only a
      balance and item ids.
    - `publishLog/{uid}`, `reportLog/{uid}` and `promoAttempts/{uid}` (timestamps and the last guess).
    - `admins/{uid}` and reports you filed.

    The project owner can remove any of these in the console.
- Deleting a server removes its data but cannot remove the server from other members' personal
  server lists (`userServers/{uid}`), and a kick or ban does not remove the kicked user's entry
  either. The client shows such servers as unavailable (dashed icon); clicking it removes the
  entry.

---

## 6. Project layout

```
database.rules.json      Realtime Database security rules (deploy these)
firebase.json            CLI config: database rules + optional hosting of dist/
ARCHITECTURE.md          Data model, encryption contract, module ownership
src/lib/                 firebase, crypto, keystore, profiles, presence, servers, messages, markdown, collab/ (space, read),
                         groups, codespaces(+Templates), shop, addons/, games, sandbox, roles, moderation, admin,
                         reports, announcements, blocks, verify, linkguard, notify, checkpoints, zip, palette, snippets
src/components/auth/     Sign-in, vault unlock
src/components/settings/ Settings modal (profile, keys, privacy, notifications, GitHub, add-ons, codes & admin, account)
src/components/layout/   Server rail, channel sidebar, DMs, members, header tabs
src/components/chat/     Chat view, composer, emoji, reactions, snippets
src/components/collab/   Collaborative editor, file tree, GitHub panel, CollabExtras toolbar slot
src/components/groups/   Group chats          src/components/codespaces/  Codespaces + templates
src/components/shop/     Add-on shop          src/components/games/       Arcade
src/components/sandbox/  Preview sandbox      src/components/roles/       Roles, timeouts, audit log
src/components/admin/    Admin panel, reports, announcements
src/components/safety/   Blocking, verification, safe links, notifications, mute
src/components/productivity/  Checkpoints, zip, command palette, snippet library
src/components/common/   Shared UserPicker
```

Scripts: `npm run dev` (dev server), `npm run build` (production build to `dist/`),
`npm run preview` (serve the build locally).

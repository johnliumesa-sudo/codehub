# Codehub

An end-to-end-encrypted, Discord-style chat app with a real-time code collaboration tab.
Servers, text channels, DMs, reactions, replies, pins, typing indicators and presence on the
chat side; a shared CodeMirror editor backed by Yjs, plus a GitHub panel (browse, diff, commit,
branch, pull request) on the collab side.

Built with Vite + React 18 and Firebase. It uses **Email/Password and Google Authentication** and the
**Realtime Database**. No Firestore, Storage or Cloud Functions.

---

## 1. Setup

### Firebase project (already done)

The app is already wired to Firebase project `codehub-c1e74` (`src/lib/firebase.js`,
`.firebaserc`). In that project you have already:

- enabled **Authentication → Sign-in method → Email/Password** and **Google**, and
- created a **Realtime Database** (`https://codehub-c1e74-default-rtdb.firebaseio.com`).

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
`codehub-c1e74`.

### Option B: Paste the rules into the console

1. Open **Firebase console → Realtime Database → Rules**.
2. Replace the whole editor contents with the contents of `database.rules.json`.
3. Click **Publish**.

The console also has a **Rules Playground** for testing reads and writes as a specific uid.

> Re-deploy the rules any time `database.rules.json` changes. The rules define indexes
> (`users/name`, `ts`, `pinned`, `lastTs`) too. Without them, queries still work but download more
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
| Your private identity key, GitHub token | Vault key: random AES-256 key stored at `vaults/{uid}/autoKey`, readable only by you |

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

### What the database rules enforce

Deny by default, then:

- Profiles are readable by signed-in users and writable only by their owner. Vaults are readable
  and writable only by their owner.
- Server data, messages and collab data are readable only by **current members**.
- You can join a server only through an existing, unexpired invite that has uses left, and only
  if you are not banned. The join and the invite's use counter are one atomic write, so
  `maxUses` is enforced. Joining always gives the `member` role.
- Only the owner can lift a ban. Admins can ban plain members (or non-members) only.
- Only the owner and admins can manage channels, invites, kicks and bans. Admins can act only on
  plain members. Only the owner can change roles or delete the server.
- Only the author can edit a message. The author or an admin can delete it (soft delete leaves a
  tombstone). In channels only the owner and admins can pin. A new message cannot be created
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
src/lib/                 firebase, crypto, keystore, profiles, presence, servers, messages, markdown, collab/
src/components/auth/     Sign-in, vault unlock, settings
src/components/layout/   Server rail, channel sidebar, DMs, members, header tabs
src/components/chat/     Chat view, composer, emoji, reactions, snippets
src/components/collab/   Collaborative editor, file tree, GitHub panel
```

Scripts: `npm run dev` (dev server), `npm run build` (production build to `dist/`),
`npm run preview` (serve the build locally).

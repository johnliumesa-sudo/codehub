# Codehub architecture (shared contract)

Stack: Vite + React 18 (plain JSX, no TypeScript), Firebase **Realtime Database** (`firebase/database`)
and **Email/Password Auth** only. No Firestore, no Storage, no Cloud Functions, no other auth providers.
GitHub access uses a user-supplied Personal Access Token, stored encrypted in the user's vault.

## Already written (do not rewrite; import from these)
- `src/lib/firebase.js` — exports `app`, `auth`, `db`.
- `src/lib/crypto.js` — WebCrypto E2EE primitives (read it). Ciphertext boxes are `{ iv, ct }`.
- `src/lib/keystore.js` — session keys: `hasVault, createVault, unlockVault, changePassphrase, lock,
  isUnlocked, myPublicKey, getPublicKey(uid), getServerKey(sid), cacheServerKey(sid,key),
  wrapServerKeyFor(sid, uid, key), importInviteKey(sid, keyB64) -> {key, wrapped}, getDmKey(dmId, peerUid),
  saveGithubToken(token|null), loadGithubToken(), wrapContext(sid, uid)`.
- `src/lib/profiles.js` — `useProfile(uid)`, `useProfiles(uids) -> {uid: profile}`, `initials(name)`, `AVATAR_COLORS`.
- `src/App.jsx` — auth gate: `<AuthScreen/>` → `<VaultScreen user onUnlocked/>` → `<Workspace user onLock/>`.
  Captures invite links `#/join/{sid}/{inviteId}/{keyB64}` into
  `sessionStorage['codehub.pendingInvite'] = JSON {sid, inviteId, key}`.
- `src/styles.css` — design tokens (`--bg-0..3`, `--accent`, `--text-dim`, …) and shared classes
  `.btn(.primary|.danger|.ghost|.sm) .input .field .avatar .modal-backdrop .modal .badge-e2e .spinner .muted .error-text`.
  Dark theme, Discord-like but cleaner. Each feature ships its own CSS file imported by its component.

## Encryption model (what is and isn't encrypted)
Encrypted client-side (server only sees `{iv, ct}`): message bodies, edits, attachments/code snippets,
server names, channel names, channel topics, collab file paths & contents (Yjs updates), collab cursors/awareness,
linked GitHub repo name, GitHub token. AAD strings bind ciphertext to its location — use exactly these:
- server name: `server-name:{sid}` · channel name+topic (JSON `{name, topic}`): `channel:{sid}/{cid}`
- channel message (JSON body): `msg:{sid}/{cid}/{mid}:{authorUid}` · DM message: `dm:{dmId}/{mid}:{authorUid}`
  (binds the plaintext `uid` field; readers fall back to the legacy `msg:{sid}/{cid}/{mid}` / `dm:{dmId}/{mid}` for old messages)
- collab file meta (JSON `{path, repo?, ref?, sha?}`): `cfile:{sid}/{cid}/{fid}`
- collab Yjs update: `cupd:{sid}/{cid}/{fid}` · collab snapshot: `csnap:{sid}/{cid}/{fid}`
- collab awareness: `caw:{sid}/{cid}/{fid}/{uid}` · workspace repo link (JSON `{owner, repo, branch}`): `crepo:{sid}/{cid}`
Plaintext metadata (documented to users): uids, timestamps, membership, roles, reaction emoji, presence, typing.

Message body JSON (both channel + DM): `{ text: string, code?: { lang, content, filename? } }`.
Message text supports Markdown (marked + DOMPurify, highlight.js for fenced code), `:shortcodes:` and native emoji.

## Realtime Database layout
```
users/{uid}                 { name, color, status?: string, pubKey: JWK, createdAt }        // any signed-in user reads; owner writes
vaults/{uid}                { salt, iter, wrappedPriv:{iv,ct}, ghToken?:{iv,ct} }          // owner only
presence/{uid}              { state: 'online'|'idle'|'offline', lastChanged }              // .info/connected + onDisconnect
userServers/{uid}/{sid}     { joinedAt }                                                    // owner reads/writes own index
servers/{sid}/meta          { nameEnc:{iv,ct}, ownerId, color, createdAt }
servers/{sid}/members/{uid} { role: 'owner'|'admin'|'member', joinedAt, invite?: inviteId }
servers/{sid}/keys/{uid}    { epk, iv, ct }   // server AES key ECIES-wrapped for that member (wrapContext)
servers/{sid}/invites/{iid} { createdBy, createdAt, expiresAt|0, maxUses|0, uses }
servers/{sid}/channels/{cid}{ type: 'text'|'code', enc:{iv,ct}, position, createdAt }
servers/{sid}/bans/{uid}    true
messages/{sid}/{cid}/{mid}  { uid, ts, iv, ct, editedAt?, replyTo?: mid, deleted?: true,
                              reactions?: { {emojiKey}: { {uid}: true } }, pinned?: true }
typing/ch/{sid}/{cid}/{uid} ts   // members only
typing/dm/{dmId}/{uid}      ts   // DM participants only
reads/{uid}/{scope}         ts   // last read timestamp for unread badges
dms/{dmId}/members/{uid}    true   // dmId = dmIdFor(a,b) = sorted uids joined by '_'
dmMessages/{dmId}/{mid}     same shape as messages
userDms/{uid}/{dmId}        { peer: uid, lastTs }
collab/{sid}/{cid}/repo     { iv, ct }                              // linked GitHub repo (encrypted)
collab/{sid}/{cid}/files/{fid}     { enc:{iv,ct}, createdBy, createdAt, updatedAt }
collab/{sid}/{cid}/updates/{fid}/{pushId}  { iv, ct, uid, ts }      // encrypted Yjs updates (append-only)
collab/{sid}/{cid}/snapshots/{fid} { iv, ct, upTo: pushId, ts }     // compacted state; updates <= upTo may be deleted
collab/{sid}/{cid}/awareness/{fid}/{uid}   { iv, ct, ts }           // encrypted cursor/selection; onDisconnect remove
```
Message ids are RTDB `push()` keys (chronological). Mentions: `@name` rendered client-side; `@everyone`.

## Server/invite flows
- Create server: generate room key, write meta (+nameEnc), members/{me}=owner, keys/{me}=wrapServerKeyFor,
  userServers/{me}/{sid}, default `general` text channel and `workspace` code channel. Use one multi-path `update()`.
- Invite: owner/admin writes invites/{iid}; link = `${location.origin}${location.pathname}#/join/{sid}/{iid}/{exportRoomKey}`.
- Join (from pendingInvite, after unlock): `importInviteKey(sid,key)`, then multi-path update:
  members/{me}={role:'member', joinedAt, invite: iid}, keys/{me}=wrapped, userServers/{me}/{sid}. Rules allow
  this only if the invite exists, is unexpired, has uses left, the user is not banned, AND the same update sets
  invites/{iid}/uses = uses + 1 (atomic; retry on PERMISSION_DENIED). An existing member whose key copy is unusable
  (vault reset) re-wraps keys/{me} from a fresh invite.
- Kick/ban: owner/admin removes members/{uid} and keys/{uid}. (Key rotation on kick: generate a new room key,
  re-wrap for remaining members, keep old key under `servers/{sid}/oldKeys`? — NOT in v1; document as limitation.)

## Module ownership (each builder writes ONLY its files)
1. **auth** — `src/components/auth/{AuthScreen,VaultScreen}.jsx`, `auth.css`;
   `src/components/settings/SettingsModal.jsx` (+css): profile name/color/status, change passphrase,
   GitHub token (save/clear/test via `GET https://api.github.com/user`), sign out, show my key fingerprint;
   `src/lib/presence.js` exporting `startPresence(uid)` (returns stop fn) and `usePresence(uid) -> 'online'|'idle'|'offline'`.
2. **layout** — `src/components/layout/*` (+css) incl. `Workspace.jsx` (default export, props `{user, onLock}`):
   server rail (DM home + servers + create/join), channel sidebar (text + code channels, unread badges,
   create/rename/delete channel, server settings: rename, invites w/ copy link, members & roles, kick/ban, leave/delete),
   DM list + "new DM" by searching users by name, member list panel with presence, top header with
   **tabs: 💬 Chat | 🧑‍💻 Collab** (Collab tab lists the server's code channels as workspaces), pending invite join,
   calls `startPresence`, opens `SettingsModal`. `src/lib/servers.js` (create/join/invite/channel CRUD helpers).
   Renders `<ChatView conv me/>` and `<CollabView sid cid me serverName/>`.
3. **chat** — `src/components/chat/*` (+css), `src/lib/messages.js`, `src/lib/markdown.js`.
   `ChatView` default export, props `{ conv, me }` where
   `conv = { kind:'channel', sid, cid, title, scope } | { kind:'dm', dmId, peerUid, title, scope }`, `me = {uid, ...profile}`.
   Message list (live, paginated by limitToLast + load older), grouping, Markdown+code highlighting w/ copy button,
   emoji picker (@emoji-mart/react + @emoji-mart/data) in composer, `:shortcode:` autocomplete, reactions (picker + quick
   reactions), replies, edit, delete, pin, mention highlight, typing indicator, "share code snippet" modal, client-side
   search over decrypted loaded messages, unread marker (writes reads/{uid}/{scope}), decryption-failure placeholder,
   E2E badge with safety number for DMs. Updates `userDms/{both}/{dmId}.lastTs` on DM send.
4. **collab** — `src/components/collab/*` (+css), `src/lib/collab/*`. `CollabView` default export, props
   `{ sid, cid, me, serverName }`. Encrypted Yjs-over-RTDB provider (append encrypted updates; on load apply snapshot
   then updates; periodic compaction by any member writes snapshot + deletes compacted updates; awareness via
   y-protocols encrypted + throttled), CodeMirror 6 editor with y-codemirror.next (remote cursors w/ names/colors),
   language by extension, file tree of workspace files (new/rename/delete), presence avatars per file,
   GitHub panel: link repo (owner/repo/branch), browse tree (git trees API recursive), open file into workspace
   (seed Yjs doc once), show diff vs GitHub base (simple line diff), commit changes back (contents API PUT with sha,
   commit message), create branch, open a pull request, list open PRs & issues. Public repos work without a token
   (read-only); token from `loadGithubToken()`. "Send to chat" button posts nothing itself — just copies a fenced
   snippet to clipboard.
5. **rules+docs** — `database.rules.json` enforcing everything above (validate shapes, sizes ≤ 64KB for ct,
   membership checks, roles, invite join conditions, ban, author-only edit/delete with admin delete, reactions only
   own uid key, typing/reads/presence own only, vault owner-only), and `README.md` (setup, deploy, security model,
   limitations).

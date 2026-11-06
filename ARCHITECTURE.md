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
  saveGithubToken(token|null), loadGithubToken(), wrapContext(sid, uid)`, plus (feature additions)
  `currentUid(), unwrapForMe(wrapped, context), wrapFor(uid, key, context), onLock(fn) -> unsubscribe,
  vaultEncryptJSON(value, aad), vaultDecryptJSON(box, aad)`. `lock()` runs every `onLock` handler, so each module-level
  key cache (groups, codespaces, roles, audit) is cleared on lock.
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


---

# Feature extensions (20 features, 8 workstreams)

This part extends the contract above and wins wherever the two disagree. All of it is enforced by
`database.rules.json`, and the client is untrusted. `database.rules.json` is the single source of truth for rules.

## Key wraps and AAD strings (exact; each container kind has its own prefix)
| What | Key | Wrap context / AAD |
|---|---|---|
| Group key wrap | random AES-256, one per epoch | `group:{gid}:{epoch}:{uid}` |
| Group name | group key (current epoch) | `group-name:{gid}` |
| Group message JSON body | group key of `msg.epoch` | `gmsg:{gid}/{mid}:{authorUid}` (no legacy AAD) |
| Codespace key wrap | random AES-256 | `codespace:{csid}:{uid}` |
| Codespace name | codespace key | `cs-name:{csid}` |
| Codespace file meta / Yjs update / snapshot | codespace key | `csfile:{csid}/{fid}` / `csupd:{csid}/{fid}` / `cssnap:{csid}/{fid}` |
| Codespace awareness / repo link | codespace key | `csaw:{csid}/{fid}/{uid}` / `csrepo:{csid}` |
| Codespace deterministic fid material | n/a | `csfid:{csid}:{keyB64}:{path}` |
| Channel-workspace checkpoint `{label,text}` | server key | `cchk:{sid}/{cid}/{fid}/{cpid}` |
| Codespace checkpoint `{label,text}` | codespace key | `cschk:{csid}/{fid}/{cpid}` |
| Server role name (text) | server key | `role:{sid}/{rid}` |
| Moderation audit entry `{action,target?,detail?}` | server key | `audit:{sid}/{aid}:{byUid}` |
| Snippet `{title,lang,code,tags[]}` | vault key | `vault-snip:{uid}/{id}` |

The existing strings are unchanged: `cfile: cupd: csnap: caw: crepo: cfid: msg: dm: server-name: channel:`.

## Realtime Database layout (additions)
```
# Groups (F1), E2EE per epoch
groups/{gid}/meta               { ownerId, nameEnc:{iv,ct}, epoch:int>=1, createdAt, needsRotate?:true }
groups/{gid}/members/{uid}      { role:'owner'|'member', joinedAt, addedBy }
groups/{gid}/keys/{epoch}/{uid} { epk, iv, ct }        // write-once; owner writes, member may delete own
groups/{gid}/last               { ts (=now), uid (=me) } // any member, on every send (sorting + unread)
groupMessages/{gid}/{mid}       { uid, ts, epoch, iv, ct, editedAt?, replyTo?, deleted?, reactions?, pinned? }  // .indexOn ts, pinned, uid
userGroups/{uid}/{gid}          { addedAt }            // own index; the owner writes/removes members' entries
typing/grp/{gid}/{uid}          ts
reads/{uid}/grp_{gid}           ts

# Codespaces (F2, F8)
codespaces/{csid}/meta          { ownerId, nameEnc:{iv,ct}, createdAt, template? }
codespaces/{csid}/members/{uid} { role:'owner'|'editor'|'viewer', joinedAt, addedBy }
codespaces/{csid}/keys/{uid}    { epk, iv, ct }
userCodespaces/{uid}/{csid}     { addedAt }
csCollab/{csid}/{repo|files|updates|snapshots|awareness|checkpoints}   // same shapes as collab/{sid}/{cid}

# Checkpoints (F9) and snippets (F20)
collab/{sid}/{cid}/checkpoints/{fid}/{cpid}  { uid, ts, iv, ct }   // server key; create-only
csCollab/{csid}/checkpoints/{fid}/{cpid}     { uid, ts, iv, ct }   // codespace key
snippets/{uid}/{id}                          { ts, iv, ct }        // vault key; owner only

# Shop (F3), PLAINTEXT
shop/items/{itemId}       { name<=48, desc<=280, kind:'theme'|'editorTheme'|'editorExt'|'badge'|'nameColor', price:int 0..10000,
                            data, active:bool, updatedAt(=now), updatedBy(=auth.uid) }   // signed-in read; app admins write
                            data: theme {tokens:{bg0|bg1|bg2|bg3|bgHover|border|text|textDim|textFaint|accent|accent2|ok|warn|danger:'#rrggbb'}}
                                  editorTheme|editorExt {builtinId:[a-z0-9-]{1,32}} · badge {glyph:1..8 chars} · nameColor {color:'#rrggbb'}
wallets/{uid}             { balance:int>=0, lastClaim, lastItem? }   // owner read/write; never deletable
inventory/{uid}/{itemId}  { at(=now), price }                        // owner read; create-once; never deletable
equipped/{uid}            { theme?, editorTheme?, badge?, nameColor?: itemId, ext?: { {itemId}: true } }  // signed-in read; owner writes

# Games (F4), PUBLIC PLAINTEXT
games/{gameId}            { ownerId, title<=80, desc<=500, createdAt, updatedAt, likes:int>=0, size:int<=262144 }  // .indexOn createdAt, likes, ownerId
gameCode/{gameId}         { html: string <= 262144 }   // fetched only on Play
gameLikes/{gameId}/{uid}  true                          // count in games/{id}/likes moved ±1 atomically with the entry
publishLog/{uid}          ts                            // write-only; one publish/update per 60 s (=== now)

# Server roles, timeouts, audit (F5, F14, F15)
servers/{sid}/roles/{rid}           { nameEnc:{iv,ct}, color:'#rrggbb', position:int 1..899,
                                      perms:{ manageChannels, manageInvites, kick, ban, manageMessages, manageRoles, timeout, viewAudit: bool }, createdAt }
servers/{sid}/members/{uid}/roleId  rid (optional; at most one custom role per member)
servers/{sid}/timeouts/{uid}        untilMs (> now, <= now + 28 days); readable by members
audit/{sid}/{aid}                   { by (=auth.uid), ts (=now), iv, ct }   // read: owner, admins, viewAudit; append-only; owner deletes it with the server

# App admin, reports, announcements (F6, F16, F17), PLAINTEXT
config/adminPromo          string          // set in the Firebase console only; .read/.write false for every client
promoAttempts/{uid}        { code, at }    // last guess; one write per 30 s per account; nobody can read it
admins/{uid}               { at }          // readable by self only; created only if promoAttempts/{uid}.code === config/adminPromo and at is under 2 min old
adminBadges/{uid}          true            // public admin shield (signed-in read); self may set if admin, or remove
reports/{rid}              { by, kind: game|user|shopItem|message, target<=256, reason: spam|abuse|malware|nsfw|other, note?<=500, excerpt?<=2000, ts }  // admin read/delete only
reportLog/{uid}            ts              // 1 report per 30 s, written in the same update as reports/{rid}
announcements/current      { text<=280, level: info|warn, ts, by }   // signed-in read; admin write

# Safety & notifications (F11, F12, F19), private to the owner, not E2EE
blocks/{uid}/{otherUid}         true
verified/{uid}/{peerUid}        { fp, ts }     // fp = keyFingerprint(peer pubKey) at verification
notifPrefs/{uid}/settings       { desktop, preview, mentionsOnly: bool }
notifPrefs/{uid}/scopes/{scope} { level: 'all'|'mentions'|'none', until?: number }
```
Scopes: read/unread scopes are `{sid}_{cid}`, `dm_{dmId}` and `grp_{gid}`. `cs_{csid}` is reserved and unused. Mute
scopes also include `srv_{sid}`, which mutes a whole server; a channel's own preference overrides it.

## Server permissions (F5)
- Rank: owner 1000, admin 900, a member with a valid `roleId` gets that role's position, and a plain member is 0.
- The owner and admins implicitly hold every permission. A custom-role member holds `p` iff `roles/{roleId}/perms/{p} === true`.
- A dangling roleId fails closed: it gives rank 0 and no permissions.
- OUTRANKS:
  - The owner outranks everyone except themselves.
  - An admin outranks plain `member`-role members only.
  - A custom-role member outranks members with no valid role, or with a strictly lower position.
- The rules expand the macros literally. The client mirrors them in `src/lib/roles.js`
  (`rankOf`, `can`, `permsFor`, `outranks`), and the UI uses `perms` from `permsFor` instead of `canManage`/`canModerate`.
  Legacy `owner`/`admin` role strings keep working unchanged.
- Rule additions beyond the core permission model:
  - A custom role with `ban` can remove a member, but only in the same update that writes `bans/{uid}`.
  - A timed-out member can't send, edit, react or type in that server.
- Audit `writeAudit` call sites:
  - MemberRoleControls: kick, ban, timeout, role.assign.
  - RoleEditor/RolesTab: role.*.
  - ServerSettingsModal: member.role, unban, invite.*.
  - ChannelModal: channel.*.

## Groups (F1)
- **Create:** one multi-path update with meta (epoch 1), members, `keys/1/*`, last, `userGroups/*` and my read marker.
- **Add members:** owner only. New members get the current epoch key and, by default, every older epoch key the owner
  can open, so they can read history. The update rewrites `meta/epoch` unchanged, so it fails cleanly if the key rotates
  at the same time.
- **Remove a member:** owner only. One update does all of this, and the rules accept a removal only together with epoch+1:
  - members/{x} = null
  - keys/*/{x} = null
  - userGroups/{x}/{gid} = null
  - meta/epoch = e+1
  - re-encrypted nameEnc
  - needsRotate = null
  - keys/{e+1}/{each remaining member}
- **Leave:** a non-owner deletes their own entries and sets `meta/needsRotate`. The owner's client then rotates, at most
  once per 30 s per group.
- **Chat:** reuses ChatView with `conv = { kind:'group', gid, epoch, ownerId, title, scope:'grp_'+gid }`.
  - ChatView remounts when the epoch changes.
  - `messages.js` adds `epoch` to each record, decrypts with that message's epoch key, and writes `groups/{gid}/last`
    plus my read marker after each send.
  - The owner moderates, and any member may pin.

## Collab spaces (src/lib/collab/space.js)
All collab code takes a **space** instead of `(sid, cid)`. The legacy arguments still work.
- `channelSpace(sid, cid)`: base `collab/{sid}/{cid}`, keyed by the server key. Its strings are byte-identical to the original ones.
- `codespaceSpace(csid)`: base `csCollab/{csid}`, keyed by the codespace key.
- `src/lib/collab/read.js` does one-shot reads that never write: `loadDocText`, `loadWorkspaceFiles`, `loadWorkspaceFileList`.

CollabView:
- Props: `{ space?, sid, cid, me, serverName, title?, readOnly? }`. Read-only mode never writes updates, snapshots or
  compaction; it still sends awareness.
- The toolbar renders `<CollabExtras ctx/>` (`src/components/collab/CollabExtras.jsx`), which composes PreviewButton,
  PublishGameButton, CheckpointsButton, SnippetsButton and ExportImportMenu.
- `ctx = { space, key, me, readOnly, title, files, activeFid, activePath, provider, insertText, getSelection, openFile, notify }`.
- The live preview is a controlled split (LivePreviewPane) to the right of the editor.
- An empty workspace offers "Add files from template" and Export/Import.
- `deleteFile` also nulls `checkpoints/{fid}`.

## Codespaces (F2, F8)
- Standalone E2EE workspaces with owner/editor/viewer roles. Viewers can only read and send their own cursor.
- **Create:** one update (meta, owner membership, owner key, index entry). Template files are then seeded with
  `createFile({space})`. Templates live in `src/lib/codespaceTemplates.js`.
- **Delete:** one update nulls `codespaces/{csid}`, `csCollab/{csid}` and every member's index entry.
- **Navigation:** `nav.view === 'codespaces'` plus `nav.csid`.

## Shop and add-ons (F3)
- Items are data only. Behavior comes from first-party modules in `src/lib/addons/`, selected by `builtinId`.
- App themes write only a fixed token→CSS-variable map (plus a derived `--accent-soft`) through `style.setProperty`, using
  validated hex values. Badge glyphs render as React text.
- `AddonRuntime` is mounted once in Workspace. `useEditorAddons()` feeds a CollabEditor Compartment that replaces `oneDark`.
- **Purchase:** one multi-path update: `wallets/{uid}/balance -= price`, `wallets/{uid}/lastItem = itemId`, and
  `inventory/{uid}/{itemId} = {at, price}`.
- **Claim:** +100 coins, at least 20 h after the last claim (server `now`). The first claim creates the wallet with 100.

## Sandbox: games and live preview (F4, F7)
- `src/lib/sandbox.js` + `SandboxFrame`: `<iframe sandbox="allow-scripts" srcdoc referrerPolicy="no-referrer" allow="">`.
  - It never gets allow-same-origin, allow-popups, allow-top-navigation, allow-forms or allow-modals.
  - `buildSrcdoc` prepends a CSP meta: `default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline';
    img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'`.
- Console bridge (preview mode only):
  - The frame posts `{__sbx: token, level, args}`. The parent accepts a message only if `e.source === iframe.contentWindow`
    and the token matches; the token is fresh for every render.
  - Output is text only, capped at 200 lines.
- Bundling inlines workspace-relative CSS, JS and SVG. Size limits: preview ≤ 2 MB, game ≤ 262144 chars.
- **Publish:** one update of `games/{id}`, `gameCode/{id}` and `publishLog/{me}`.
- **Like:** one update of `gameLikes/{id}/{me}` and the like count ±1.
- **Unpublish** (owner or app admin): one update nulls all three nodes.
- **Navigation:** `nav.view === 'arcade'`.

## App admins, reports, announcements (F6, F16, F17)
- **Admin check:** in the rules, `root.child('admins').child(auth.uid).exists()`. In the client, `useIsAppAdmin()`.
  Other users' badges come from `useAdminBadge(uid)`.
- **Promo flow:** `set(promoAttempts/{me}, {code, at: serverTimestamp()})`, then `update({admins/{me}, adminBadges/{me}})`.
  A PERMISSION_DENIED on the second write means the code is invalid. The secret appears nowhere in source, rules or docs.
- Admins get **no** rules access to any E2EE path (servers, messages, dms, dmMessages, groups, groupMessages, codespaces,
  csCollab, collab, vaults, snippets) and never receive wrapped keys.
- **Message report targets** (plaintext ids from `messageTarget(conv, m)`): `msg:{sid}/{cid}/{mid}:{authorUid}`,
  `dm:{dmId}/{mid}:{authorUid}` and `gmsg:{gid}/{mid}:{authorUid}`. An excerpt is sent only after an explicit opt-in.
- **Announcement dismissal** is stored in `localStorage['codehub.annDismissed']`.

## Safety & notifications (F11, F12, F13, F19)
- **Blocking, enforced by the rules.** Someone you blocked can't:
  - create messages in your DM, or react or pin there;
  - rewrite your userDms entry;
  - write friend pairs involving you;
  - add you to a group or codespace.

  The peer in a DM is `$dmId.replace(auth.uid,'').replace('_','')`, which is safe because uids never contain `_`.
  Inside servers and groups, blocking is client-side only (`BlockedGate`).
- **Verification.** The peer key is always read live from `users/{peer}/pubKey`.
  - Status is one of verified, unverified, changed or nokey.
  - A changed key shows a banner plus a one-time confirmation before sending, once per tab.
- **Safe links.** `LinkGuardHost`, mounted once, intercepts external http(s) links (capture phase) and shows a
  confirmation with warnings. App-owned links opt out with `data-trusted-link`. Trusted domains are kept per device in
  `localStorage['codehub.trustedDomains']`.
- **Notifications.** `Notifier` subscribes to `limitToLast(1)` per source (text channels, DMs, groups) and decrypts locally.
  - It skips my own messages, blocked authors, muted scopes and the conversation in focus.
  - Previews are off by default.
  - Muted scopes show no unread badge: every `isUnread` call site is wrapped with `!isMuted`.

## Productivity (F9, F10, F18, F20)
- `src/lib/checkpoints.js`: restore is one Yjs transaction with a minimal replace. The UI caps a file at 20 checkpoints.
- `src/lib/zip.js`: export is a store-only zip, and an **unencrypted** download. Import accepts STORED and DEFLATE entries,
  text files only, at most 200 files, 900 KB each and 5 MB total.
- `src/lib/palette.js` + CommandPalette:
  - Ctrl/⌘ K or Ctrl/⌘ Shift P.
  - It lists only names this session can already decrypt.
  - Recents are opaque ids in `localStorage['codehub.paletteRecent']`.
- `src/lib/snippets.js`: snippets are vault-encrypted, with a UI cap of 500. They can be inserted into the editor
  (through `ctx.insertText`) or the chat composer.

## Workspace navigation
`nav = { sid, dmId, gid, tab, chatCid, codeCid, right:{chat, collab, group}, view: null|'codespaces'|'arcade'|'shop', csid }`.
It is persisted per user in localStorage and holds ids only. While `view` is set, no server or conversation is shown.
Every navigation action clears `view`.

## Plaintext by design (documented to users)
- **Shop:** catalog, wallets, inventory, equipped cosmetics.
- **Games:** game code, likes, publishLog.
- **App admin:** announcements, reports (including any excerpt the reporter opts into), adminBadges.
- **Codespaces:** template id; membership, roles and joinedAt/addedBy.
- **Server roles:** role color, position and permissions; roleId assignments; timeouts; audit by/ts.
- **Groups:** membership, roles, epochs, the message `epoch` field and `groups/{gid}/last`.
- **Private to the owner but not E2EE:** blocks, verified fingerprints, notification prefs.

## Limitations
- Codespace keys don't rotate when a member is removed.
- After a voluntary leave, group key rotation waits until the owner is online.
- Blocking inside servers and groups is client-side only.
- Notifications work only while a tab is open.
- The audit log is best effort.
- Promo guessing is rate-limited per account only.
- These caps are enforced in the UI only: 25 members, 20 checkpoints per file, 500 snippets.
- Admins can never decrypt E2EE content.
- Account deletion can't remove `wallets`, `inventory`, `publishLog`, `reportLog`, `promoAttempts`, `admins` or filed
  reports. That is by design.

## Module ownership (additions)
- groups: `src/lib/groups.js`, `src/components/groups/*`, `src/components/common/UserPicker.jsx`
- codespaces: `src/lib/collab/{space,read}.js`, `src/lib/codespaces.js`, `src/lib/codespaceTemplates.js`, `src/components/codespaces/*`
- shop: `src/lib/shop.js`, `src/lib/addons/*`, `src/components/shop/*`
- games: `src/lib/{games,sandbox}.js`, `src/components/{games,sandbox}/*`
- roles: `src/lib/{roles,moderation}.js`, `src/components/roles/*`
- admin: `src/lib/{admin,reports,announcements}.js`, `src/components/admin/*`
- safety: `src/lib/{blocks,verify,linkguard,notify}.js`, `src/components/safety/*`
- productivity: `src/lib/{checkpoints,zip,palette,snippets}.js`, `src/components/productivity/*`
- integrator glue: `src/components/collab/CollabExtras.jsx`, plus the existing shared files

## Overnight 2026-11-06 additions: calls, notifications, media, theme

### Calls (WebRTC mesh, max 6): `src/lib/calls/*`, `src/components/calls/*`
- Scopes: `dm_{dmId}`, `grp_{gid}`, `vc_{sid}_{cid}`. DM/group calls live at `calls/{scope}` + `signal/{scope}/{to}/{from}/{pushId}`; voice channels at `vcalls/{sid}/{cid}` + `vsignal/{sid}/{cid}/{to}/{from}/{pushId}` (rules cannot split strings).
- Meta `{id (8-32), startedBy=auth.uid, ts=now, kind audio|video}`: writable only while no slots exist and (no meta / older than 60 s / own). Slots `slots/{0..5}` = `{uid, joinedAt=now (immutable), mic, cam, screen}`; one slot per user, own slot only, meta must exist. `onDisconnect` removes slot + inbox.
- Signaling: AES-GCM with the conversation key (DM key, current group epoch key with `epoch` stored, server key for voice). AAD `call:{scope}/{callId}/{from}->{to}` (scope always the string form). Only `to` reads/deletes; writer must be `from` and both must be members (voice: channel type `voice`).
- Perfect negotiation per pair (higher uid polite). ICE: `stun:stun.l.google.com:19302` + `appConfig/turn` (<=4).
- Ringing (DM/group only): `notifs/{to}/{nid}` `{kind:'call', from, ts, ref:{dmId|gid, callId}}`. `IncomingCallModal` shows unread call notifs <30 s old whose call is live (WebAudio ringtone). Voice channels are drop-in.
- One active call per tab (`useActiveCall`); hang-up, vault lock and pagehide stop tracks, close peers, remove slot and inbox. Device prefs in localStorage `codehub.callDevices`.
- UI wiring: `CallAudio` + `IncomingCallModal` always mounted in Workspace; `CallView` replaces the chat pane while open; `MiniCallBar` above UserPanel; `CallButton` in the header for DMs/groups; voice channels in ChannelSidebar (speaker icon, participants, click joins).

### Notification center: `src/lib/notifications.js`, `src/components/notifications/*`
- `notifs/{uid}/{nid}` = `{kind, from=auth.uid, ts=now, ref:{sid|cid|gid|dmId|mid|gameId|callId}, read?}`; kinds mention|reply|dm|groupAdd|friendReq|roleChange|gameLike|call|announcement. `.indexOn: ['ts']`.
- `notifLog/{from}/{uid}` = now, written in the same update; rules enforce >= 3 s per pair. Blocked senders are refused; per-kind context checks (server membership, DM/group membership, group owner, admin for announcement).
- Recipient reads, marks `read:true`, deletes. Client keeps newest 200. Bell in the header (global instance drives `(N) Codehub` title and desktop alerts, which never show message text).

### Media: `src/lib/media/*`, `src/components/media/*`
- `avatars/{uid}` `{data base64 <=65536, mime webp|jpeg|png, ts=now}` (plaintext, any signed-in user reads; <=256 px, <=48 KB).
- `servers/{sid}/icon` `{iv, ct<=90000}`, AAD `server-icon:{sid}`; owner/admin write.
- `emotes/{sid}/{eid}` `{iv, ct<=90000, by, ts}`, AAD `emote:{sid}/{eid}`; owner/admin/`manageEmotes` write; 50 per server, <=128 px, <=48 KB.
- `att/{scope}/{attId}/meta` `{by, ts, n 1..8, size<=600000, iv, ct<=2048, sid+cid | gid+epoch}`, AAD `att-meta:{scope}/{attId}`; chunks `att/{scope}/{attId}/c/{0..7}` `{iv, ct<=100000}`, AAD `att:{scope}/{attId}/{i}`. Scope `ch_{sid}_{cid}` | `dm_{dmId}` | `grp_{gid}`. Images are re-encoded (EXIF stripped) except small animated GIF/WebP. No video upload (Spark plan, RTDB only).
- Message body gains `attachments: [{attId,w,h,mime,size}] (<=4)` and `gif: {url,w,h}` (GIPHY links only), validated on send and render.
- `appConfig/{giphyKey, turn[]}`: signed-in read, admins write (Admin panel -> "GIFs & calls").

### Theme
- `src/lib/theme.js`: dark / light / system, stored only in localStorage `codehub.theme`; `initTheme()` runs in main.jsx before render. Light tokens in `:root[data-theme="light"]`; shop themes get derived light variants. Toggle in Settings -> Appearance.

### Plaintext by design (additions)
- Calls: who is in which call and when (slot uid, joinedAt, mic/cam/screen), call id/start/kind/starter, signaling envelope (from/to, ts, epoch), ring notif ids.
- Notifications: kind, sender uid, timestamp, opaque ids, read flag (no text).
- Media: avatars (readable by all signed-in users), attachment metadata ids/sizes/counts, emote author/ts, `appConfig` (GIPHY key and TURN credentials are client-visible).

### Limits
- No calls or notifications while the browser is closed (no push on Spark). Mesh capped at 6 (upload grows per peer). Peers see each other's IP addresses (TURN only if an admin configures it). A removed group member keeps their call slot until leaving but cannot signal.
- GIFs load from GIPHY: GIPHY sees viewer IPs and search terms (no-referrer is used). Animated uploads keep original bytes. Attachments can orphan after server/group deletion (unreadable, but count toward the 1 GB quota).
- The minified rules are ~104 KB, over the console's 100 KB paste limit: deploy with `npm run deploy` (CLI), not by console paste.

## Overnight 2026-11-06 tier 2: chat extras and server extras

### chatx: polls, spoilers, bookmarks, forwarding (`src/lib/chatx`, `src/components/chatx`)
- **Polls**: the encrypted message body gains `poll: { q ≤200, options[2..10] each ≤80 }` (sanitised by `sanitizePoll` on send in `messages.cleanBody` and on render). Votes live at `votes/{path}/{mid}/{uid}` = plaintext option index 0-9, path = `messages.typingPath(conv)` (`ch/{sid}/{cid}` | `dm/{dmId}` | `grp/{gid}`). Plaintext so the rules enforce "own uid only, one vote per user". The server learns "uid voted option N", never the option text. Reads and writes require membership of the conversation (server member + existing channel and not timed out, DM member, or group member). Retract = remove the node. Composer: 📊 button opens `PollComposer`.
- **Spoilers/quotes**: `||text||` renders `<span class="spoiler">` via the marked extension `spoilerExtension` (in `lib/markdown.js`); click toggles `.revealed` (delegated in `Message.jsx`). Quotes use markdown blockquote.
- **Bookmarks**: `bookmarks/{uid}/{key}` = `{iv, ct, ts}`; ct = vault-encrypted JSON (conv ref, mid, author, snippet ≤600, savedAt) with AAD `bm:{uid}/{key}`; key = `${scope}_${mid}` with RTDB-forbidden chars replaced (idempotent). Owner-only read/write. Snippets are copies (deleting the original does not remove them). UI: 🔖 in the message toolbar saves; 🔖 in the header opens "Saved messages".
- **Forwarding**: `forwardMessage` re-encrypts a body into the target conversation key as a new message by the forwarder, carrying `fwd: { from }` (display name, advisory only). `messages.cleanBody` preserves `fwd`; received `fwd` renders `ForwardedTag`. The `ForwardModal` picker is **not yet wired** into the message menu (needs a cross-conversation target list).

### serverx: slowmode, categories, richer profiles, shortcuts (`src/lib/serverx`, `src/components/serverx`)
- **Slowmode**: `servers/{sid}/channels/{cid}/slowmode` = 1..21600 s (absent = off), written by `manageChannels` (channel edit modal → `SlowmodeControl`). `lastPost/{sid}/{cid}/{uid}` = server timestamp; uid-only read/write, members only, never deleted, value must be `now` and `now - previous ≥ slowmode*1000`. The message `uid` validate requires non-moderators in a slowmode channel to write `lastPost/…/{auth.uid} = now` in the **same** multi-path update (`sendMessage` does this via `slowmodeExtras`). Owner/admin/`manageMessages` are exempt. `SlowmodeBar` shows the countdown above the composer.
- **Categories**: `servers/{sid}/categories/{catId}` = `{ enc:{iv,ct≤1024}, position }`, enc = server-key `encryptJSON({name})` with AAD `category:{sid}/{catId}`. Members read; `manageChannels` writes. A channel's optional `cat` (≤32 chars) points at a catId; dangling = uncategorized. Text channels are grouped in the sidebar; "Manage categories" in the server menu. Collapsed state is per-viewer `localStorage` (`codehub.collapsedCats`). Decrypted names are cleared with `clearPlainCache()`.
- **Richer profiles**: `users/{uid}/profile` = `{ bio≤190, pronouns≤40, links{0..2}: https URL ≤200, banner '#rrggbb' }`, publicly readable like `name`, owner write. Editor in Settings → My profile; card in the member profile popover. Links render `rel="noopener noreferrer nofollow ugc"`, https only.
- **Shortcut overlay**: press `?` (not while typing, not with Ctrl/Meta/Alt, not over another modal); data in `lib/serverx/shortcuts.js` must match real bindings.

### Plaintext by design (tier 2 additions)
- Poll vote indices per uid (not option text), bookmark timestamps/count, slowmode seconds, `lastPost` timestamps, category positions and channel `cat` ids (category **names** stay encrypted), profile bio/pronouns/links/banner color.

### Tests
- `tests/rules/serverx.test.mjs` (slowmode window, forgery, moderator exemption, categories, profile validation). Votes/bookmarks rules have no dedicated tests yet.

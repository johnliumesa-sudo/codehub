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

# Shop (F3; community items and earnings since round 3, see docs/features/shop.md), PLAINTEXT
shop/items/{itemId}       { name<=48, desc<=280, kind:'theme'|'editorTheme'|'editorExt'|'badge'|'nameColor', price:int 0..10000,
                            data, active:bool, updatedAt(=now), updatedBy(=auth.uid), by?: creator uid, createdAt?(=now once) }
                            // signed-in read. Create: anyone signed in, push id, by = me, in the publishLog window, with
                            // udata/{me}/shop/last = id. Edit/delete: the creator (by never changes) or app admins.
                            // Items without `by` (official) and any data.builtinId are app-admin only.
                            data: theme {tokens:{bg0|bg1|bg2|bg3|bgHover|border|text|textDim|textFaint|accent|accent2|ok|warn|danger:'#rrggbb'}}
                                  editorTheme {tokens:{bg|fg|sel|caret|kw|str|cmt|num|fn|type|op:'#rrggbb'}} or {builtinId}
                                  editorExt {builtinId:[a-z0-9-]{1,32}} · badge {glyph:1..8 chars} · nameColor {color:'#rrggbb'}
wallets/{uid}             { balance:int>=0, lastClaim, lastItem?, lastEarn? }   // owner read/write; never deletable
inventory/{uid}/{itemId}  { at(=now), price }                        // owner read; create-once; never deletable
earnings/{creator}/{buyerUid}_{itemId}  { price, ts(=now) }          // creator reads and deletes; created only by the buyer,
                                                                     // in the purchase update (price = catalog price)
equipped/{uid}            { theme?, editorTheme?, badge?, nameColor?: itemId, ext?: { {itemId}: true } }  // signed-in read; owner writes
udata/{uid}/shopSales/{buyerUid}_{itemId}  { item, price, at }       // collected-sales history (generic udata block)

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
reports/{rid}              { by, kind: game|user|shopItem|message|bot|addon, target<=256, reason: spam|abuse|malware|nsfw|other, note?<=500, excerpt?<=2000, ts }  // admin read/delete only
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
Round 3 opened the catalog to every signed-in user and added creator earnings; details, rules and tests in
`docs/features/shop.md`.
- Items are data only. Behavior comes from first-party modules in `src/lib/addons/`, selected by `builtinId` (admin
  items only). Community `editorTheme` items carry eleven color tokens that the first-party generator
  (`editorThemeFromTokens`) turns into a CodeMirror theme.
- App themes write only a fixed token→CSS-variable map (plus a derived `--accent-soft`) through `style.setProperty`, using
  validated hex values. Badge glyphs render as React text.
- `AddonRuntime` is mounted once in Workspace. `useEditorAddons()` feeds a CollabEditor Compartment that replaces `oneDark`.
- **Community items:** anyone signed in creates `theme`, `editorTheme` (tokens), `badge` and `nameColor` items, live
  immediately. Create is one update of the item (`by` = me, `createdAt` = now), `publishLog/{me}` and
  `udata/{me}/shop/last`. The creator edits, switches off or deletes; app admins can take down (switch off; the
  creator can then only delete), restore or delete any item. Items are re-checked on every render (`findForbidden`,
  `normalizeItem`, theme contrast); failing ones are hidden. UI cap: 50 items per creator.
- **Purchase:** one multi-path update: `wallets/{uid}/balance -= price`, `wallets/{uid}/lastItem = itemId`, and
  `inventory/{uid}/{itemId} = {at, price}`; for someone else's paid item also `earnings/{by}/{uid}_{itemId} = {price, ts}`.
- **Collect:** one update per earning: `wallets/{me}/balance += price`, `wallets/{me}/lastEarn = key`,
  `earnings/{me}/{key} = null`, plus a history row in `udata/{me}/shopSales/{key}`. "Collect all" runs them in sequence.
  Coins only move from buyer to creator; nothing mints them.
- **Claim:** +100 coins, at least 20 h after the last claim (server `now`). The first claim creates the wallet with 100.
  One wallet write is a claim, a purchase or a collect, never two.

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
- **Shop:** catalog (including each community item's creator `by` and `createdAt`), wallets, inventory, earnings
  (keys contain the buyer's uid, so creators see who bought), equipped cosmetics.
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
- Account deletion can't remove `wallets`, `inventory`, `publishLog`, `reportLog`, `notifLog`, `attLog`, `promoAttempts`, `admins` or filed
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
- Signaling: AES-GCM with the conversation key (DM key, current group epoch key with `epoch` stored, server key for voice). AAD `call:{scope}/{callId}/{from}->{to}` (scope always the string form). Only `to` reads and deletes (whole inbox, or one handled message at a time); writer must be `from` and both must be members (voice: channel type `voice`).
- Perfect negotiation per pair (higher uid polite). The first offer of a pair always comes from the impolite side (two simultaneous offers made Chrome skip candidate gathering after the polite rollback); later renegotiations may come from either side. Each peer's outgoing messages are sent strictly in order, and candidates that arrive before a remote description are buffered. A message is handled once even if deleting it fails. Leftovers from an earlier session are dropped when the message's server `ts` is older than the sender's slot `joinedAt` (both server timestamps; the sender's own copy of `joinedAt` comes from a transaction and is only a local estimate, so it is never compared). ICE: `stun:stun.l.google.com:19302` + `appConfig/turn` (<=4).
- Rings retry once after 3.3 s when the 3 s per-pair notification throttle refuses them (e.g. a message or group-add notification just before the call).
- Ringing (DM/group only): `notifs/{to}/{nid}` `{kind:'call', from, ts, ref:{dmId|gid, callId}}`. `IncomingCallModal` shows unread call notifs <30 s old whose call is live (WebAudio ringtone). Voice channels are drop-in.
- One active call per tab (`useActiveCall`); hang-up, vault lock and pagehide stop tracks, close peers, remove slot and inbox. Device prefs in localStorage `codehub.callDevices`.
- UI wiring: `CallAudio` + `IncomingCallModal` always mounted in Workspace; `CallView` replaces the chat pane while open; `MiniCallBar` above UserPanel; `CallButton` in the header for DMs/groups; voice channels in ChannelSidebar (speaker icon, participants, click joins).

### Notification center: `src/lib/notifications.js`, `src/components/notifications/*`
- `notifs/{uid}/{nid}` = `{kind, from=auth.uid, ts=now, ref:{sid|cid|gid|dmId|mid|gameId|callId}, read?}`; kinds mention|reply|dm|groupAdd|friendReq|roleChange|gameLike|call|announcement. `.indexOn: ['ts']`.
- `notifLog/{from}/{uid}` = now, written in the same update; rules enforce >= 3 s per pair. Blocked senders are refused; per-kind context checks (server membership, DM/group membership, group owner, admin for announcement).
- Recipient reads, marks `read:true`, deletes. Client keeps newest 200. Bell in the header (global instance drives the unread count in the tab title and desktop alerts, which never show message text).
- Senders (`lib/notifSend.js`, Firebase-only so any lib can import it): dm (ChatView, forwards), mention + reply (server channels **and groups**), call (ringCall), friendReq (`addFriend`), groupAdd (`createGroup`, `addMembers`), roleChange (`setMemberRole`, `assignRole`), gameLike (`likeGame`), announcement (opt-in checkbox in the announcement editor, fanned out to at most 1,000 users from the admin's browser).
- Tab title: `lib/title.js` is the only writer of `document.title`. Workspace sets the page name; notify.js (unread messages) and the bell (unread notifications) report counts; the larger count is shown (they overlap).

### Media: `src/lib/media/*`, `src/components/media/*`
- `avatars/{uid}` `{data base64 <=65536, mime webp|jpeg|png, ts=now}` (plaintext, any signed-in user reads; <=256 px, <=48 KB).
- `servers/{sid}/icon` `{iv, ct<=90000}`, AAD `server-icon:{sid}`; owner/admin write (Upload / Change / Remove in Server settings).
- `emotes/{sid}/{eid}` `{iv, ct<=90000, by, ts}`, AAD `emote:{sid}/{eid}`; owner/admin/`manageEmotes` write; 50 per server, <=128 px, <=48 KB.
- Emotes in use: `:name:` in a server channel renders as `<img class="md-emote">` inside `renderMarkdown` (opts.emotes; a server emote wins over a standard shortcode). The sanitizer allows `img` only with class `md-emote` and a `data:image/(png|jpeg|webp|gif);base64,` src, so nothing remote ever loads. Reactions use key `e_{name}` (hex emoji keys never contain `_`; `lib/reactions.js`). The emoji picker shows a "Server" category (emoji-mart `custom`), and composer `:` autocomplete lists matching emotes first. DMs and groups have no emotes.
- `att/{scope}/{attId}/meta` `{by, ts, n 1..8, size<=600000, iv, ct<=2048, sid+cid | gid+epoch}`, AAD `att-meta:{scope}/{attId}`; chunks `att/{scope}/{attId}/c/{0..7}` `{iv, ct<=100000}`, AAD `att:{scope}/{attId}/{i}`. Scope `ch_{sid}_{cid}` | `dm_{dmId}` | `grp_{gid}`. Images are re-encoded (EXIF stripped) except small animated GIF/WebP. No video upload (Spark plan, RTDB only).
- Message body gains `attachments: [{attId,w,h,mime,size}] (<=4)` and `gif: {url,w,h}` (GIPHY links only), validated on send and render.
- Attach by button, paste, or dropping images anywhere on the chat pane (`DropZone` around `.chat-main`, feeding the composer draft). Images are removed with their message (author or moderator), and when a send fails after upload. `lib/media/cleanup.js` decrypts messages to find attachment ids and removes them when a channel, server or group is deleted, and an account's own images in servers, groups and DMs on account deletion (best effort, one removal per attachment).
- `appConfig/{giphyKey, turn[]}`: signed-in read, admins write (Admin panel -> "GIFs & calls").

### Theme
- `src/lib/theme.js`: dark / light / system, stored only in localStorage `codehub.theme`. `THEME_BOOT_SNIPPET` is inlined in index.html's `<head>` (sets `data-theme` before the first paint; a unit test keeps the two identical) and `initTheme()` in main.jsx keeps it in sync. The command palette has Toggle / Dark / Light / Match system actions. Light tokens in `:root[data-theme="light"]`; shop themes get derived light variants. Toggle in Settings -> Appearance.

### Plaintext by design (additions)
- Calls: who is in which call and when (slot uid, joinedAt, mic/cam/screen), call id/start/kind/starter, signaling envelope (from/to, ts, epoch), ring notif ids.
- Notifications: kind, sender uid, timestamp, opaque ids, read flag (no text).
- Media: avatars (readable by all signed-in users), attachment metadata ids/sizes/counts, emote author/ts, `appConfig` (GIPHY key and TURN credentials are client-visible).

### Limits
- No calls or notifications while the browser is closed (no push on Spark). Mesh capped at 6 (upload grows per peer). Peers see each other's IP addresses (TURN only if an admin configures it). A removed group member keeps their call slot until leaving but cannot signal.
- GIFs load from GIPHY: GIPHY sees viewer IPs and search terms (no-referrer is used). Animated uploads keep original bytes. Attachment cleanup on deletion is best effort: an image whose message can't be decrypted, or that a DM peer uploaded before the thread was wiped, can remain (unreadable, but counts toward the 1 GB quota).
- The rules are over the console's 100 KiB paste limit. `npm run rules:min` prints a behaviour-preserving minified copy (whitespace stripped, `.child()` chains merged; round 3 adds wildcard renaming and `==`, see "Rules size" below). Its size must stay at or below 102,400 bytes.
- Data outside a server/channel/group node (`emotes/{sid}`, `vcalls`, `vsignal`, `lastPost`, `votes/ch/{sid}[/{cid}]`, `votes/grp/{gid}`) may be cleared by any signed-in user once its server, channel or group no longer exists; the delete functions clear it in the same update.

## Overnight 2026-11-06 tier 2: chat extras and server extras

### chatx: polls, spoilers, bookmarks, forwarding (`src/lib/chatx`, `src/components/chatx`)
- **Polls**: the encrypted message body gains `poll: { q ≤200, options[2..10] each ≤80 }` (sanitised by `sanitizePoll` on send in `messages.cleanBody` and on render). Votes live at `votes/{path}/{mid}/{uid}` = plaintext option index 0-9, path = `messages.typingPath(conv)` (`ch/{sid}/{cid}` | `dm/{dmId}` | `grp/{gid}`). Plaintext so the rules enforce "own uid only, one vote per user". The server learns "uid voted option N", never the option text. Reads and writes require membership of the conversation (server member + existing channel and not timed out, DM member, or group member). Retract = remove the node. Composer: 📊 button opens `PollComposer`.
- **Spoilers/quotes**: `||text||` renders `<span class="spoiler">` via the marked extension `spoilerExtension` (in `lib/markdown.js`); click toggles `.revealed` (delegated in `Message.jsx`). Quotes use markdown blockquote.
- **Bookmarks**: `bookmarks/{uid}/{key}` = `{iv, ct, ts}`; ct = vault-encrypted JSON (conv ref, mid, author, snippet ≤600, savedAt) with AAD `bm:{uid}/{key}`; key = `${scope}_${mid}` with RTDB-forbidden chars replaced (idempotent). Owner-only read/write. Snippets are copies (deleting the original does not remove them). UI: 🔖 in the message toolbar saves; 🔖 in the header opens "Saved messages". At most 200 per user (checked by the client; the rules can't count children). Removed on account deletion.
- **Forwarding**: `forwardMessage` re-encrypts a body into the target conversation key as a new message by the forwarder, carrying `fwd: { from }` (display name, advisory only). `messages.cleanBody` preserves `fwd`; received `fwd` renders `ForwardedTag`. The message toolbar's Forward button opens `ForwardModal` with every text channel of my servers, my unblocked DMs and my groups (built in Workspace from `useNotifySources`). Text, code and GIFs are copied; images are not (they are encrypted under the source conversation). In a slowmode channel the forward carries the `lastPost` stamp, retried without it for exempt moderators.

### serverx: slowmode, categories, richer profiles, shortcuts (`src/lib/serverx`, `src/components/serverx`)
- **Slowmode**: `servers/{sid}/channels/{cid}/slowmode` = 1..21600 s (absent = off), written by `manageChannels` (channel edit modal → `SlowmodeControl`). `lastPost/{sid}/{cid}/{uid}` = server timestamp; uid-only read/write, members only, never deleted, value must be `now` and `now - previous ≥ slowmode*1000`. The message `uid` validate requires non-moderators in a slowmode channel to write `lastPost/…/{auth.uid} = now` in the **same** multi-path update (`sendMessage` does this via `slowmodeExtras`). Owner/admin/`manageMessages` are exempt. `SlowmodeBar` shows the countdown above the composer. `lastPost` entries are only deletable once their channel or server is gone.
- **Categories**: `servers/{sid}/categories/{catId}` = `{ enc:{iv,ct≤1024}, position }`, enc = server-key `encryptJSON({name})` with AAD `category:{sid}/{catId}`. Members read; `manageChannels` writes. A channel's optional `cat` (≤32 chars) must name an existing category of the same server (same update is fine); one left dangling by older data renders as uncategorized. Text channels are grouped in the sidebar; "Manage categories" in the server menu. Collapsed state is per-viewer `localStorage` (`codehub.collapsedCats`). Decrypted names are cleared with `clearPlainCache()`.
- **Richer profiles**: `users/{uid}/profile` = `{ bio≤190, pronouns≤40, links{0..2}: https URL ≤200, banner '#rrggbb' }`, publicly readable like `name`, owner write. Editor in Settings → My profile; card in the member profile popover. Links render `rel="noopener noreferrer nofollow ugc"`, https only. The rules use the same pattern as `cleanLink()` (`lib/serverx/links.js`: dotted host, optional port, no `user:pass@`); a unit test checks they match.
- **Shortcut overlay**: press `?` (not while typing, not with Ctrl/Meta/Alt, not over another modal); data in `lib/serverx/shortcuts.js` must match real bindings.

### Plaintext by design (tier 2 additions)
- Poll vote indices per uid (not option text), bookmark timestamps/count, slowmode seconds, `lastPost` timestamps, category positions and channel `cat` ids (category **names** stay encrypted), profile bio/pronouns/links/banner color.

### Tests
- Rules (`npm run test:rules`, 210): `serverx.test.mjs` (slowmode window, forgery, moderator exemption, categories, profile validation), `chatx.test.mjs` (votes by conversation kind, bookmarks), `gaps.test.mjs` (cleanup of data outside deleted servers/channels/groups, group mention/reply notifications, profile links, deleting single handled call signals).
- Unit (`npm run test:unit`, node --test): image header dimensions, reaction keys, tab title, `cleanLink` vs the rules pattern, the theme boot snippet.
- E2E (`npm run test:e2e`, Node 20 or 22): sign-up/server/invite/message, theme, mention bell, server emotes + autocomplete + forward + tab title, drag-and-drop upload + delete removes the image, and real two/three-browser calls (DM audio with camera switched on mid-call, DM video, three-person group video, server voice channel).

## Round 3: extension points

Round 3 features plug into stable extension points instead of editing the shared hot files. All of
this is client code plus five generic rules blocks; nothing needs a server.

### Ownership
- `src/features/<ws>/` belongs to one workstream (`bots`, `addons`, `assistant`, `calls`, `messaging`,
  `personal`, `community`). Its `index.js` registers everything the feature adds; `src/features/index.js`
  imports every folder once at start-up (from `src/main.jsx`) and is never edited by a workstream. The
  community shop (`shop` workstream) extends the existing `src/lib/shop.js`, `src/lib/addons/*` and
  `src/components/shop/*` instead of a feature folder.
- Feature docs: `docs/features/<ws>.md` (purpose, data paths, AAD strings, security notes, limits).
  Tests: `tests/rules/<ws>.test.mjs`, `tests/unit/<ws>.test.mjs`, `tests/e2e/<NN>-<ws>.spec.mjs`.
- Foundation (shared, change only through the integrator): `src/lib/ext/*` (registry, contexts, send
  pipeline, store helpers, core) and `src/components/ext/*` (slot components, `ext.css`).

### Registries (`src/lib/ext/registry.js`)
`register(name, entry) -> unregister()`, `list(name)`, `get(name, id)`, `unregister(name, id)`,
`subscribe(name, fn)`, React `useRegistry(name)`. Entries are `{ id, order?, ... }`, sorted by `order`
(default 0) then registration order; registering an existing id replaces it in place, and the returned
unregister only removes that exact entry. An entry without `id` but with a string `name` uses the name.
Every entry renders inside its own error boundary (`ExtRender`): a crash hides that entry (or shows a
short notice in panels and tabs) and never takes down the chat. Render functions receive plain values;
they should not call hooks themselves but return an element of their own component. Built-in UI always
comes first, extensions after.

| Registry | Entry | Where / ctx |
|---|---|---|
| `messageActions` | `{ id, label, icon?, inline?, danger?, when?(m, ctx), run(m, ctx) }` | Message hover toolbar: `inline` + `icon` entries get their own button, the rest a "More actions" menu (keyboard: arrows, Home/End, Esc). ctx = ChatContext |
| `messageBadges` | `{ id, render(m, ctx) => node, groupKey?(m) => string }` | After the author name. Messages only group under one header while every `groupKey` agrees (a bot reply starts its own header) |
| `messageExtras` | `{ id, render(m, ctx) => node }` | Under the message body (not for deleted, undecryptable or editing messages) |
| `composerButtons` | `{ id, label, icon, when?(ctx), run(ctx) }` or `{ id, render(ctx) }` | After the composer's own buttons. When the composer is narrower than 520 px (phones, or a panel open beside the chat) the text box takes its own row above the buttons |
| `sendHooks` | `{ id, order?, run(draft, ctx) }` | The send pipeline (below) |
| `slashCommands` | `{ name, description, args?, scopes?: ['channel','dm','group'], group?: 'builtin'\|'feature'\|'bot', run(argsText, ctx) }` | Composer `/` menu (grouped by `group`, default `feature`) and the first send hook |
| `chatHeaderButtons` | `{ id, label, icon?, panel?, when?(ctx), run?(ctx) }` | Chat header, after Pinned/Search. With `panel` the button toggles that chat panel (`aria-pressed`). At 900 px and below, past four buttons (two at 600 px) the rest move into a "More chat tools" menu, in registry order |
| `chatPanels` | `{ id, title, render(ctx) }` | Right-side panel inside ChatView, one at a time (shared with Search / Pinned), closable (button, Esc returns focus to the opener), an overlay below 900 px |
| `userSettingsTabs` | `{ id, label, visible?(ctx), render(ctx) }` | Settings modal after the built-in tabs. ctx = WorkspaceContext + `{ user, close }` |
| `serverSettingsTabs` | `{ id, label, icon?, visible?(ctx), render(ctx) }` | Server settings after the built-in tabs. ctx = WorkspaceContext + `{ sid, perms, me, server: { meta, members, roles, timeouts, myRole, meMember }, close }` |
| `paletteActions` | `{ id, title, hint?, keywords?, when?(ctx), run(ctx) }` | Command palette, merged with the built-in actions. ctx = WorkspaceContext |
| `profileSections` | `{ id, render(uid, ctx) }` | Member profile card. ctx = WorkspaceContext + `{ sid, member, isMe, close }` |
| `sidebarSections` | `{ id, render(ctx) }` | Top of the channel sidebar and of the DM/home sidebar. ctx = WorkspaceContext + `{ view: 'server', sid, server: { meta, channels, perms, myRole, tab, activeCid } }` or `{ view: 'home' }` |
| `appMounts` | `{ id, Component }` (gets `ctx` prop) or `{ id, render(ctx) }` | Mounted once inside the signed-in Workspace (schedulers, idle detection, add-on hosts) |
| `chatMounts` | `{ id, Component }` (gets `ctx` prop) or `{ id, render(ctx) }` | Mounted once per open ChatView inside its ChatContext, also while the composer is hidden (timeout, block, missing key): chat-level hooks without UI, e.g. messaging's bridge that lets message links jump. ctx = ChatContext |
| `adminTabs` | `{ id, label, render({ me }) }` | Admin panel, after the built-in tabs |
| `reportTargets` | `{ id, label, match(report), render(report), actions?(report, { act, dismiss, busy }) }` | Admin reports queue: the kind pill, target line and extra actions of matching reports (bots: kind `bot`; add-ons: kind `addon`, plus older `shopItem` + `addon:{id}` reports) |
| `serverCreateOptions` | `{ id, label, description?, icon?, render(ctx) }` | Extra choices in "Add a server"; the choice opens `render(ctx)` with ctx `{ me, name, color, busy, error, createWith(template), back(), close() }`. `template = { name?, color?, channels?: [{ type: 'text'|'code'|'voice', name, topic? }], after?({ sid, cids, generalCid, workspaceCid, uid }) }`; `createWith` creates the server in one update (`createServer(uid, { name, color, channels })`, up to 50 channels), awaits `after`, opens the server, and resolves to the result or `null` on failure |

Ids of settings tabs that collide with built-in tab ids are ignored. `when` / `visible` that throw count
as false. Actions that throw show their message as a toast.

### ChatContext (`src/lib/ext/chatContext.js`, `useChatCtx()`)
Provided by ChatView; the ctx of every chat-level point (message-level ctx is the same value).
- `conv`: `{ kind: 'channel'|'dm'|'group', sid?, cid?, dmId?, peerUid?, gid?, epoch?, ownerId?, name, title, scope }`.
- `me`: `{ uid, name, color, email, ...profile }`.
- `perms`: `permsFor()` of me in a server channel (`{ staff, manageChannels, …, manageApps }`), else `null`.
- `members`: `{ [uid]: member record }` of the server / group (DM: both participants).
- `messages`: loaded messages in order: `{ mid, uid, ts, body?, error?, pending?, deleted?, sending?, reactions?, pinned?, replyTo?, editedAt? }`; `body` is the decrypted JSON including extension keys.
- `profiles`: `{ [uid]: profile }` for members and authors.
- `canSend`: key loaded, not timed out, not blocked. `hasMore` / `loadOlder()`: page older history.
- `send(draft, { raw? })`: the full send pipeline (hooks, encryption, write, notifications); resolves `true`
  when sent or handled. `raw: true` skips the send hooks (use it when a command sends a reply, so it can't
  re-enter itself).
- `insertText(text)`: insert at the composer caret and focus it. `reply(mid)`: start a reply.
- `jumpTo(mid)`: scroll to and highlight a message, paging older history in; toasts when it's gone.
- `openPanel(id)`, `closePanel()`, `panel` (open chatPanels id or `null`).
- `toast(text, kind?)`: `'ok'` or `'error'` (default).
- `ephemeral({ id?, title?, text?, items?: [{ label, detail? }], render?() }) -> dismiss()`: a local-only card
  above the composer ("Only you can see this"); at most three, the same `id` replaces.

### WorkspaceContext (`src/lib/ext/workspaceContext.js`, `useWorkspaceCtx()`)
`{ me, nav, setNav, servers: [{ sid, joinedAt }], openSettings(tabId?), openServerSettings(tabId?),
openConv({ kind, sid, cid } | { kind: 'dm', dmId } | { kind: 'group', gid }), openVoice(sid, cid),
toast(text, 'success'|'error'|'info') }`. Tab ids can be built-in ones or registered tab ids.
`openVoice` (integration pass) joins a voice channel and opens its call view exactly like clicking it in
the sidebar (shows the server, never rings); it resolves once joined and rejects with the join error.

### Send pipeline and body extras (`src/lib/ext/send.js`)
Every send (composer text, snippets, GIFs, polls, `ctx.send`) runs `sendHooks` in order before
encryption: `run(draft, ctx)` returns a new draft, `{ handled: true }` (nothing is sent) or
`{ cancel: true, reason? }` (the reason is toasted; the composer keeps the text). `undefined` means
unchanged; a hook that throws or returns junk cancels the send. Images uploaded with a draft that ends up
handled or cancelled are deleted. `draft = { text, code?, attachments?, gif?, poll?, extra? }`.
`extra` is merged into the encrypted message body under keys matching `/^[a-z][a-zA-Z0-9]{0,23}$/` that
are not core keys (`text code invite attachments gif poll fwd`); they survive edits, are dropped on
forward, count toward the 45 KB body cap, and reach components as `m.body.<key>`. Old clients ignore
unknown keys. Extension body values are untrusted input: validate types before rendering, and render as
React text (never HTML).

### Slash commands
The first send hook (`core.slash`, order -1e9) runs a registered command when the text starts with
`/name` (`name` matches `/^[a-z0-9][a-z0-9_-]{0,31}$/`; the first entry by order wins a name;
`scopes` limits it to conversation kinds). `run(argsText, ctx)` returns a draft (continues through the
other hooks; attachments and `extra` are kept unless replaced), `{ handled: true }` or `{ cancel, reason }`.
An unknown `/word` is sent as plain text. The composer opens an accessible list when the text starts
with `/` (listbox + `aria-activedescendant`, arrows, Tab completes, Enter completes or runs a fully typed
command, Esc closes) and shows the command's usage while its arguments are typed. The list holds every
matching command, scrolls (the active row stays in view) and is grouped: "Built-in" (`group: 'builtin'`:
`/help` and the bots' chat commands), "Features" (the default) and "Bots in this server" (`group: 'bot'`);
within a group, names starting with the typed text come first, and a fully typed name starts selected.
The only core command is `/help` (local-only list of the commands available here).

### Generic rules blocks
| Path | Read | Write | Shape |
|---|---|---|---|
| `udata/{uid}/{feat}/{key}[/{f}]` | owner | owner | leaf or object of leaves; strings ≤ 20000 |
| `upub/{uid}/{feat}/{key}[/{f}]` | signed in | owner | as udata; strings ≤ 2000 |
| `sconf/{sid}/{feat}/{key}[/{f}]` | members | owner, admins, custom role with `manageApps` (per `{feat}`) | as udata; strings ≤ 20000. All of `sconf/{sid}` can be removed once the server is gone (or in the update that deletes it) |
| `sitems/{sid}/{feat}/{id}/{f}` | members | create: member, not timed out, `by` = me; update: the author (member, not timed out); delete: the author, owner, admins, `manageMessages` | object of leaves with `by` (never changes); `{id}` ≤ 128; fields `by iv ct s v ts` only, `ct` ≤ 20000, the others ≤ 200. Garbage once the server is gone |
| `pub/{kind}/{id}/{f}`, kind `bots` `addons` `addonCode` `servers` | signed in (`.indexOn: by, ts`) | create: `by` = me, in the same update as `publishLog/{me}` = now (one create per minute, shared with games and shop items) and `udata/{me}/pub/last` = `{id}`; app admins create without them; update/delete: `by` only; app admins delete; `pub/servers/{sid}` only by that server's owner | object of leaves with `by` and `ts` = server now on **every** write; only the field names in `PUB_FIELDS` (`store.js`); `code` ≤ 65536, `def` and `img` ≤ 20000, the others ≤ 1000 |

`{feat}` matches `/^[a-z][a-zA-Z0-9]{0,23}$/`, `{key}` ≤ 128 chars, field names ≤ 64, values are numbers,
booleans or strings, nothing deeper than `{f}`; `udata/{uid}` and `upub/{uid}` themselves must be objects.
The `sitems` and `pub` field allowlists (round 3 security fix R1, `docs/features/sec-misc.md`) bound every
item: a feature that needs a new field there adds it to the rules' list (and `SITEM_FIELDS` / `PUB_FIELDS`).
`putPub` stamps creates itself; a hand-written multi-path create adds `pubCreateStamp(id)` and goes
through `commitPubCreate` (friendly "try again in N seconds" error). Writes go per item (`{key}`/`{id}` or deeper; a
multi-path update of several items is fine). `deleteServer` clears `sconf/{sid}` and `sitems/{sid}` in its
update and then removes `pub/servers/{sid}`; account deletion removes `udata/{uid}`, `upub/{uid}` and every
`pub` entry the user published. The rules cannot count children: per-user or per-server caps are the
feature's UI's job (document them).

### Helpers (`src/lib/ext/store.js`)
- Refs: `udataRef(feat, key?)` (me), `upubRef(uid, feat, key?)`, `sconfRef(sid, feat, key?)`,
  `sitemsRef(sid, feat, id?)`, `pubRef(kind, id?)`; path builders `udataPath`…`pubPath` validate names.
- Writes with fixed fields: `addSitem(sid, feat, fields) -> id` (`by` = me), `updateSitem`, `putPub(kind, id?, fields) -> id`
  and `updatePub` (`by` = me, `ts` = server time).
- Live hooks (listeners cleaned up on unmount or argument change), each `{ loading, value, error }`:
  `useUdata(feat, key?)`, `useUpub(uid, feat, key?)`, `useSconf(sid, feat, key?)`,
  `useSitems(sid, feat, { last?, by? })` (+ `items`), `usePub(kind, id?, { last = 100, by? })` (+ `items`, newest first).
- Encryption: `sealForServer(sid, aad, obj) -> {iv, ct}` / `openForServer(sid, aad, box)` (server key,
  AES-GCM; the AAD must contain `:{sid}`), `sealForMe(aad, obj)` / `openForMe(aad, box)` (vault key, like
  snippets). Store a box as the item itself (`{ iv, ct }`) or in two fields; `boxFits(box, limit)` checks
  the leaf limit.

### AAD strings for round 3 content
Server-scoped content users type (event titles, notes, AutoMod word lists, welcome text, …) in
`sconf`/`sitems` is sealed with the server key under `<kind>:{sid}/{id}` (for config without an id,
`<kind>:{sid}/{key}`). Private data in `udata` uses `sealForMe` with `<kind>:{uid}/{key}`. Each feature
lists its kinds in `docs/features/<ws>.md`; kinds must be unique across features. `upub` and `pub` are
plaintext by design.

### `manageApps` permission
Custom roles gain `manageApps` ("Install bots and add-ons, and edit server features such as AutoMod, the
welcome screen and discovery."): `PERMS`, labels and hints in `src/lib/roles.js`, the rules' role flag list,
and the "can't grant what you don't hold" check. Owner and admins hold it implicitly; it gates `sconf` writes.

### Rules size
The console paste limit (102,400 bytes of minified rules) is a hard ceiling. `npm run -s rules:min`
now also renames `$wildcards` to short names (injective, most-used first, never inside strings or
regexes) and writes `===`/`!==` as `==`/`!=` (the probes in `tests/rules/ext.test.mjs` show RTDB treats
them identically for every type mix), and keeps a space only where two operator characters would fuse.
The full rules suite passes against the minified output (`RULES_PATH=<file> npm run test:rules`).
Sizes: main before round 3 was 98,594 bytes with the old minifier and is 95,052 with this one; the
`manageApps` flag adds 204 and the five generic blocks 2,901, so the foundation commit is 98,157 bytes
(4,243 bytes left under the ceiling for all round 3 workstreams). Prefer the generic blocks over new paths.
With seven workstreams merged (bots, add-ons, assistant, messaging, personal, community, shop) the rules were
100,024 bytes; the integration pass's `bot|addon` report kinds bring them to 100,034 (calls not yet merged).

### Integration pass notes
- **Desktop alerts and Do Not Disturb.** `showNotification` (`src/lib/notify.js`) is the only way to show a
  desktop notification and shows nothing while Do Not Disturb is on (`force: true` only for the explicit
  "test notification" button). `desktopAlertsOn(settings)` combines the desktop setting, the browser
  permission and DND for callers (message alerts, the bell, event and message reminders); sound players check
  `alertsSilenced()` (the call ringtone checks DND itself). Bell entries, unread counts and in-app cards are
  unaffected.
- **Decrypted-name cache.** Hooks that read `peekPlain()` while rendering (`useChannels`, `useServerMeta`, the
  favorites row) adopt a value their effect finds in the cache instead of skipping it: another component (the
  notifier decrypts every server's channel names) can fill the cache between a render and its effect, and
  skipping left a new server's channel names blank. `getServerKey`/`getPublicKey` only evict their own failed
  read, never a key cached meanwhile.
- **Account deletion** also removes my community shop items, my uncollected earnings (one entry at a time), and
  in servers I leave the `sitems` I wrote (events, RSVPs, the rules-accepted marker), plus per-account browser
  data whose key contains my uid. `notifLog/{uid}` is not deletable (rate-limit window) and was dropped from the
  private-node batch, whose refusal had stopped deletion before the Auth account was removed.
- **Consistency.** Settings' built-in shop tab is "Shop items" (it clashed with "Add-on apps"); the profile's
  legacy status field is "Profile status" and says the custom status shows instead while set; server settings
  tabs wrap; the `?` overlay lists the palette's Ctrl/⌘ Shift P, the assistant's Ctrl/⌘ Shift Y, `/` and Tab.

### Tests and ports
`CODEHUB_PORT_BASE` picks a port block for `test:rules` and `test:e2e` (`scripts/test-ports.mjs`): the
default 9000 keeps the historical ports (database 9000, auth 9099, Vite 5199, hub 4400, logging 4500);
base B uses database B, auth B+99, Vite B+80, hub B+50, logging B+51. The runner
(`scripts/test-env.mjs`) writes `firebase.test-<base>.json` (gitignored), passes it with `--config`, and
only ever stops processes listening on its own block. `npm run test:rules -- tests/rules/x.test.mjs` and
`npm run test:e2e -- 40-ext` run a subset. In dev and emulator builds `window.__codehubTestExt`
(`{ register, unregister, list, h }`, h = `React.createElement`) lets browser tests register throwaway entries; production builds
don't include it.

### Update notice (`src/lib/appVersion.js`, `src/components/common/UpdateBanner.jsx`)
A small plugin in `vite.config.js` gives each build an id `{ v, t }` (git short sha, else `GITHUB_SHA`, else a time
id; build time as ISO): it writes `dist/version.json`, defines the same object as `__CODEHUB_BUILD__`, and the dev
server answers `/version.json` too. `startUpdateWatch()` (main.jsx) fetches `version.json` resolved against
`document.baseURI` (so the `/codehub/` sub-path is kept) with `cache: 'no-store'` and a `?t=` query, on start, every
5 minutes while visible, and on `visibilitychange`/`online`. A different `v` (unless its `t` is older than the
running build's: a stale CDN copy) shows the banner "Codehub has been updated…" with Reload and Later; Later hides it
until another id appears. The banner is mounted next to `<App />`, so it also shows on the sign-in screen; it never
reloads by itself and never takes focus.
A deploy removes the old hashed chunks, so an old tab's lazy views fail. `vite:preloadError`, unhandled
dynamic-import rejections and the layout/extension error boundaries (`reportLoadError`) report them; the tab then
reloads once by itself only if nothing could be lost (no focused editable, no visible field with text, no files in
an attachment tray, no active call, online) and the guard in `sessionStorage['codehub.autoReload']` (`{ from, at }`)
allows it: never again from the same build and never within 5 minutes of the last one. Otherwise the banner says a
part of the app couldn't load, and the view's error boundary shows a Reload button instead of "Try again".
Tests: `tests/unit/update.test.mjs`, `tests/e2e/50-update.spec.mjs`.

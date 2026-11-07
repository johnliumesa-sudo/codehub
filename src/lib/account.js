// Account deletion: wipe everything the user wrote, then delete the Auth account.
//
// There are no Cloud Functions, so the client does the cleanup while it is still signed in,
// in an order the rules allow:
//   1. servers I own are deleted outright; in other servers my messages (and the images attached to
//      them) are removed and I leave; the same for groups; images I sent in DMs are removed;
//   2. friend links (both sides) are removed;
//   3. my profile is removed — the rules then let me wipe whole DM threads I'm in (both
//      people's messages) and the peer's index entry for them;
//   4. what I published (bots, add-ons, discovery listings, community shop items) and my uncollected
//      shop earnings are removed;
//   5. my private nodes (vault, presence, reads, indexes, saved messages, round 3 udata/upub) are removed;
//   6. the Firebase Auth user is deleted.
// Each step tolerates data that is already gone, so a retry after a partial failure finishes the job.
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  deleteUser,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
} from 'firebase/auth';
import { equalTo, get, orderByChild, query, ref, remove, update } from 'firebase/database';
import { auth, db } from './firebase.js';
import { stopPresence } from './presence.js';
import { lock } from './keystore.js';
import { clearPlainCache, deleteServer, leaveServer, peerFromDmId } from './servers.js';
import { cleanupCodespacesForAccount } from './codespaces.js';
import { deleteGroup, leaveGroup, removeMyGroupMessages } from './groups.js';
import { deleteMyGames } from './games.js';

const CHUNK = 500; // paths per multi-path update

const val = async (path) => (await get(ref(db, path))).val();

/** Best effort: remove each path in its own write (one refused path must not block the others). */
async function removeEach(paths) {
  for (const p of paths) {
    try {
      await remove(ref(db, p));
    } catch {
      /* already gone, or not mine any more */
    }
  }
}

async function removePaths(paths) {
  for (let i = 0; i < paths.length; i += CHUNK) {
    const batch = Object.fromEntries(paths.slice(i, i + CHUNK).map((p) => [p, null]));
    await update(ref(db), batch);
  }
}

/** 'password' | 'google' | null — how the current user can re-authenticate. */
export function signInMethod(user = auth.currentUser) {
  const ids = (user?.providerData || []).map((p) => p.providerId);
  if (ids.includes('password')) return 'password';
  if (ids.includes('google.com')) return 'google';
  return null;
}

/** Firebase only deletes accounts that signed in recently; re-authenticate first. */
export async function reauthenticate(password) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  if (signInMethod(user) === 'password') {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password || ''));
  } else {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account', login_hint: user.email || '' });
    await reauthenticateWithPopup(user, provider);
  }
}

async function wipeServer(sid, uid, onStep) {
  let meta = null;
  try {
    meta = await val(`servers/${sid}/meta`);
  } catch {
    // Not a member any more (kicked, banned or deleted): only my index entry is left.
  }
  if (!meta) return remove(ref(db, `userServers/${uid}/${sid}`));
  if (meta.ownerId === uid) {
    onStep?.('Deleting a server you own…');
    return deleteServer(sid, uid);
  }
  onStep?.('Removing your messages from a server…');
  // Round 3 server items I wrote (events, RSVPs, the rules-accepted marker, …): the author may delete
  // each one, and only while still a member (members-only read).
  try {
    const items = (await val(`sitems/${sid}`)) || {};
    await removeEach(Object.entries(items).flatMap(([feat, byId]) => Object.entries(byId || {})
      .filter(([, it]) => it && it.by === uid)
      .map(([id]) => `sitems/${sid}/${feat}/${id}`)));
  } catch {
    /* best effort */
  }
  const channels = (await val(`servers/${sid}/channels`)) || {};
  for (const cid of Object.keys(channels)) {
    const mine = await get(query(ref(db, `messages/${sid}/${cid}`), orderByChild('uid'), equalTo(uid)));
    const { purgeAttachments } = await import('./media/cleanup.js');
    await purgeAttachments({ kind: 'channel', sid, cid }, mine.val(), { onlyUid: uid });
    await removePaths(Object.keys(mine.val() || {}).map((mid) => `messages/${sid}/${cid}/${mid}`));
  }
  await leaveServer(sid, uid);
}

async function wipeGroup(gid, uid, onStep) {
  let meta = null;
  try {
    meta = await val(`groups/${gid}/meta`);
  } catch {
    // No longer a member (removed, or the group was deleted): only my index entry is left.
  }
  if (!meta) return remove(ref(db, `userGroups/${uid}/${gid}`));
  if (meta.ownerId === uid) {
    onStep?.('Deleting a group you own…');
    return deleteGroup(gid);
  }
  onStep?.('Removing your messages from a group…');
  await removeMyGroupMessages(gid, uid); // must run while still a member (read access)
  await leaveGroup(gid);
}

/**
 * Delete all of the signed-in user's data and their account. Call reauthenticate() first.
 * onStep(text) reports progress.
 */
export async function deleteAccount(onStep) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const uid = user.uid;
  const { purgeConversationAttachments } = await import('./media/cleanup.js');

  onStep?.('Signing you out of presence…');
  await stopPresence();

  for (const sid of Object.keys((await val(`userServers/${uid}`)) || {})) await wipeServer(sid, uid, onStep);

  // Codespaces I own are deleted (with every member's index entry); others I leave.
  await cleanupCodespacesForAccount(uid, onStep);

  // Groups I own are deleted; others I leave after removing my messages (vault still unlocked).
  for (const gid of Object.keys((await val(`userGroups/${uid}`)) || {})) await wipeGroup(gid, uid, onStep);

  // Public games I published (and, best effort, my likes on other games).
  await deleteMyGames(uid, onStep);

  // Images I sent in DMs, while my profile and keys still exist (the threads are wiped further down).
  onStep?.('Removing images you sent in direct messages…');
  for (const [dmId, d] of Object.entries((await val(`userDms/${uid}`)) || {})) {
    const peer = d?.peer || peerFromDmId(dmId, uid);
    if (peer) await purgeConversationAttachments({ kind: 'dm', dmId, peerUid: peer }, { onlyUid: uid });
  }
  onStep?.('Removing friends…');
  const friends = Object.keys((await val(`friends/${uid}`)) || {});
  await removePaths(friends.flatMap((other) => [`friends/${uid}/${other}`, `friends/${other}/${uid}`]));

  onStep?.('Removing your profile…');
  await remove(ref(db, `users/${uid}`));

  onStep?.('Deleting your direct messages…');
  const dms = (await val(`userDms/${uid}`)) || {};
  for (const [dmId, d] of Object.entries(dms)) {
    const peer = d?.peer || peerFromDmId(dmId, uid);
    // Separate writes: the peer's index entry may already be gone or never have existed.
    await remove(ref(db, `dmMessages/${dmId}`));
    await removePaths([`dms/${dmId}/members/${uid}`, `typing/dm/${dmId}/${uid}`, `userDms/${uid}/${dmId}`]);
    if (peer) {
      await remove(ref(db, `dms/${dmId}/members/${peer}`)).catch(() => {});
      await remove(ref(db, `userDms/${peer}/${dmId}`)).catch(() => {});
    }
  }

  // Round 3 public catalog entries I published (bots, add-ons and their code, server listings).
  onStep?.('Removing what you published…');
  for (const kind of ['bots', 'addons', 'addonCode', 'servers']) {
    try {
      const mine = await get(query(ref(db, `pub/${kind}`), orderByChild('by'), equalTo(uid)));
      await removePaths(Object.keys(mine.val() || {}).map((id) => `pub/${kind}/${id}`));
    } catch {
      /* best effort: nothing published, or already gone */
    }
  }
  // Community shop items I created (the creator may delete them, also after an admin took one down),
  // then my uncollected earnings, one entry at a time (that is all the rules allow). Collected coins
  // stay in wallets/{uid}, which no client can delete.
  try {
    const items = (await val('shop/items')) || {};
    await removeEach(Object.entries(items).filter(([, it]) => it && it.by === uid).map(([id]) => `shop/items/${id}`));
  } catch {
    /* best effort */
  }
  try {
    await removeEach(Object.keys((await val(`earnings/${uid}`)) || {}).map((k) => `earnings/${uid}/${k}`));
  } catch {
    /* best effort */
  }

  onStep?.('Removing your keys and settings…');
  // userDms, userServers and friends were cleared entry by entry above (the rules only allow that).
  // wallets/{uid}, inventory/{uid}, publishLog/{uid}, promoAttempts/{uid}, reportLog/{uid},
  // attLog/{uid} (upload rate window), notifLog/{uid} (notification rate window) and admins/{uid} are
  // not deletable by any client, by design (see README). notifLog used to be in this batch, and the
  // rules' refusal failed the whole batch, so the account itself was never deleted. Emotes I added stay with their server: they belong to it, not to me.
  await removePaths([
    `reads/${uid}`,
    `presence/${uid}`,
    `vaults/${uid}`,
    `equipped/${uid}`,
    `blocks/${uid}`,
    `verified/${uid}`,
    `notifPrefs/${uid}`,
    `snippets/${uid}`,
    `adminBadges/${uid}`,
    `notifs/${uid}`,
    `avatars/${uid}`,
    `bookmarks/${uid}`,
  ]);
  // Round 3 per-user data. Separate, best-effort writes: until the round 3 rules are published these
  // paths don't exist in the rules, and one refused path would fail the whole batch above.
  await Promise.all([`udata/${uid}`, `upub/${uid}`].map((p) => update(ref(db), { [p]: null }).catch(() => {})));
  try {
    localStorage.removeItem('codehub.trustedDomains');
    sessionStorage.removeItem('codehub.keyChangeAck');
    // Per-account browser data keyed by my uid (round 3: the assistant's API key and settings, sealed
    // drafts, …). Device-wide preferences (theme, appearance) stay.
    for (const k of Object.keys(localStorage)) if (k.startsWith('codehub.') && k.includes(uid)) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }

  onStep?.('Deleting your account…');
  lock();
  clearPlainCache();
  await deleteUser(user);
}

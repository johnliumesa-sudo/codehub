// Account deletion: wipe everything the user wrote, then delete the Auth account.
//
// There are no Cloud Functions, so the client does the cleanup while it is still signed in,
// in an order the rules allow:
//   1. servers I own are deleted outright; in other servers my messages are removed and I leave;
//   2. friend links (both sides) are removed;
//   3. my profile is removed — the rules then let me wipe whole DM threads I'm in (both
//      people's messages) and the peer's index entry for them;
//   4. my private nodes (vault, presence, reads, indexes) are removed;
//   5. the Firebase Auth user is deleted.
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

const CHUNK = 500; // paths per multi-path update

const val = async (path) => (await get(ref(db, path))).val();

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
  const channels = (await val(`servers/${sid}/channels`)) || {};
  for (const cid of Object.keys(channels)) {
    const mine = await get(query(ref(db, `messages/${sid}/${cid}`), orderByChild('uid'), equalTo(uid)));
    await removePaths(Object.keys(mine.val() || {}).map((mid) => `messages/${sid}/${cid}/${mid}`));
  }
  await leaveServer(sid, uid);
}

/**
 * Delete all of the signed-in user's data and their account. Call reauthenticate() first.
 * onStep(text) reports progress.
 */
export async function deleteAccount(onStep) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const uid = user.uid;

  onStep?.('Signing you out of presence…');
  await stopPresence();

  for (const sid of Object.keys((await val(`userServers/${uid}`)) || {})) await wipeServer(sid, uid, onStep);

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

  onStep?.('Removing your keys and settings…');
  // userDms, userServers and friends were cleared entry by entry above (the rules only allow that).
  await removePaths([`reads/${uid}`, `presence/${uid}`, `vaults/${uid}`]);

  onStep?.('Deleting your account…');
  lock();
  clearPlainCache();
  await deleteUser(user);
}

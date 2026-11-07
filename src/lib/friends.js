// Friends and server invites sent over DMs.
//
// friends/{uid}/{otherUid} = { state, ts } where state is
//   'out'     — I sent them a request        (they hold 'in')
//   'in'      — they sent me a request       (they hold 'out')
//   'friends' — accepted on both sides
// Both halves are written in one multi-path update; the rules only accept matching pairs.
import { useEffect, useState } from 'react';
import { get, onValue, ref, serverTimestamp, update } from 'firebase/database';
import { db } from './firebase.js';
import { sendMessage } from './messages.js';
import { createInvite, dmScope, inviteLink, openDm } from './servers.js';
import { deliverNotif } from './notifSend.js';

const pair = (me, other, mine, theirs) => {
  const ts = serverTimestamp();
  return {
    [`friends/${me}/${other}`]: mine && { state: mine, ts },
    [`friends/${other}/${me}`]: theirs && { state: theirs, ts },
  };
};

/** Send a request, or accept theirs if they already asked me. Returns the new state. */
export async function addFriend(me, other) {
  if (!other || other === me) throw new Error("You can't add yourself");
  const cur = (await get(ref(db, `friends/${me}/${other}/state`))).val();
  if (cur === 'friends' || cur === 'out') return cur;
  if (cur === 'in') {
    await acceptFriend(me, other);
    return 'friends';
  }
  await update(ref(db), pair(me, other, 'out', 'in'));
  // Bell entry for them; the rules accept it only while their side reads 'in'.
  deliverNotif({ to: other, kind: 'friendReq' });
  return 'out';
}

export function acceptFriend(me, other) {
  return update(ref(db), pair(me, other, 'friends', 'friends'));
}

/** Decline, cancel or unfriend: clears both sides. */
export function removeFriend(me, other) {
  return update(ref(db), pair(me, other, null, null));
}

/** Live list: [{ uid, state, ts }] (empty while loading). */
export function useFriends(uid) {
  const [st, setSt] = useState({ loading: true, list: [] });
  useEffect(() => {
    if (!uid) return undefined;
    return onValue(
      ref(db, `friends/${uid}`),
      (s) => {
        const v = s.val() || {};
        setSt({ loading: false, list: Object.entries(v).map(([u, f]) => ({ uid: u, state: f.state, ts: f.ts || 0 })) });
      },
      () => setSt({ loading: false, list: [] }),
    );
  }, [uid]);
  return st;
}

/**
 * Invite someone to a server through an encrypted DM: a single-use invite valid for 7 days. The
 * link (which carries the server key in its fragment) travels only inside the E2EE DM.
 */
export async function sendServerInvite(me, peerUid, sid, serverName) {
  const iid = await createInvite(sid, me.uid, { expiresInMs: 7 * 86_400_000, maxUses: 1 });
  const link = await inviteLink(sid, iid);
  const dmId = await openDm(me.uid, peerUid);
  const conv = { kind: 'dm', dmId, peerUid, scope: dmScope(dmId) };
  const { done } = await sendMessage(conv, me, {
    text: `Join me on **${serverName || 'my server'}**: ${link}`,
    invite: { name: serverName || '' },
  });
  await done;
  return dmId;
}

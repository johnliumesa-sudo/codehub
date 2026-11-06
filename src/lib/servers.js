// Server / channel / invite / DM helpers. All names and topics are encrypted with the
// server's room key before they touch the database (see ARCHITECTURE.md for AAD strings).
import { get, push, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { db } from './firebase.js';
import {
  decryptJSON,
  decryptText,
  dmIdFor,
  encryptJSON,
  encryptText,
  exportRoomKey,
  generateRoomKey,
} from './crypto.js';
import { cacheServerKey, getPublicKey, getServerKey, importInviteKey, wrapServerKeyFor } from './keystore.js';
import { AVATAR_COLORS } from './profiles.js';

export const SERVER_COLORS = AVATAR_COLORS;
export const MAX_SERVER_NAME = 64;
export const MAX_CHANNEL_NAME = 48;
export const MAX_TOPIC = 256;

export const aad = {
  serverName: (sid) => `server-name:${sid}`,
  channel: (sid, cid) => `channel:${sid}/${cid}`,
};

export const channelScope = (sid, cid) => `${sid}_${cid}`;
export const dmScope = (dmId) => `dm_${dmId}`;

const newKey = (path) => push(ref(db, path)).key;

// ---------- Plaintext cache (in memory only, cleared on lock) ----------

const plain = new Map(); // cacheKey -> decrypted value

export function peekPlain(key) {
  return plain.get(key);
}

export function clearPlainCache() {
  plain.clear();
}

export const serverNameCacheKey = (sid, box) => `sn|${sid}|${box?.iv}|${box?.ct}`;
export const channelCacheKey = (sid, cid, box) => `ch|${sid}/${cid}|${box?.iv}|${box?.ct}`;

// ---------- Name hygiene ----------

export function cleanServerName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SERVER_NAME);
}

// Discord-style slug: lowercase, dashes, no leading/trailing separators.
export function cleanChannelName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-.]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_CHANNEL_NAME);
}

export function cleanTopic(topic) {
  return String(topic || '').trim().slice(0, MAX_TOPIC);
}

// ---------- Encryption helpers ----------

export async function decryptServerName(sid, box) {
  const k = serverNameCacheKey(sid, box);
  if (plain.has(k)) return plain.get(k);
  const key = await getServerKey(sid);
  const name = await decryptText(key, box, aad.serverName(sid));
  plain.set(k, name);
  return name;
}

export async function decryptChannel(sid, cid, box) {
  const k = channelCacheKey(sid, cid, box);
  if (plain.has(k)) return plain.get(k);
  const key = await getServerKey(sid);
  const v = await decryptJSON(key, box, aad.channel(sid, cid));
  const out = { name: String(v?.name || 'untitled'), topic: String(v?.topic || '') };
  plain.set(k, out);
  return out;
}

async function encChannel(key, sid, cid, name, topic) {
  return encryptJSON(key, { name, topic }, aad.channel(sid, cid));
}

// ---------- Servers ----------

/**
 * Create a server in ONE multi-path update:
 *   servers/{sid}/meta, members/{me}=owner, keys/{me}, channels/{general,workspace}, userServers/{me}/{sid}
 * Returns { sid, generalCid, workspaceCid }.
 */
export async function createServer(uid, { name, color }) {
  const clean = cleanServerName(name);
  if (!clean) throw new Error('Give your server a name');
  const sid = newKey('servers');
  const generalCid = newKey(`servers/${sid}/channels`);
  const workspaceCid = newKey(`servers/${sid}/channels`);
  const key = await generateRoomKey();
  const [nameEnc, wrapped, generalEnc, workspaceEnc] = await Promise.all([
    encryptText(key, clean, aad.serverName(sid)),
    wrapServerKeyFor(sid, uid, key),
    encChannel(key, sid, generalCid, 'general', 'Say hello 👋'),
    encChannel(key, sid, workspaceCid, 'workspace', 'Shared code workspace'),
  ]);
  const now = serverTimestamp();
  await update(ref(db), {
    [`servers/${sid}/meta`]: { nameEnc, ownerId: uid, color: color || SERVER_COLORS[0], createdAt: now },
    [`servers/${sid}/members/${uid}`]: { role: 'owner', joinedAt: now },
    [`servers/${sid}/keys/${uid}`]: wrapped,
    [`servers/${sid}/channels/${generalCid}`]: { type: 'text', enc: generalEnc, position: 0, createdAt: now },
    [`servers/${sid}/channels/${workspaceCid}`]: { type: 'code', enc: workspaceEnc, position: 1, createdAt: now },
    [`userServers/${uid}/${sid}`]: { joinedAt: now },
  });
  cacheServerKey(sid, key);
  return { sid, generalCid, workspaceCid };
}

export async function updateServer(sid, { name, color }) {
  const patch = {};
  if (name !== undefined) {
    const clean = cleanServerName(name);
    if (!clean) throw new Error('Server name cannot be empty');
    const key = await getServerKey(sid);
    patch.nameEnc = await encryptText(key, clean, aad.serverName(sid));
  }
  if (color) patch.color = color;
  if (Object.keys(patch).length) await update(ref(db, `servers/${sid}/meta`), patch);
}

// Owner only. Removes the server tree, its messages and collab data, and my index entry.
// Other members' userServers entries become stale; their clients show the server as unavailable.
export async function deleteServer(sid, uid) {
  await update(ref(db), {
    [`messages/${sid}`]: null,
    [`collab/${sid}`]: null,
    [`audit/${sid}`]: null,
    [`servers/${sid}`]: null,
    [`userServers/${uid}/${sid}`]: null,
  });
}

export async function leaveServer(sid, uid) {
  await update(ref(db), {
    [`servers/${sid}/keys/${uid}`]: null,
    [`servers/${sid}/members/${uid}`]: null,
    [`userServers/${uid}/${sid}`]: null,
  });
}

// Drop a stale index entry (server deleted, or I was kicked/banned).
export function forgetServer(sid, uid) {
  return remove(ref(db, `userServers/${uid}/${sid}`));
}

// ---------- Members ----------

export function setMemberRole(sid, uid, role) {
  if (role !== 'admin' && role !== 'member') throw new Error('Invalid role');
  return set(ref(db, `servers/${sid}/members/${uid}/role`), role);
}

// Kick/ban also drop the target's userServers index entry in the same atomic write, so the server
// leaves their rail right away. The rules allow that only while the member is being removed.
export function kickMember(sid, uid) {
  return update(ref(db), {
    [`servers/${sid}/members/${uid}`]: null,
    [`servers/${sid}/keys/${uid}`]: null,
    [`userServers/${uid}/${sid}`]: null,
  });
}

export function banMember(sid, uid) {
  return update(ref(db), {
    [`servers/${sid}/bans/${uid}`]: true,
    [`servers/${sid}/members/${uid}`]: null,
    [`servers/${sid}/keys/${uid}`]: null,
    [`userServers/${uid}/${sid}`]: null,
  });
}

export function unbanMember(sid, uid) {
  return remove(ref(db, `servers/${sid}/bans/${uid}`));
}

// Power ordering for UI checks (rules enforce the real thing).
export const ROLE_RANK = { owner: 3, admin: 2, member: 1 };
export const canManage = (role) => role === 'owner' || role === 'admin';
export const canModerate = (myRole, theirRole) => (ROLE_RANK[myRole] || 0) > (ROLE_RANK[theirRole] || 0) && canManage(myRole);

// ---------- Invites ----------

export async function createInvite(sid, uid, { expiresInMs = 0, maxUses = 0 } = {}) {
  const r = push(ref(db, `servers/${sid}/invites`));
  await set(r, {
    createdBy: uid,
    createdAt: serverTimestamp(),
    expiresAt: expiresInMs ? Date.now() + expiresInMs : 0,
    maxUses: Math.max(0, maxUses | 0),
    uses: 0,
  });
  return r.key;
}

export function revokeInvite(sid, iid) {
  return remove(ref(db, `servers/${sid}/invites/${iid}`));
}

// The room key travels only in the URL fragment, which browsers never send to servers.
export async function inviteLink(sid, iid) {
  const key = await getServerKey(sid);
  return `${location.origin}${location.pathname}#/join/${sid}/${iid}/${await exportRoomKey(key)}`;
}

export function parseInviteLink(text) {
  const m = String(text || '').trim().match(/#\/join\/([^/\s]+)\/([^/\s]+)\/([^/\s#?]+)/);
  return m ? { sid: m[1], inviteId: m[2], key: m[3] } : null;
}

export function inviteState(inv, now = Date.now()) {
  if (!inv) return 'missing';
  if (inv.expiresAt && inv.expiresAt <= now) return 'expired';
  if (inv.maxUses && (inv.uses || 0) >= inv.maxUses) return 'used up';
  return 'active';
}

const isDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e));

/**
 * Join a server from an invite { sid, inviteId, key }.
 * ONE atomic multi-path update: members/{me}={role:'member', joinedAt, invite}, keys/{me},
 * userServers/{me}/{sid} and invites/{iid}/uses = uses + 1. The rules only accept the membership
 * write together with the counter bump, so maxUses is enforced server-side. Concurrent joins race
 * on the counter; the loser gets PERMISSION_DENIED and retries with the fresh value.
 *
 * If I'm already a member (e.g. I reset my vault and got a fresh invite), my wrapped key is
 * replaced with one for my current public key so the server becomes decryptable again.
 * Returns { sid, alreadyMember, rewrapped? }.
 */
export async function joinServer(uid, { sid, inviteId, key }) {
  if (!sid || !inviteId || !key) throw new Error('That invite link is incomplete');

  // Already a member? (Non-members can't read members/ — treat a denial as "no".)
  let alreadyMember = false;
  try {
    alreadyMember = (await get(ref(db, `servers/${sid}/members/${uid}`))).exists();
  } catch (e) {
    if (!isDenied(e)) throw e;
  }

  if (alreadyMember) {
    // Re-wrap the room key for my current keypair only if my stored copy is unusable.
    let usable = false;
    try {
      await getServerKey(sid);
      usable = true;
    } catch {
      usable = false;
    }
    if (!usable) {
      let wrapped;
      try {
        ({ wrapped } = await importInviteKey(sid, key));
      } catch {
        throw new Error('That invite link is damaged (bad key)');
      }
      await update(ref(db), {
        [`servers/${sid}/keys/${uid}`]: wrapped,
        [`userServers/${uid}/${sid}`]: { joinedAt: serverTimestamp() },
      });
      clearPlainCache();
      return { sid, alreadyMember: true, rewrapped: true };
    }
    await set(ref(db, `userServers/${uid}/${sid}`), { joinedAt: serverTimestamp() }).catch(() => {});
    return { sid, alreadyMember: true };
  }

  let wrapped;
  try {
    ({ wrapped } = await importInviteKey(sid, key));
  } catch {
    throw new Error('That invite link is damaged (bad key)');
  }

  const inviteRef = ref(db, `servers/${sid}/invites/${inviteId}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    // Friendly pre-check; the rules are the real gate.
    let inv;
    try {
      inv = (await get(inviteRef)).val();
    } catch (e) {
      if (!isDenied(e)) throw e;
      throw new Error('This invite is invalid or was revoked');
    }
    const st = inviteState(inv);
    if (st !== 'active') throw new Error(`This invite is ${st === 'missing' ? 'invalid or was revoked' : st}`);
    const uses = typeof inv.uses === 'number' ? inv.uses : 0;

    const now = serverTimestamp();
    try {
      await update(ref(db), {
        [`servers/${sid}/members/${uid}`]: { role: 'member', joinedAt: now, invite: inviteId },
        [`servers/${sid}/keys/${uid}`]: wrapped,
        [`servers/${sid}/invites/${inviteId}/uses`]: uses + 1,
        [`userServers/${uid}/${sid}`]: { joinedAt: now },
      });
      return { sid, alreadyMember: false };
    } catch (e) {
      if (!isDenied(e)) throw e;
      // Lost a race on the use counter (or the invite changed) — re-read and try again.
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
    }
  }
  throw new Error('This invite is invalid, expired or used up — or you are banned from this server');
}

// ---------- Channels ----------

export async function createChannel(sid, { type, name, topic, position }) {
  const clean = cleanChannelName(name);
  if (!clean) throw new Error('Channel name cannot be empty');
  const cid = newKey(`servers/${sid}/channels`);
  const key = await getServerKey(sid);
  const enc = await encChannel(key, sid, cid, clean, cleanTopic(topic));
  await set(ref(db, `servers/${sid}/channels/${cid}`), {
    type: type === 'code' || type === 'voice' ? type : 'text',
    enc,
    position: Number.isFinite(position) ? position : Date.now(),
    createdAt: serverTimestamp(),
  });
  return cid;
}

export async function updateChannel(sid, cid, { name, topic }) {
  const clean = cleanChannelName(name);
  if (!clean) throw new Error('Channel name cannot be empty');
  const key = await getServerKey(sid);
  const enc = await encChannel(key, sid, cid, clean, cleanTopic(topic));
  await set(ref(db, `servers/${sid}/channels/${cid}/enc`), enc);
}

export async function deleteChannel(sid, cid) {
  await update(ref(db), {
    [`messages/${sid}/${cid}`]: null,
    [`collab/${sid}/${cid}`]: null,
    [`servers/${sid}/channels/${cid}`]: null,
  });
}

// ---------- DMs ----------

/**
 * Open (or create) a DM with `peerUid`. Writes dms/{dmId}/members for both users and the
 * userDms index for both sides. Throws if the peer has never unlocked a vault (no public key).
 */
export async function openDm(myUid, peerUid) {
  if (!peerUid || peerUid === myUid) throw new Error('Pick someone else to message');
  try {
    await getPublicKey(peerUid);
  } catch {
    throw new Error('That person has not set up encryption yet — ask them to sign in once');
  }
  const dmId = dmIdFor(myUid, peerUid);
  const mine = (await get(ref(db, `userDms/${myUid}/${dmId}`))).val();
  if (mine?.peer) return dmId;
  // lastTs sorts the new conversation to the top; my read marker gets the same server timestamp
  // in the same update so an empty DM never shows as unread.
  const now = serverTimestamp();
  const base = {
    [`dms/${dmId}/members/${myUid}`]: true,
    [`dms/${dmId}/members/${peerUid}`]: true,
    [`userDms/${myUid}/${dmId}`]: { peer: peerUid, lastTs: mine?.lastTs || now },
    [`reads/${myUid}/${dmScope(dmId)}`]: now,
  };
  try {
    await update(ref(db), { ...base, [`userDms/${peerUid}/${dmId}/peer`]: myUid });
  } catch (e) {
    if (!isDenied(e)) throw e;
    await update(ref(db), base); // rules may not let us touch the peer's index until a message is sent
  }
  return dmId;
}

export function peerFromDmId(dmId, myUid) {
  return String(dmId || '').split('_').find((u) => u && u !== myUid) || null;
}

export function hideDm(myUid, dmId) {
  return remove(ref(db, `userDms/${myUid}/${dmId}`));
}

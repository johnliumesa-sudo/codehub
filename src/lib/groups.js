// Private group chats (F1): invite-only, end-to-end encrypted conversations of 2–25 people.
//
// Crypto
//   - Every key epoch has its own random AES-256-GCM key, ECIES-wrapped for each member at
//     groups/{gid}/keys/{epoch}/{uid} with context `group:{gid}:{epoch}:{uid}`.
//   - meta.nameEnc is the group name encrypted with the CURRENT epoch key under `group-name:{gid}`.
//   - Messages carry a plaintext `epoch`; their JSON body is encrypted with that epoch's key under
//     `gmsg:{gid}/{mid}:{authorUid}` (see messages.js).
//   - Removing a member rotates: ONE multi-path update bumps meta.epoch, re-encrypts the name and
//     wraps a fresh key for every remaining member (the rules only accept a removal together with
//     the epoch bump). A voluntary leave sets meta.needsRotate; the owner's client rotates as soon
//     as it sees the flag.
//
// Plaintext by design: membership, roles, epochs, timestamps, message `epoch`, groups/{gid}/last.
// The 25-member cap is enforced in the UI only (rules cannot count children).
import { useEffect, useMemo, useRef, useState } from 'react';
import { equalTo, get, onValue, orderByChild, push, query, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { db } from './firebase.js';
import { decryptText, encryptText, generateRoomKey } from './crypto.js';
import { AVATAR_COLORS } from './profiles.js';
import { currentUid, onLock, unwrapForMe, wrapFor } from './keystore.js';
import { deliverNotifs } from './notifSend.js';

export const MAX_GROUP_MEMBERS = 25;
export const MAX_GROUP_NAME = 64;
const ROTATE_THROTTLE_MS = 30_000; // auto-rotation at most this often per group (a member can re-set the flag)
const CHUNK = 500;

// ---------- Names, scopes, AAD ----------

export const groupWrapContext = (gid, epoch, uid) => `group:${gid}:${epoch}:${uid}`;
export const groupNameAad = (gid) => `group-name:${gid}`;
export const groupMessageAad = (gid, mid, uid) => `gmsg:${gid}/${mid}:${uid}`;
export const groupScope = (gid) => `grp_${gid}`;
export const groupTypingPath = (gid) => `grp/${gid}`;
export const groupMessagesPath = (gid) => `groupMessages/${gid}`;

export function cleanGroupName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
}

/** Stable avatar color for a group (derived from its id; groups have no stored color). */
export function groupColor(gid) {
  let h = 0;
  for (const ch of String(gid || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');
const isDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e || ''));
const uidOf = (me) => (typeof me === 'string' ? me : me?.uid) || currentUid();

function requireMe() {
  const uid = currentUid();
  if (!uid) throw new Error('Vault is locked');
  return uid;
}

// ---------- In-memory caches (cleared on lock) ----------

const keyCache = new Map(); // `${gid}:${epoch}` -> Promise<CryptoKey>
const nameCache = new Map(); // `${gid}|${epoch}|${iv}|${ct}` -> string
const upkeep = new Map(); // gid -> { busy, lastRotate, checked, timer }

onLock(() => {
  keyCache.clear();
  nameCache.clear();
  for (const st of upkeep.values()) clearTimeout(st.timer);
  upkeep.clear();
});

function forgetGroupCaches(gid) {
  for (const k of [...keyCache.keys()]) if (k.startsWith(`${gid}:`)) keyCache.delete(k);
  for (const k of [...nameCache.keys()]) if (k.startsWith(`${gid}|`)) nameCache.delete(k);
  const st = upkeep.get(gid);
  if (st) clearTimeout(st.timer);
  upkeep.delete(gid);
}

const validEpoch = (epoch) => Number.isInteger(epoch) && epoch >= 1;

/** My copy of the group key for `epoch` (cached). Rejects when I hold no key for that epoch. */
export function getGroupKey(gid, epoch) {
  const ep = Number(epoch);
  if (!gid || !validEpoch(ep)) return Promise.reject(new Error('Invalid group key epoch'));
  const k = `${gid}:${ep}`;
  let p = keyCache.get(k);
  if (!p) {
    let uid;
    try {
      uid = requireMe();
    } catch (e) {
      return Promise.reject(e);
    }
    const promise = get(ref(db, `groups/${gid}/keys/${ep}/${uid}`)).then((s) => {
      if (!s.exists()) {
        throw new Error(ep > 1 ? 'You have no key for this part of the conversation' : 'You have no key for this group');
      }
      return unwrapForMe(s.val(), groupWrapContext(gid, ep, uid));
    });
    promise.catch(() => {
      if (keyCache.get(k) === promise) keyCache.delete(k);
    });
    keyCache.set(k, promise);
    p = promise;
  }
  return p;
}

export function cacheGroupKey(gid, epoch, key) {
  keyCache.set(`${gid}:${epoch}`, Promise.resolve(key));
}

const nameCacheKey = (gid, meta) => `${gid}|${meta?.epoch}|${meta?.nameEnc?.iv}|${meta?.nameEnc?.ct}`;

/** Synchronous lookup of an already decrypted name (undefined if not decrypted yet). */
export function peekGroupName(gid, meta) {
  return meta?.nameEnc ? nameCache.get(nameCacheKey(gid, meta)) : undefined;
}

/** Decrypt meta.nameEnc with the key of meta.epoch. */
export async function decryptGroupName(gid, meta) {
  const box = meta?.nameEnc;
  if (!box?.iv || !box?.ct) throw new Error('Group has no name');
  const ck = nameCacheKey(gid, meta);
  if (nameCache.has(ck)) return nameCache.get(ck);
  const key = await getGroupKey(gid, meta.epoch);
  const name = cleanGroupName(await decryptText(key, box, groupNameAad(gid))) || 'Unnamed group';
  nameCache.set(ck, name);
  return name;
}

// ---------- Key wrapping ----------

async function displayName(uid) {
  try {
    const n = (await get(ref(db, `users/${uid}/name`))).val();
    return typeof n === 'string' && n ? n : 'Someone';
  } catch {
    return 'Someone';
  }
}

/** Wrap `key` for each uid. Returns { ok: {uid: wrapped}, missing: [uid] } (missing = no public key). */
async function wrapAll(gid, epoch, key, uids) {
  const res = await Promise.allSettled(uids.map((u) => wrapFor(u, key, groupWrapContext(gid, epoch, u))));
  const ok = {};
  const missing = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') ok[uids[i]] = r.value;
    else missing.push(uids[i]);
  });
  return { ok, missing };
}

async function requireAllWrapped({ missing }) {
  if (!missing.length) return;
  const names = await Promise.all(missing.slice(0, 3).map(displayName));
  const more = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
  throw new Error(`${names.join(', ')}${more} ${missing.length === 1 ? 'has' : 'have'} not set up encryption yet — ask them to sign in once`);
}

// ---------- Create / rename / members ----------

/**
 * Create a group in ONE multi-path update: meta (epoch 1), members (me = owner, others = member),
 * keys/1/{each incl. me}, last, userGroups/{each}/{gid} and my read marker. Returns the gid.
 */
export async function createGroup(me, { name, memberUids }) {
  const myUid = uidOf(me);
  if (!myUid) throw new Error('Vault is locked');
  const clean = cleanGroupName(name);
  if (!clean) throw new Error('Give your group a name');
  const others = [...new Set(memberUids || [])].filter((u) => typeof u === 'string' && u && u !== myUid);
  if (others.length < 1) throw new Error('Add at least one other person');
  if (others.length + 1 > MAX_GROUP_MEMBERS) throw new Error(`Groups can have at most ${MAX_GROUP_MEMBERS} members`);

  const gid = push(ref(db, 'groups')).key;
  const key = await generateRoomKey();
  const everyone = [myUid, ...others];
  const wrapped = await wrapAll(gid, 1, key, everyone);
  await requireAllWrapped(wrapped);
  const nameEnc = await encryptText(key, clean, groupNameAad(gid));

  const now = serverTimestamp();
  const patch = {
    [`groups/${gid}/meta`]: { ownerId: myUid, nameEnc, epoch: 1, createdAt: now },
    [`groups/${gid}/last`]: { ts: now, uid: myUid },
    [`reads/${myUid}/${groupScope(gid)}`]: now,
  };
  for (const u of everyone) {
    patch[`groups/${gid}/members/${u}`] = { role: u === myUid ? 'owner' : 'member', joinedAt: now, addedBy: myUid };
    patch[`groups/${gid}/keys/1/${u}`] = wrapped.ok[u];
    patch[`userGroups/${u}/${gid}`] = { addedAt: now };
  }
  try {
    await update(ref(db), patch);
  } catch (e) {
    if (isDenied(e)) throw new Error('Could not create the group — someone you picked may have blocked you');
    throw e;
  }
  cacheGroupKey(gid, 1, key);
  deliverNotifs(others, { kind: 'groupAdd', ref: { gid } });
  return gid;
}

async function readGroup(gid) {
  const g = (await get(ref(db, `groups/${gid}`))).val();
  if (!g?.meta) throw new Error('This group no longer exists');
  return g;
}

function requireOwner(g, myUid, what) {
  if (g.meta.ownerId !== myUid) throw new Error(`Only the group owner can ${what}`);
}

/**
 * Owner only. The name is encrypted with the current epoch key; meta/epoch is rewritten with its
 * current value so a concurrent rotation makes this write fail instead of storing a stale-key name.
 */
export async function renameGroup(gid, name) {
  const myUid = requireMe();
  const clean = cleanGroupName(name);
  if (!clean) throw new Error('Group name cannot be empty');
  const meta = (await get(ref(db, `groups/${gid}/meta`))).val();
  if (!meta) throw new Error('This group no longer exists');
  if (meta.ownerId !== myUid) throw new Error('Only the group owner can rename it');
  const key = await getGroupKey(gid, meta.epoch);
  const nameEnc = await encryptText(key, clean, groupNameAad(gid));
  await update(ref(db, `groups/${gid}/meta`), { nameEnc, epoch: meta.epoch });
}

/**
 * Owner only: add people. They get the current epoch key and — with shareHistory (default) — every
 * older epoch key the owner can still open, so they can read the history. Returns the added uids.
 */
export async function addMembers(gid, uids, { shareHistory = true } = {}) {
  const myUid = requireMe();
  const g = await readGroup(gid);
  requireOwner(g, myUid, 'add people');
  const epoch = g.meta.epoch;
  const existing = g.members || {};
  const add = [...new Set(uids || [])].filter((u) => typeof u === 'string' && u && u !== myUid && !existing[u]);
  if (!add.length) return [];
  if (Object.keys(existing).length + add.length > MAX_GROUP_MEMBERS) {
    throw new Error(`Groups can have at most ${MAX_GROUP_MEMBERS} members`);
  }

  let current;
  try {
    current = await getGroupKey(gid, epoch);
  } catch {
    throw new Error('Your key for this group is unavailable — rotate the key first (Settings → Overview)');
  }
  const epochKeys = [[epoch, current]];
  if (shareHistory) {
    for (let e = 1; e < epoch; e++) {
      if (!g.keys?.[e]?.[myUid]) continue;
      try {
        epochKeys.push([e, await getGroupKey(gid, e)]);
      } catch {
        /* an epoch I can't open myself can't be shared */
      }
    }
  }

  const wrappedCurrent = await wrapAll(gid, epoch, current, add);
  await requireAllWrapped(wrappedCurrent);

  const now = serverTimestamp();
  const patch = { [`groups/${gid}/meta/epoch`]: epoch };
  for (const u of add) {
    patch[`groups/${gid}/members/${u}`] = { role: 'member', joinedAt: now, addedBy: myUid };
    patch[`groups/${gid}/keys/${epoch}/${u}`] = wrappedCurrent.ok[u];
    patch[`userGroups/${u}/${gid}`] = { addedAt: now };
  }
  for (const [e, k] of epochKeys) {
    if (e === epoch) continue;
    const w = await wrapAll(gid, e, k, add);
    for (const u of add) if (w.ok[u]) patch[`groups/${gid}/keys/${e}/${u}`] = w.ok[u];
  }
  try {
    await update(ref(db), patch);
  } catch (e) {
    if (isDenied(e)) throw new Error('Could not add them — someone may have blocked you, or the group key just rotated (try again)');
    throw e;
  }
  deliverNotifs(add, { kind: 'groupAdd', ref: { gid } });
  return add;
}

/**
 * Owner only: start a new key epoch (optionally removing one member) in ONE multi-path update:
 * meta/epoch +1, meta/nameEnc re-encrypted under the new key, meta/needsRotate cleared,
 * keys/{new}/{each remaining member}; with `remove`: members/{x}, keys/{*}/{x} and
 * userGroups/{x}/{gid} are deleted too. Returns the new epoch.
 */
export async function rotateGroupKey(gid, { remove: removeUid = null } = {}) {
  const myUid = requireMe();
  const g = await readGroup(gid);
  requireOwner(g, myUid, 'rotate the key');
  if (removeUid && removeUid === myUid) throw new Error("The owner can't be removed — delete the group instead");
  if (removeUid && !g.members?.[removeUid]) throw new Error('That person is not in this group');

  const epoch = g.meta.epoch;
  const next = epoch + 1;
  let name;
  try {
    name = await decryptGroupName(gid, g.meta);
  } catch {
    name = 'Unnamed group'; // my old key is unusable (vault reset): the new epoch fixes it for everyone
  }
  const key = await generateRoomKey();
  const remaining = Object.keys(g.members || {}).filter((u) => u !== removeUid);
  const wrapped = await wrapAll(gid, next, key, remaining);
  if (!wrapped.ok[myUid]) throw new Error('Could not wrap the new group key for yourself');
  const nameEnc = await encryptText(key, cleanGroupName(name) || 'Unnamed group', groupNameAad(gid));

  const patch = {
    [`groups/${gid}/meta/epoch`]: next,
    [`groups/${gid}/meta/nameEnc`]: nameEnc,
    [`groups/${gid}/meta/needsRotate`]: null,
  };
  for (const [u, w] of Object.entries(wrapped.ok)) patch[`groups/${gid}/keys/${next}/${u}`] = w;
  if (removeUid) {
    patch[`groups/${gid}/members/${removeUid}`] = null;
    patch[`userGroups/${removeUid}/${gid}`] = null;
    for (const [e, byUid] of Object.entries(g.keys || {})) {
      if (byUid && byUid[removeUid]) patch[`groups/${gid}/keys/${e}/${removeUid}`] = null;
    }
  }
  await update(ref(db), patch);
  cacheGroupKey(gid, next, key);
  return next;
}

/** Owner only: remove a member. Always rotates the key in the same write. */
export function removeMember(gid, uid) {
  return rotateGroupKey(gid, { remove: uid });
}

/**
 * Leave a group (non-owners). Removes my membership, my wrapped keys, my index entry, typing flag
 * and read marker, and asks the owner's client to rotate (meta/needsRotate).
 */
export async function leaveGroup(gid) {
  const myUid = requireMe();
  let role = null;
  let keys = {};
  try {
    const [r, k] = await Promise.all([
      get(ref(db, `groups/${gid}/members/${myUid}/role`)),
      get(ref(db, `groups/${gid}/keys`)),
    ]);
    role = r.val();
    keys = k.val() || {};
  } catch (e) {
    if (!isDenied(e)) throw e;
  }
  if (role === 'owner') throw new Error("The owner can't leave — delete the group instead");
  if (!role) {
    // Already removed (or the group is gone): only my own entries are left.
    await update(ref(db), { [`userGroups/${myUid}/${gid}`]: null, [`reads/${myUid}/${groupScope(gid)}`]: null });
    forgetGroupCaches(gid);
    return;
  }
  const patch = {
    [`groups/${gid}/members/${myUid}`]: null,
    [`groups/${gid}/meta/needsRotate`]: true,
    [`userGroups/${myUid}/${gid}`]: null,
    [`typing/grp/${gid}/${myUid}`]: null,
    [`reads/${myUid}/${groupScope(gid)}`]: null,
  };
  for (const [e, byUid] of Object.entries(keys)) if (byUid && byUid[myUid]) patch[`groups/${gid}/keys/${e}/${myUid}`] = null;
  await update(ref(db), patch);
  forgetGroupCaches(gid);
}

/** Owner only: delete the group, all its messages, typing flags and every member's index entry. */
export async function deleteGroup(gid) {
  const myUid = requireMe();
  const meta = (await get(ref(db, `groups/${gid}/meta`))).val();
  if (!meta) {
    await remove(ref(db, `userGroups/${myUid}/${gid}`));
    return;
  }
  if (meta.ownerId !== myUid) throw new Error('Only the group owner can delete it');
  const members = (await get(ref(db, `groups/${gid}/members`))).val() || {};
  // Images first, while the messages and my ownership (checked by the rules) still exist. Best effort.
  const { purgeConversationAttachments } = await import('./media/cleanup.js');
  await purgeConversationAttachments({ kind: 'group', gid });
  const patch = {
    [`groupMessages/${gid}`]: null,
    [`typing/grp/${gid}`]: null,
    [`groups/${gid}`]: null,
    [`votes/grp/${gid}`]: null, // the rules allow this once groups/{gid} is gone (same update)
    [`reads/${myUid}/${groupScope(gid)}`]: null,
  };
  for (const u of new Set([...Object.keys(members), myUid])) patch[`userGroups/${u}/${gid}`] = null;
  await update(ref(db), patch);
  forgetGroupCaches(gid);
}

/** Drop a stale index entry (group deleted or I was removed). */
export function forgetGroup(uid, gid) {
  forgetGroupCaches(gid);
  return remove(ref(db, `userGroups/${uid}/${gid}`));
}

/** Any member: ask the owner's client to rotate (e.g. after my vault was reset and my key copy broke). */
export function requestRekey(gid) {
  return set(ref(db, `groups/${gid}/meta/needsRotate`), true);
}

/** Owner only: wrap the current epoch key for members who have none (e.g. no public key at the time). */
export async function ensureGroupKeys(gid) {
  const myUid = requireMe();
  const g = await readGroup(gid);
  if (g.meta.ownerId !== myUid) return 0;
  const epoch = g.meta.epoch;
  const missing = Object.keys(g.members || {}).filter((u) => !g.keys?.[epoch]?.[u]);
  if (!missing.length) return 0;
  const key = await getGroupKey(gid, epoch);
  const { ok } = await wrapAll(gid, epoch, key, missing);
  const uids = Object.keys(ok);
  if (!uids.length) return 0;
  const patch = { [`groups/${gid}/meta/epoch`]: epoch };
  for (const u of uids) patch[`groups/${gid}/keys/${epoch}/${u}`] = ok[u];
  await update(ref(db), patch);
  return uids.length;
}

/**
 * Remove every message I authored in a group (used by account deletion, before leaving).
 * Requires read access, so call it while still a member.
 */
export async function removeMyGroupMessages(gid, uid) {
  const mine = await get(query(ref(db, groupMessagesPath(gid)), orderByChild('uid'), equalTo(uid)));
  const { purgeAttachments } = await import('./media/cleanup.js');
  await purgeAttachments({ kind: 'group', gid }, mine.val(), { onlyUid: uid });
  const paths = Object.keys(mine.val() || {}).map((mid) => `${groupMessagesPath(gid)}/${mid}`);
  for (let i = 0; i < paths.length; i += CHUNK) {
    await update(ref(db), Object.fromEntries(paths.slice(i, i + CHUNK).map((p) => [p, null])));
  }
}

// ---------- Owner upkeep: auto-rotation + missing keys ----------

async function autoRotate(gid) {
  const myUid = currentUid();
  if (!myUid) return;
  const meta = (await get(ref(db, `groups/${gid}/meta`))).val();
  if (!meta || meta.ownerId !== myUid || meta.needsRotate !== true) return;
  await rotateGroupKey(gid);
}

/** Called by useMyGroups for every group I own. Idempotent and throttled per group. */
function maintainGroup(gid, meta) {
  const myUid = currentUid();
  if (!myUid || !meta || meta.ownerId !== myUid || !validEpoch(meta.epoch)) return;
  let st = upkeep.get(gid);
  if (!st) {
    st = { busy: false, lastRotate: 0, checked: null, timer: null };
    upkeep.set(gid, st);
  }
  if (st.busy) return;
  const state = st;
  if (meta.needsRotate === true) {
    const wait = state.lastRotate + ROTATE_THROTTLE_MS - Date.now();
    if (wait > 0) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          if (upkeep.get(gid) !== state || state.busy) return;
          state.busy = true;
          state.lastRotate = Date.now();
          autoRotate(gid)
            .catch((e) => console.warn('[groups] auto-rotation failed', errMsg(e)))
            .finally(() => { state.busy = false; });
        }, wait);
      }
      return;
    }
    state.busy = true;
    state.lastRotate = Date.now();
    autoRotate(gid)
      .catch((e) => console.warn('[groups] auto-rotation failed', errMsg(e)))
      .finally(() => { state.busy = false; });
    return;
  }
  const tag = String(meta.epoch);
  if (state.checked === tag) return;
  state.checked = tag;
  state.busy = true;
  ensureGroupKeys(gid)
    .catch((e) => console.warn('[groups] could not re-wrap missing keys', errMsg(e)))
    .finally(() => { state.busy = false; });
}

// ---------- Live hooks ----------

function useDecryptedNames(entries) {
  // entries: [[gid, meta]]; returns { [nameCacheKey]: name | { failed: true } }
  const [names, setNames] = useState({});
  const sig = entries.map(([gid, meta]) => (meta?.nameEnc ? nameCacheKey(gid, meta) : '')).join(',');
  useEffect(() => {
    let alive = true;
    entries.forEach(([gid, meta]) => {
      if (!meta?.nameEnc || peekGroupName(gid, meta) !== undefined) return;
      const k = nameCacheKey(gid, meta);
      decryptGroupName(gid, meta).then(
        (name) => alive && setNames((m) => ({ ...m, [k]: name })),
        () => alive && setNames((m) => ({ ...m, [k]: { failed: true } })),
      );
    });
    return () => {
      alive = false;
    };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return names;
}

function resolveName(gid, meta, names) {
  if (!meta?.nameEnc) return { name: null, nameFailed: !!meta };
  const cached = peekGroupName(gid, meta);
  if (cached !== undefined) return { name: cached, nameFailed: false };
  const v = names[nameCacheKey(gid, meta)];
  if (v && typeof v === 'object') return { name: null, nameFailed: true };
  return { name: v ?? null, nameFailed: false };
}

const asLast = (v) => (v && typeof v.ts === 'number' ? { ts: v.ts, uid: typeof v.uid === 'string' ? v.uid : null } : null);

/**
 * My groups, live: { groups: [{ gid, name, nameFailed, ownerId, epoch, needsRotate, createdAt, last, status }], loading }.
 * Sorted by latest activity. Groups I lost access to are dropped from my index automatically.
 * For groups I own, also performs upkeep (auto-rotation on needsRotate, re-wrapping missing keys).
 */
export function useMyGroups(uid) {
  const [index, setIndex] = useState({ uid: null, loading: true, gids: [] });
  useEffect(() => {
    if (!uid) return undefined;
    setIndex({ uid, loading: true, gids: [] });
    return onValue(
      ref(db, `userGroups/${uid}`),
      (s) => setIndex({ uid, loading: false, gids: Object.keys(s.val() || {}).sort() }),
      () => setIndex({ uid, loading: false, gids: [] }),
    );
  }, [uid]);

  const gids = index.uid === uid ? index.gids : [];
  const gidKey = gids.join(',');
  const [data, setData] = useState({}); // gid -> { meta, metaLoaded, denied, last }
  const [retry, setRetry] = useState(0);
  const subs = useRef(new Map()); // gid -> unsubscribe

  useEffect(() => {
    const want = new Set(gidKey ? gidKey.split(',') : []);
    for (const [gid, unsub] of [...subs.current]) {
      if (want.has(gid)) continue;
      unsub();
      subs.current.delete(gid);
    }
    setData((d) => {
      const next = {};
      for (const gid of want) if (d[gid]) next[gid] = d[gid];
      return next;
    });
    for (const gid of want) {
      if (subs.current.has(gid)) continue;
      const put = (patch) => setData((d) => ({ ...d, [gid]: { ...(d[gid] || {}), ...patch } }));
      const unMeta = onValue(
        ref(db, `groups/${gid}/meta`),
        (s) => put({ meta: s.val(), metaLoaded: true, denied: false }),
        (err) => {
          put({ meta: null, metaLoaded: true, denied: true });
          if (!uid || !isDenied(err)) return;
          // RTDB cancels a denied listener for good. Removed from the group, or it was deleted?
          // Re-check after a moment (a just-created membership may still be in flight): if I have
          // access, re-subscribe; if not, drop the stale index entry.
          setTimeout(() => {
            if (subs.current.get(gid) !== entry) return;
            get(ref(db, `groups/${gid}/meta`)).then(
              (s) => {
                if (subs.current.get(gid) !== entry) return;
                if (s.exists()) {
                  entry();
                  subs.current.delete(gid);
                  setRetry((t) => t + 1);
                } else {
                  forgetGroup(uid, gid).catch(() => {});
                }
              },
              (e) => isDenied(e) && forgetGroup(uid, gid).catch(() => {}),
            );
          }, 1500);
        },
      );
      const unLast = onValue(
        ref(db, `groups/${gid}/last`),
        (s) => put({ last: asLast(s.val()) }),
        () => put({ last: null }),
      );
      const entry = () => {
        unMeta();
        unLast();
      };
      subs.current.set(gid, entry);
    }
  }, [gidKey, uid, retry]);

  useEffect(
    () => () => {
      for (const unsub of subs.current.values()) unsub();
      subs.current.clear();
    },
    [uid],
  );

  const metaEntries = useMemo(() => Object.entries(data).map(([gid, d]) => [gid, d.meta]), [data]);
  const names = useDecryptedNames(metaEntries);

  // Owner upkeep (module-level guards make this safe to run from several components).
  useEffect(() => {
    if (!uid) return;
    for (const [gid, d] of Object.entries(data)) if (d.meta && d.meta.ownerId === uid) maintainGroup(gid, d.meta);
  }, [data, uid]);

  const groups = useMemo(
    () =>
      gids
        .filter((gid) => !data[gid]?.denied && !(data[gid]?.metaLoaded && !data[gid]?.meta))
        .map((gid) => {
          const d = data[gid] || {};
          const meta = d.meta;
          const { name, nameFailed } = resolveName(gid, meta, names);
          return {
            gid,
            name,
            nameFailed,
            ownerId: meta?.ownerId || null,
            epoch: validEpoch(meta?.epoch) ? meta.epoch : null,
            needsRotate: meta?.needsRotate === true,
            createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : 0,
            last: d.last || null,
            status: meta ? 'ready' : 'loading',
          };
        })
        .sort((a, b) => (b.last?.ts || b.createdAt) - (a.last?.ts || a.createdAt) || a.gid.localeCompare(b.gid)),
    [gidKey, data, names], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!uid) return { groups: [], loading: false };
  return { groups, loading: index.uid !== uid || index.loading };
}

/**
 * One group's meta + last, live. status: loading | ready | denied | missing | error.
 * Returns { status, gid, name, nameFailed, ownerId, epoch, needsRotate, createdAt, last }.
 */
export function useGroup(gid) {
  const [st, setSt] = useState({ gid: null, loading: true, meta: null, error: null });
  const [last, setLast] = useState({ gid: null, value: null });
  useEffect(() => {
    if (!gid) return undefined;
    setSt({ gid, loading: true, meta: null, error: null });
    const unMeta = onValue(
      ref(db, `groups/${gid}/meta`),
      (s) => setSt({ gid, loading: false, meta: s.val(), error: null }),
      (error) => setSt({ gid, loading: false, meta: null, error }),
    );
    const unLast = onValue(
      ref(db, `groups/${gid}/last`),
      (s) => setLast({ gid, value: asLast(s.val()) }),
      () => setLast({ gid, value: null }),
    );
    return () => {
      unMeta();
      unLast();
    };
  }, [gid]);

  const meta = st.gid === gid ? st.meta : null;
  const entries = useMemo(() => (gid && meta ? [[gid, meta]] : []), [gid, meta]);
  const names = useDecryptedNames(entries);

  if (!gid) return { status: 'missing', gid: null };
  if (st.gid !== gid || st.loading) return { status: 'loading', gid };
  if (st.error) return { status: isDenied(st.error) ? 'denied' : 'error', gid, error: st.error };
  if (!meta) return { status: 'missing', gid };
  const { name, nameFailed } = resolveName(gid, meta, names);
  return {
    status: 'ready',
    gid,
    name,
    nameFailed,
    ownerId: meta.ownerId || null,
    epoch: validEpoch(meta.epoch) ? meta.epoch : null,
    needsRotate: meta.needsRotate === true,
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
    last: last.gid === gid ? last.value : null,
  };
}

/** groups/{gid}/members -> { members: [{ uid, role, joinedAt, addedBy }], loading, error } (owner first). */
export function useGroupMembers(gid) {
  const [st, setSt] = useState({ gid: null, loading: true, value: null, error: null });
  useEffect(() => {
    if (!gid) return undefined;
    setSt({ gid, loading: true, value: null, error: null });
    return onValue(
      ref(db, `groups/${gid}/members`),
      (s) => setSt({ gid, loading: false, value: s.val(), error: null }),
      (error) => setSt({ gid, loading: false, value: null, error }),
    );
  }, [gid]);
  const value = st.gid === gid ? st.value : null;
  const members = useMemo(
    () =>
      Object.entries(value || {})
        .map(([uid, m]) => ({
          uid,
          role: m?.role === 'owner' ? 'owner' : 'member',
          joinedAt: typeof m?.joinedAt === 'number' ? m.joinedAt : 0,
          addedBy: typeof m?.addedBy === 'string' ? m.addedBy : null,
        }))
        .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.joinedAt - b.joinedAt),
    [value],
  );
  if (!gid) return { members: [], loading: false, error: null };
  return { members, loading: st.gid !== gid || st.loading, error: st.gid === gid ? st.error : null };
}

// ---------- Chat glue ----------

/** Conversation descriptor for ChatView (null until the group is decrypted & has an epoch). */
export function groupConv(group) {
  if (!group?.gid || !validEpoch(group.epoch)) return null;
  return {
    kind: 'group',
    gid: group.gid,
    epoch: group.epoch,
    ownerId: group.ownerId,
    title: group.name || 'Group',
    scope: groupScope(group.gid),
  };
}

/**
 * Extra multi-path entries to write after a group message is sent: groups/{gid}/last (any member,
 * rules require uid = me and ts = now). Pass the same serverTimestamp() used for the read marker.
 */
export function groupSendExtras(conv, me, ts = serverTimestamp()) {
  return { [`groups/${conv.gid}/last`]: { ts, uid: uidOf(me) } };
}

/** Unread if someone else posted after my read marker. */
export function isGroupUnread(group, reads, myUid) {
  const last = group?.last;
  return !!last && last.uid !== myUid && last.ts > ((reads || {})[groupScope(group.gid)] || 0);
}

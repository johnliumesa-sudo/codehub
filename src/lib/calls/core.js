// Calls core: scopes, keys, encrypted signaling, slots, ringing, ICE config.
//
// DB layout (see ARCHITECTURE.md "Calls"); voice channels use vcalls/{sid}/{cid} and
// vsignal/{sid}/{cid}/... instead (same shapes) because rules cannot parse `vc_{sid}_{cid}`:
//   calls/{scope}            = { id, startedBy, ts, kind: 'audio'|'video', slots: { 0..5: slot } }
//   calls/{scope}/slots/{i}  = { uid, joinedAt, mic, cam, screen }
//   signal/{scope}/{to}/{from}/{pushId} = { iv, ct, ts, epoch? }   AAD `call:{scope}/{callId}/{from}->{to}`
// Scopes: dm_{dmId} | grp_{gid} | vc_{sid}_{cid}. Server and channel ids are 20-char push keys.
import { get, onDisconnect, push, ref, remove, runTransaction, serverTimestamp, update } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptJSON, encryptJSON, randomId } from '../crypto.js';
import { getDmKey, getServerKey } from '../keystore.js';
import { getGroupKey } from '../groups.js';
import { peerFromDmId } from '../servers.js';

export const MAX_CALL = 6;
export const STALE_MS = 60_000;
export const RING_MS = 30_000;
export const STUN = { urls: 'stun:stun.l.google.com:19302' };

export const dmCallScope = (dmId) => `dm_${dmId}`;
export const groupCallScope = (gid) => `grp_${gid}`;
export const voiceScope = (sid, cid) => `vc_${sid}_${cid}`;
// RTDB rules cannot split strings, so voice-channel calls live under per-server/channel paths.
export function callPath(scope) {
  const p = parseScope(scope);
  return p?.type === 'vc' ? `vcalls/${p.sid}/${p.cid}` : `calls/${scope}`;
}
export const slotsPath = (scope) => `${callPath(scope)}/slots`;
/** Signaling inbox base: `signal/{scope}` (DM/group) or `vsignal/{sid}/{cid}` (voice). */
export function signalPath(scope) {
  const p = parseScope(scope);
  return p?.type === 'vc' ? `vsignal/${p.sid}/${p.cid}` : `signal/${scope}`;
}
export const signalAad = (scope, callId, from, to) => `call:${scope}/${callId}/${from}->${to}`;

/** Parse a call scope into its parts. Returns null for anything that is not a call scope. */
export function parseScope(scope) {
  const s = String(scope || '');
  if (s.startsWith('dm_') && s.length > 3) return { type: 'dm', dmId: s.slice(3) };
  if (s.startsWith('grp_') && s.length > 4) return { type: 'grp', gid: s.slice(4) };
  if (s.startsWith('vc_') && s.length === 44 && s[23] === '_') return { type: 'vc', sid: s.slice(3, 23), cid: s.slice(24) };
  return null;
}

/** Notification `ref` ids for a scope (ids only, no text). */
export function scopeRef(scope) {
  const p = parseScope(scope);
  if (!p) return {};
  if (p.type === 'dm') return { dmId: p.dmId };
  if (p.type === 'grp') return { gid: p.gid };
  return { sid: p.sid, cid: p.cid };
}

/** Rebuild a ring scope from a notification `ref`. */
export function scopeFromRef(r = {}) {
  if (r.dmId) return dmCallScope(r.dmId);
  if (r.gid) return groupCallScope(r.gid);
  return null;
}

/**
 * Key material for a scope: `{ key, epoch? }` for sending and `keyFor(epoch)` for receiving.
 * DM → DM key, group → current epoch key, voice channel → server key.
 */
export async function scopeKeys(scope, me) {
  const p = parseScope(scope);
  if (!p) throw new Error('Unknown call scope');
  if (p.type === 'dm') {
    const peer = peerFromDmId(p.dmId, me);
    const key = await getDmKey(p.dmId, peer);
    return { key, epoch: null, keyFor: async () => key };
  }
  if (p.type === 'vc') {
    const key = await getServerKey(p.sid);
    return { key, epoch: null, keyFor: async () => key };
  }
  const epoch = Number((await get(ref(db, `groups/${p.gid}/meta/epoch`))).val()) || 1;
  const key = await getGroupKey(p.gid, epoch);
  return { key, epoch, keyFor: (ep) => (Number(ep) === epoch ? Promise.resolve(key) : getGroupKey(p.gid, ep)) };
}

/** Members of a scope to ring (excluding me). Voice channels are drop-in: nobody is rung. */
export async function ringTargets(scope, me) {
  const p = parseScope(scope);
  if (!p || p.type === 'vc') return [];
  if (p.type === 'dm') return [peerFromDmId(p.dmId, me)].filter(Boolean);
  const members = (await get(ref(db, `groups/${p.gid}/members`))).val() || {};
  return Object.keys(members).filter((u) => u !== me);
}

/** ICE servers: Google STUN plus admin-configured TURN from appConfig/turn (≤4). */
export async function loadIceServers() {
  const out = [STUN];
  try {
    const turn = (await get(ref(db, 'appConfig/turn'))).val();
    const list = Array.isArray(turn) ? turn : Object.values(turn || {});
    for (const t of list.slice(0, 4)) {
      if (!t || !t.urls) continue;
      const e = { urls: t.urls };
      if (t.username) e.username = t.username;
      if (t.credential) e.credential = t.credential;
      out.push(e);
    }
  } catch {
    // appConfig unreadable: STUN only
  }
  return out;
}

// ---------- Call meta + slots ----------

const isLive = (meta, now = Date.now()) =>
  !!meta?.id && (!!meta.slots || (typeof meta.ts === 'number' && now - meta.ts < STALE_MS));

/** Join the active call in `scope`, or start one. Returns `{ callId, kind, started }`. */
export async function ensureCall(scope, me, kind) {
  const meta = (await get(ref(db, callPath(scope)))).val();
  if (isLive(meta)) return { callId: meta.id, kind: meta.kind === 'video' ? 'video' : 'audio', started: false };
  const id = randomId(12);
  await update(ref(db, callPath(scope)), { id, startedBy: me, ts: serverTimestamp(), kind: kind === 'video' ? 'video' : 'audio' });
  return { callId: id, kind, started: true };
}

/**
 * Claim the first free slot with a transaction per slot. Throws when all 6 are taken or when I
 * already hold a slot (another tab). Registers onDisconnect removal. Returns `{ index, joinedAt }`.
 */
export async function claimSlot(scope, me, flags) {
  const existing = (await get(ref(db, slotsPath(scope)))).val() || {};
  if (Object.values(existing).some((s) => s?.uid === me)) throw new Error('You are already in this call in another tab');
  for (let i = 0; i < MAX_CALL; i++) {
    if (existing[i]) continue;
    const r = ref(db, `${slotsPath(scope)}/${i}`);
    let res;
    try {
      res = await runTransaction(
        r,
        (cur) => (cur ? undefined : { uid: me, joinedAt: serverTimestamp(), mic: !!flags.mic, cam: !!flags.cam, screen: false }),
        { applyLocally: false },
      );
    } catch {
      continue; // lost a race to the rules (slot taken meanwhile)
    }
    if (res.committed && res.snapshot.val()?.uid === me) {
      await onDisconnect(r).remove();
      // A transaction resolves serverTimestamp() locally, so res.snapshot holds this client's estimate,
      // while the server stored its own clock. Peers see (and match signals against) the stored value.
      const stored = (await get(r).catch(() => null))?.val();
      return { index: i, joinedAt: stored?.uid === me && typeof stored.joinedAt === 'number' ? stored.joinedAt : res.snapshot.val().joinedAt };
    }
  }
  throw new Error(`This call is full (${MAX_CALL} people max)`);
}

export function updateSlot(scope, index, patch) {
  return update(ref(db, `${slotsPath(scope)}/${index}`), patch);
}

/** Leave: drop my slot (cancelling onDisconnect) and remove the call meta when nobody is left. */
export async function releaseSlot(scope, index) {
  const r = ref(db, `${slotsPath(scope)}/${index}`);
  try {
    await onDisconnect(r).cancel();
  } catch {
    // offline: the server-side onDisconnect still runs
  }
  await remove(r).catch(() => {});
  await cleanupIfEmpty(scope).catch(() => {});
}

/** Remove the call meta when no slots remain (rules allow it for the starter or after 60 s). */
export async function cleanupIfEmpty(scope) {
  const s = (await get(ref(db, callPath(scope)))).val();
  if (!s || s.slots) return false;
  await update(ref(db, callPath(scope)), { id: null, startedBy: null, ts: null, kind: null });
  return true;
}

// ---------- Signaling ----------

/** Encrypt and push one signaling message to `to`. */
export async function sendSignal({ scope, callId, me, to, keys, payload }) {
  const box = await encryptJSON(keys.key, payload, signalAad(scope, callId, me, to));
  const msg = { iv: box.iv, ct: box.ct, ts: serverTimestamp() };
  if (keys.epoch) msg.epoch = keys.epoch;
  await push(ref(db, `${signalPath(scope)}/${to}/${me}`), msg);
}

export async function openSignal({ scope, callId, me, from, keys, msg }) {
  const key = await keys.keyFor(msg.epoch);
  return decryptJSON(key, { iv: msg.iv, ct: msg.ct }, signalAad(scope, callId, from, me));
}

/** Clear my inbox for a scope and remove it on disconnect. */
export async function resetInbox(scope, me) {
  const r = ref(db, `${signalPath(scope)}/${me}`);
  await remove(r).catch(() => {});
  await onDisconnect(r).remove().catch(() => {});
}

export async function dropInbox(scope, me) {
  const r = ref(db, `${signalPath(scope)}/${me}`);
  await onDisconnect(r).cancel().catch(() => {});
  await remove(r).catch(() => {});
}

// ---------- Ringing (notifs of kind `call`, shape from spec §1) ----------

/** Multi-path update map that rings one user. Write it with `update(ref(db), map)`. */
export function buildCallRingUpdate(me, toUid, scope, callId) {
  const nid = push(ref(db, `notifs/${toUid}`)).key;
  return {
    [`notifs/${toUid}/${nid}`]: { kind: 'call', from: me, ts: serverTimestamp(), ref: { ...scopeRef(scope), callId } },
    [`notifLog/${me}/${toUid}`]: serverTimestamp(),
  };
}

// The rules allow one notification per sender/recipient pair every 3 s (notifLog). A ring right after a
// message or group-add notification to the same person is refused, so it is retried once after that.
const RING_RETRY_MS = 3300;

async function ringOne(me, to, scope, callId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await update(ref(db), buildCallRingUpdate(me, to, scope, callId));
      return true;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, RING_RETRY_MS));
    }
  }
  return false; // blocked, or not allowed to ring this person
}

/** Ring every callee (one update each so a block or throttle on one does not stop the rest). */
export async function ringCall(scope, me, callId) {
  const targets = await ringTargets(scope, me);
  await Promise.all(targets.map((u) => ringOne(me, u, scope, callId)));
  return targets.length;
}

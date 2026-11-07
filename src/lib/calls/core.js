// Calls core: scopes, keys, encrypted signaling, slots, ringing, ICE config.
//
// DB layout (see ARCHITECTURE.md "Calls"); voice channels use vcalls/{sid}/{cid} and
// vsignal/{sid}/{cid}/... instead (same shapes) because rules cannot parse `vc_{sid}_{cid}`:
//   calls/{scope}            = { id, startedBy, ts, kind: 'audio'|'video', slots: { 0..5: slot } }
//   calls/{scope}/slots/{i}  = { uid, joinedAt, mic, cam, screen, hb, away? }   hb: heartbeat (server time,
//                              every 15 s); when the owner's connection drops the server stamps hb with
//                              that time and sets away = true (onDisconnect), so others wait 45 s to prune
//   signal/{scope}/{to}/{from}/{pushId} = { iv, ct, ts, epoch? }   AAD `call:{scope}/{callId}/{from}->{to}`
// Scopes: dm_{dmId} | grp_{gid} | vc_{sid}_{cid}. Server and channel ids are 20-char push keys.
import { get, onDisconnect, onValue, push, ref, remove, runTransaction, serverTimestamp, update } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptJSON, encryptJSON, randomId } from '../crypto.js';
import { getDmKey, getServerKey } from '../keystore.js';
import { getGroupKey } from '../groups.js';
import { peerFromDmId } from '../servers.js';
import { STUN_URLS, buildIceServers, canPruneSlot } from './health.js';

export const MAX_CALL = 6;
export const STALE_MS = 60_000;
export const RING_MS = 30_000;
export const STUN = Object.freeze({ urls: [...STUN_URLS] });

// ---------- Server clock ----------

let clockOffset = 0;
let clockOff = null;
/** Current server time estimate (`.info/serverTimeOffset`), for comparing heartbeats. */
export function serverNow() {
  if (!clockOff) {
    clockOff = onValue(ref(db, '.info/serverTimeOffset'), (s) => {
      clockOffset = Number(s.val()) || 0;
    }, () => {});
  }
  return Date.now() + clockOffset;
}

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

/** ICE servers: five public Google STUN servers plus admin-configured TURN from appConfig/turn (≤4). */
export async function loadIceServers() {
  try {
    return buildIceServers((await get(ref(db, 'appConfig/turn'))).val());
  } catch {
    return buildIceServers(null); // appConfig unreadable: STUN only
  }
}

// ---------- Call meta + slots ----------

const isLive = (meta, now = Date.now()) =>
  !!meta?.id && (!!meta.slots || (typeof meta.ts === 'number' && now - meta.ts < STALE_MS));

/**
 * Remove slots whose owner is gone: no heartbeat for 45 s (the rules let any member remove those), or
 * my own slot left away by a crashed tab. Someone else's away slot (a short network blip) is kept: it
 * only becomes removable once its heartbeat is 45 s old. Returns the slots that are left.
 */
export async function pruneGhostSlots(scope, me) {
  const slots = (await get(ref(db, slotsPath(scope)))).val() || {};
  const now = serverNow();
  const left = {};
  for (const [i, s] of Object.entries(slots)) {
    if (!s) continue;
    if (canPruneSlot(s, now, me)) {
      const ok = await remove(ref(db, `${slotsPath(scope)}/${i}`)).then(() => true, () => false);
      if (ok) continue;
    }
    left[i] = s;
  }
  return left;
}

/** Join the active call in `scope`, or start one. Returns `{ callId, kind, started }`. */
export async function ensureCall(scope, me, kind) {
  // A call whose only slots are ghosts (crashed tabs) is over: clear them so a new call rings again.
  await pruneGhostSlots(scope, me).catch(() => {});
  const meta = (await get(ref(db, callPath(scope)))).val();
  if (isLive(meta)) return { callId: meta.id, kind: meta.kind === 'video' ? 'video' : 'audio', started: false };
  const id = randomId(12);
  await update(ref(db, callPath(scope)), { id, startedBy: me, ts: serverTimestamp(), kind: kind === 'video' ? 'video' : 'audio' });
  return { callId: id, kind, started: true };
}

export const isPermissionDenied = (e) => /permission[_ ]denied/i.test(`${e?.code || ''} ${e?.message || ''}`);

// The rules are pasted into the console by hand after a deploy, so the app can run against rules from
// before call heartbeats, which refuse a slot with `hb` (unknown children are invalid there). Once a
// heartbeat slot is refused and a plain one accepted, this page sticks to plain ("legacy") slots: no
// heartbeat writes, removed on disconnect (the old behaviour), counted as live by everyone.
let heartbeatsRefused = false;

/**
 * Claim the first free slot with a transaction per slot. Throws when all 6 are taken, when I already
 * hold a live slot (another tab), or when the server refuses the claim (said as such: a refusal is
 * never reported as a full call). Ghost slots (no heartbeat for 45 s, or my own away slot) are removed
 * first. The slot carries a heartbeat (`hb`); if this connection drops, the server stamps `hb` with that
 * time and sets `away` (the slot stays for 45 s, so a short network blip doesn't end anyone's call).
 * Under rules that predate heartbeats the slot is written without `hb` (see heartbeatsRefused).
 * Returns `{ index, joinedAt, legacy }` with the server-stored joinedAt.
 */
export async function claimSlot(scope, me, flags) {
  const existing = await pruneGhostSlots(scope, me);
  if (Object.values(existing).some((s) => s?.uid === me)) {
    throw new Error('You are already in this call in another tab. If that tab was closed, try again in a minute.');
  }
  const base = { uid: me, mic: !!flags.mic, cam: !!flags.cam, screen: !!flags.screen };
  let taken = 0;
  let denied = 0;
  let failure = null;
  for (let i = 0; i < MAX_CALL; i++) {
    if (existing[i]) {
      taken += 1;
      continue;
    }
    const r = ref(db, `${slotsPath(scope)}/${i}`);
    let res = null;
    let legacy = heartbeatsRefused;
    for (;;) {
      const slot = legacy ? base : { ...base, hb: serverTimestamp() };
      try {
        res = await runTransaction(r, (cur) => (cur ? undefined : { ...slot, joinedAt: serverTimestamp() }), { applyLocally: false });
        break;
      } catch (e) {
        // A refusal means one of: rules from before heartbeats (try the plain slot); the slot is taken
        // and my cached copy was out of date (e.g. after a frozen tab: the server refuses writing over
        // someone's slot instead of handing the transaction their value); or I may not join at all.
        if (isPermissionDenied(e) && !legacy) {
          legacy = true;
          continue;
        }
        failure = e;
        break;
      }
    }
    if (!res) {
      if (isPermissionDenied(failure)) denied += 1;
      continue; // possibly taken, or a transaction that gave up under contention: try the next slot
    }
    if (res.committed && res.snapshot.val()?.uid === me) {
      if (legacy) heartbeatsRefused = true;
      await armSlotDisconnect(scope, i, legacy);
      // A transaction resolves serverTimestamp() locally, so res.snapshot holds this client's estimate,
      // while the server stored its own clock. Peers see (and match signals against) the stored value.
      const stored = (await get(r).catch(() => null))?.val();
      return {
        index: i,
        joinedAt: stored?.uid === me && typeof stored.joinedAt === 'number' ? stored.joinedAt : res.snapshot.val().joinedAt,
        legacy,
      };
    }
    taken += 1; // someone else got this slot first
  }
  if (taken >= MAX_CALL) throw new Error(`This call is full (${MAX_CALL} people max)`);
  if (denied > 0) {
    throw new Error("Couldn't join the call: the server refused it (permission denied). Check that you can still post here, then try again.");
  }
  throw new Error(`Couldn't join the call${failure?.message ? `: ${failure.message}` : ''}. Try again.`);
}

/**
 * When this connection drops, the server marks my slot away: `hb` = the disconnect time (server clock),
 * `away` = true. Others may remove it only once that is 45 s old. Registered again after every
 * reconnect (a disconnect consumes it). Harmless once the slot is gone or someone else's: the server
 * checks the rules again when it runs, and a slot without uid fails validation. A `legacy` slot (rules
 * from before heartbeats, which also refuse this update) is removed on disconnect instead.
 */
export function armSlotDisconnect(scope, index, legacy = false) {
  const r = ref(db, `${slotsPath(scope)}/${index}`);
  if (legacy) return onDisconnect(r).remove().catch(() => {});
  return onDisconnect(r).update({ hb: serverTimestamp(), away: true }).catch((e) => {
    if (isPermissionDenied(e)) return onDisconnect(r).remove().catch(() => {});
    return undefined;
  });
}

/** Remove another member's ghost slot (the rules allow it once its heartbeat is 45 s old). */
export function removeSlot(scope, index) {
  return remove(ref(db, `${slotsPath(scope)}/${index}`));
}

export function updateSlot(scope, index, patch) {
  return update(ref(db, `${slotsPath(scope)}/${index}`), patch);
}

/**
 * Leave: drop my slot and remove the call meta when nobody is left. The removal is sent before anything
 * is awaited: on pagehide only synchronous work reaches the network (awaiting an onDisconnect cancel
 * first used to leave a ghost slot behind when a tab was closed).
 */
export function releaseSlot(scope, index) {
  const r = ref(db, `${slotsPath(scope)}/${index}`);
  const removed = remove(r);
  onDisconnect(ref(db, `${slotsPath(scope)}/${index}/hb`)).cancel().catch(() => {});
  onDisconnect(r).cancel().catch(() => {}); // older sessions of this tab registered a removal
  return removed.then(() => cleanupIfEmpty(scope)).catch(() => {});
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

/**
 * Clear my inbox for a scope before joining. It is not removed on disconnect: signals sent while my
 * connection blips (ICE restart offers) must still be there when it comes back. Leaving clears it, and
 * leftovers from a crashed tab are cleared on the next join (and are ignored anyway: they predate the
 * sender's slot or target an older one of mine).
 */
export async function resetInbox(scope, me) {
  const r = ref(db, `${signalPath(scope)}/${me}`);
  await remove(r).catch(() => {});
  await onDisconnect(r).cancel().catch(() => {}); // registered by earlier versions
}

/** Leave: clear my inbox (sent first, see releaseSlot). */
export function dropInbox(scope, me) {
  const r = ref(db, `${signalPath(scope)}/${me}`);
  const removed = remove(r);
  onDisconnect(r).cancel().catch(() => {});
  return removed.catch(() => {});
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

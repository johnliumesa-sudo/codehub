// Round 3: typed access to the generic rules blocks, plus the encryption helpers features use for
// what they store there. Shapes and permissions (database.rules.json; ARCHITECTURE.md "Round 3"):
//
//   udata/{uid}/{feat}/{key}[/{f}]     private per-user data; only the owner reads/writes (strings <= 20000)
//   upub/{uid}/{feat}/{key}[/{f}]      public per-user data; signed-in users read, owner writes (strings <= 2000)
//   sconf/{sid}/{feat}/{key}[/{f}]     server config; members read; owner/admin/manageApps write (<= 20000)
//   sitems/{sid}/{feat}/{id}/{f}       member-created items { by, ...leaf fields }; members read; author
//                                      creates/updates (not while timed out); author or owner/admin/
//                                      manageMessages deletes; `by` never changes (<= 20000)
//   pub/{kind}/{id}/{f}                public catalogs, kind: bots | addons | addonCode | servers;
//                                      signed-in read; { by, ts (= now on every write), ...leaf fields };
//                                      strings <= 20000, field `code` <= 65536; only `by` updates/deletes,
//                                      app admins delete; pub/servers/{sid}: only that server's owner writes
// feat: /^[a-z][a-zA-Z0-9]{0,23}$/ · key/id: <= 128 chars · field names <= 64 chars · values are
// numbers, booleans or strings; {key} may be one leaf or an object of leaves, nothing deeper.
//
// Encryption: anything users type that a feature stores in sconf/sitems must be sealed with
// sealForServer(sid, `<kind>:{sid}/{id}`, obj); private data in udata with sealForMe(`<kind>:{uid}/{key}`, obj).
// A sealed box is { iv, ct }: store it as the {key}/{id} object itself or under two fields.
import { useEffect, useMemo, useState } from 'react';
import { equalTo, limitToLast, onValue, orderByChild, push, query, ref, serverTimestamp, set, update } from 'firebase/database';
import { auth, db } from '../firebase.js';
import { decryptJSON, encryptJSON } from '../crypto.js';
import { currentUid, getServerKey, vaultDecryptJSON, vaultEncryptJSON } from '../keystore.js';

export const FEAT_RE = /^[a-z][a-zA-Z0-9]{0,23}$/;
export const PUB_KINDS = Object.freeze(['bots', 'addons', 'addonCode', 'servers']);
export const LIMITS = Object.freeze({ key: 128, field: 64, udata: 20000, upub: 2000, sconf: 20000, sitems: 20000, pub: 20000, pubCode: 65536 });

const BAD_KEY = /[.#$[\]/]/;

function checkFeat(feat) {
  if (typeof feat !== 'string' || !FEAT_RE.test(feat)) throw new Error(`Invalid feature name: ${String(feat)}`);
}
function checkKey(key, what = 'key') {
  if (typeof key !== 'string' || !key || key.length > LIMITS.key || BAD_KEY.test(key)) throw new Error(`Invalid ${what}: ${String(key)}`);
}
function checkId(id, what) {
  if (typeof id !== 'string' || !id || BAD_KEY.test(id)) throw new Error(`Invalid ${what}: ${String(id)}`);
}

/** Signed-in uid (auth first, then the unlocked keystore). */
export function myUid() {
  const uid = auth.currentUser?.uid || currentUid();
  if (!uid) throw new Error('Not signed in');
  return uid;
}

/** True if `key` is usable as a {key}/{id} (<= 128 chars, no RTDB-forbidden characters). */
export const isValidKey = (key) => typeof key === 'string' && !!key && key.length <= LIMITS.key && !BAD_KEY.test(key);

// ---------- paths ----------

export function udataPath(uid, feat, key) {
  checkId(uid, 'uid');
  checkFeat(feat);
  if (key === undefined) return `udata/${uid}/${feat}`;
  checkKey(key);
  return `udata/${uid}/${feat}/${key}`;
}
export function upubPath(uid, feat, key) {
  checkId(uid, 'uid');
  checkFeat(feat);
  if (key === undefined) return `upub/${uid}/${feat}`;
  checkKey(key);
  return `upub/${uid}/${feat}/${key}`;
}
export function sconfPath(sid, feat, key) {
  checkId(sid, 'server id');
  checkFeat(feat);
  if (key === undefined) return `sconf/${sid}/${feat}`;
  checkKey(key);
  return `sconf/${sid}/${feat}/${key}`;
}
export function sitemsPath(sid, feat, id) {
  checkId(sid, 'server id');
  checkFeat(feat);
  if (id === undefined) return `sitems/${sid}/${feat}`;
  checkKey(id, 'item id');
  return `sitems/${sid}/${feat}/${id}`;
}
export function pubPath(kind, id) {
  if (!PUB_KINDS.includes(kind)) throw new Error(`Invalid catalog kind: ${String(kind)}`);
  if (id === undefined) return `pub/${kind}`;
  checkKey(id, 'catalog id');
  return `pub/${kind}/${id}`;
}

// ---------- refs ----------

/** My private data: udata/{me}/{feat}[/{key}]. */
export const udataRef = (feat, key) => ref(db, udataPath(myUid(), feat, key));
/** Public per-user data: upub/{uid}/{feat}[/{key}]. */
export const upubRef = (uid, feat, key) => ref(db, upubPath(uid, feat, key));
/** Server config: sconf/{sid}/{feat}[/{key}]. */
export const sconfRef = (sid, feat, key) => ref(db, sconfPath(sid, feat, key));
/** Member items: sitems/{sid}/{feat}[/{id}]. */
export const sitemsRef = (sid, feat, id) => ref(db, sitemsPath(sid, feat, id));
/** Public catalog: pub/{kind}[/{id}]. */
export const pubRef = (kind, id) => ref(db, pubPath(kind, id));

// ---------- writes that need fixed fields ----------

/** Create a member item with a fresh push id; `by` is set to me. Resolves to the id. */
export async function addSitem(sid, feat, fields) {
  const r = push(sitemsRef(sid, feat));
  await set(r, { ...fields, by: myUid() });
  return r.key;
}

/** Update my own member item (by stays me). */
export function updateSitem(sid, feat, id, fields) {
  return update(sitemsRef(sid, feat, id), { ...fields, by: myUid() });
}

/**
 * Create or replace a catalog entry pub/{kind}/{id} (id defaults to a fresh push id; for `servers`
 * it must be the server id). Sets `by` = me and `ts` = server time. Resolves to the id.
 */
export async function putPub(kind, id, fields) {
  const r = id ? pubRef(kind, id) : push(pubRef(kind));
  await set(r, { ...fields, by: myUid(), ts: serverTimestamp() });
  return r.key;
}

/** Change some fields of my catalog entry (ts is refreshed, as the rules require). */
export function updatePub(kind, id, fields) {
  return update(pubRef(kind, id), { ...fields, by: myUid(), ts: serverTimestamp() });
}

// ---------- live hooks ----------

/** Live value of a path or query: { loading, value, error }. Re-subscribes when `dep` changes. */
function useLive(make, dep) {
  const [state, setState] = useState({ loading: true, value: null, error: null, dep });
  useEffect(() => {
    let target = null;
    try {
      target = make();
    } catch (e) {
      setState({ loading: false, value: null, error: e, dep });
      return undefined;
    }
    if (!target) {
      setState({ loading: false, value: null, error: null, dep });
      return undefined;
    }
    setState((s) => (s.dep === dep ? s : { loading: true, value: null, error: null, dep }));
    return onValue(
      target,
      (snap) => setState({ loading: false, value: snap.val(), error: null, dep }),
      (error) => setState({ loading: false, value: null, error, dep }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return state.dep === dep ? state : { loading: true, value: null, error: null };
}

/** My udata/{me}/{feat}[/{key}]. Pass feat = null to skip. */
export function useUdata(feat, key) {
  const uid = auth.currentUser?.uid || currentUid() || null;
  return useLive(() => (feat && uid ? ref(db, udataPath(uid, feat, key)) : null), `${uid}|${feat}|${key ?? ''}`);
}

/** upub/{uid}/{feat}[/{key}]. Pass uid = null to skip. */
export function useUpub(uid, feat, key) {
  return useLive(() => (uid && feat ? upubRef(uid, feat, key) : null), `${uid}|${feat}|${key ?? ''}`);
}

/** sconf/{sid}/{feat}[/{key}] (members only). Pass sid = null to skip. */
export function useSconf(sid, feat, key) {
  return useLive(() => (sid && feat ? sconfRef(sid, feat, key) : null), `${sid}|${feat}|${key ?? ''}`);
}

/**
 * sitems/{sid}/{feat} as { loading, value, items, error }: items = [{ id, ...fields }] in key order
 * (push ids sort by creation). opts.last = n loads only the newest n; opts.by = uid filters (client side).
 */
export function useSitems(sid, feat, opts = {}) {
  const { last, by } = opts;
  const st = useLive(() => {
    if (!sid || !feat) return null;
    const r = sitemsRef(sid, feat);
    return last ? query(r, limitToLast(last)) : r;
  }, `${sid}|${feat}|${last ?? ''}`);
  const items = useMemo(() => {
    const v = st.value && typeof st.value === 'object' ? st.value : {};
    return Object.keys(v)
      .sort()
      .map((id) => ({ id, ...(v[id] && typeof v[id] === 'object' ? v[id] : {}) }))
      .filter((it) => !by || it.by === by);
  }, [st.value, by]);
  return { ...st, items };
}

/**
 * pub/{kind}/{id} (one entry) or the catalog: { loading, value, items, error }.
 * Catalog opts: { last: n } newest n by ts (default 100), { by: uid } one publisher's entries.
 */
export function usePub(kind, id, opts = {}) {
  const { last = 100, by } = opts;
  const st = useLive(() => {
    if (!kind) return null;
    if (id) return pubRef(kind, id);
    if (by) return query(pubRef(kind), orderByChild('by'), equalTo(by));
    return query(pubRef(kind), orderByChild('ts'), limitToLast(last));
  }, `${kind}|${id ?? ''}|${last}|${by ?? ''}`);
  const items = useMemo(
    () => (!id && st.value && typeof st.value === 'object'
      ? Object.entries(st.value).map(([k, v]) => ({ id: k, ...(v && typeof v === 'object' ? v : {}) })).sort((a, b) => (b.ts || 0) - (a.ts || 0))
      : []),
    [id, st.value],
  );
  return { ...st, items };
}

// ---------- encryption ----------

const isBox = (b) => !!b && typeof b === 'object' && typeof b.iv === 'string' && typeof b.ct === 'string';

/**
 * Encrypt JSON with the server key (AES-GCM). `aad` must be `<kind>:{sid}/{id}` (it must contain
 * ":{sid}"), so a box can't be moved to another server or item. Resolves to { iv, ct }.
 */
export async function sealForServer(sid, aad, obj) {
  if (typeof aad !== 'string' || !aad.includes(`:${sid}`)) throw new Error('sealForServer: the AAD must name the server (`<kind>:{sid}/{id}`)');
  return encryptJSON(await getServerKey(sid), obj, aad);
}

/** Decrypt a box made by sealForServer with the same aad. Throws if it was moved or altered. */
export async function openForServer(sid, aad, box) {
  if (!isBox(box)) throw new Error('Not an encrypted box');
  return decryptJSON(await getServerKey(sid), { iv: box.iv, ct: box.ct }, aad);
}

/** Encrypt JSON with my vault key (only I can read it). Use aad `<kind>:{uid}/{key}`. */
export async function sealForMe(aad, obj) {
  if (typeof aad !== 'string' || !aad) throw new Error('sealForMe: aad is required');
  return vaultEncryptJSON(obj, aad);
}

/** Decrypt a box made by sealForMe with the same aad. */
export async function openForMe(aad, box) {
  if (!isBox(box)) throw new Error('Not an encrypted box');
  return vaultDecryptJSON({ iv: box.iv, ct: box.ct }, aad);
}

/** True if a sealed box fits one leaf-field limit (`ct` is the long part). */
export const boxFits = (box, limit = LIMITS.sconf) => isBox(box) && box.ct.length <= limit && box.iv.length <= limit;

// Reminders: storage in udata/{me}/reminders (sealed with the vault key), a shared live decrypted list,
// and the one-time "fire" step (transaction on the record, then a self-notification in notifs/{me}).
// Model and payload shape: reminderModel.js.
import { useEffect, useSyncExternalStore } from 'react';
import { get, onValue, push, ref, remove, runTransaction, serverTimestamp, set, update } from 'firebase/database';
import { auth, db } from '../../../lib/firebase.js';
import { currentUid, onLock } from '../../../lib/keystore.js';
import { myUid, openForMe, sealForMe, udataPath } from '../../../lib/ext/store.js';
import { cleanRef } from '../../../lib/notifSend.js';
import { MAX_REMINDERS, buildPayload, cleanPayload, reminderAad } from './reminderModel.js';

export const FEAT = 'reminders';
export const NOTIF_KIND = 'reminder';

const EMPTY = Object.freeze({ uid: null, loading: true, list: Object.freeze([]), error: null });
const store = { uid: null, unsub: null, refs: 0, gen: 0, value: EMPTY, listeners: new Set(), cache: new Map() };

function setValue(v) {
  store.value = v;
  for (const fn of [...store.listeners]) fn();
}

async function decryptAll(uid, raw) {
  const entries = Object.entries(raw && typeof raw === 'object' ? raw : {});
  const out = await Promise.all(entries.map(async ([id, rec]) => {
    if (!rec || typeof rec.iv !== 'string' || typeof rec.ct !== 'string') return null;
    const k = `${uid}|${id}|${rec.iv}|${rec.ct}`;
    let p = store.cache.get(k);
    if (!p) {
      p = openForMe(reminderAad(uid, id), { iv: rec.iv, ct: rec.ct }).then(cleanPayload, () => null);
      store.cache.set(k, p);
      if (store.cache.size > 1000) store.cache.delete(store.cache.keys().next().value);
    }
    const payload = await p;
    if (!payload) return null;
    return {
      id,
      ...payload,
      fired: Number.isFinite(rec.fired) ? rec.fired : null,
      done: Number.isFinite(rec.done) ? rec.done : null,
    };
  }));
  return out.filter(Boolean);
}

function attach(uid) {
  store.uid = uid;
  const gen = ++store.gen;
  setValue({ uid, loading: true, list: [], error: null });
  store.unsub = onValue(
    ref(db, udataPath(uid, FEAT)),
    (snap) => {
      const mine = ++store.gen;
      decryptAll(uid, snap.val()).then((list) => {
        if (store.gen === mine && store.uid === uid) setValue({ uid, loading: false, list, error: null });
      });
    },
    (error) => {
      if (store.gen >= gen && store.uid === uid) setValue({ uid, loading: false, list: [], error });
    },
  );
}

function detach() {
  store.unsub?.();
  store.unsub = null;
  store.uid = null;
  store.gen++;
  setValue(EMPTY);
}

function acquire(uid) {
  if (!uid) return () => {};
  if (store.uid !== uid) {
    if (store.unsub) detach();
    attach(uid);
  }
  store.refs++;
  return () => {
    store.refs--;
    if (store.refs <= 0) {
      store.refs = 0;
      detach();
    }
  };
}

onLock(() => {
  store.cache.clear();
});

const snapshot = () => store.value;
const subscribe = (fn) => {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
};

/** Live decrypted reminders of the signed-in user: { loading, list, error }. */
export function useReminders() {
  const uid = auth.currentUser?.uid || currentUid() || null;
  useEffect(() => acquire(uid), [uid]);
  const v = useSyncExternalStore(subscribe, snapshot, snapshot);
  return v.uid === uid ? v : EMPTY;
}

const recRef = (id) => ref(db, `${udataPath(myUid(), FEAT)}/${id}`);

/** Create a reminder. input = { due, note?, conv, mid?, title?, excerpt?, author? }. Resolves { id, ...payload }. */
export async function createReminder(input) {
  const uid = myUid();
  const existing = (await get(ref(db, udataPath(uid, FEAT)))).val();
  if (existing && Object.keys(existing).length >= MAX_REMINDERS) {
    throw new Error(`You can keep up to ${MAX_REMINDERS} reminders. Delete some finished ones first.`);
  }
  const payload = buildPayload(input);
  const r = push(ref(db, udataPath(uid, FEAT)));
  const box = await sealForMe(reminderAad(uid, r.key), payload);
  await set(r, { iv: box.iv, ct: box.ct });
  return { id: r.key, ...payload, fired: null, done: null };
}

function payloadOf(r) {
  const { id, fired, done, ...rest } = r; // eslint-disable-line no-unused-vars
  return rest;
}

/** Move a reminder to a new time (it becomes upcoming again). */
export async function snoozeReminder(r, due) {
  const uid = myUid();
  const payload = buildPayload({ ...payloadOf(r), due }, payloadOf(r).createdAt || Date.now());
  const box = await sealForMe(reminderAad(uid, r.id), payload);
  await update(recRef(r.id), { iv: box.iv, ct: box.ct, fired: null, done: null });
}

export const markDone = (r) => update(recRef(r.id), { done: Date.now() });
export const markUndone = (r) => update(recRef(r.id), { done: null });
export const deleteReminder = (r) => remove(recRef(r.id));

/**
 * Fire a due reminder once across tabs and devices: a transaction sets `fired` only if nobody did,
 * then a self-notification goes to the notification center. Resolves true when this call fired it.
 */
export async function fireReminder(r) {
  const uid = myUid();
  const stamp = Date.now();
  const res = await runTransaction(recRef(r.id), (cur) => {
    if (cur === null) return null; // not cached yet (the server value retries) or deleted
    if (!cur || typeof cur !== 'object' || cur.fired || cur.done) return undefined; // abort
    return { ...cur, fired: stamp };
  }, { applyLocally: false });
  if (!res.committed || res.snapshot.val()?.fired !== stamp) return false;
  try {
    const nid = push(ref(db, `notifs/${uid}`)).key;
    const c = r.conv || {};
    const target = c.kind === 'channel' ? { sid: c.sid, cid: c.cid } : c.kind === 'dm' ? { dmId: c.dmId } : { gid: c.gid };
    if (r.mid) target.mid = r.mid;
    await set(ref(db, `notifs/${uid}/${nid}`), { kind: NOTIF_KIND, from: uid, ts: serverTimestamp(), ref: cleanRef(target) });
    return nid;
  } catch {
    return true; // fired; the notification center entry is best effort
  }
}

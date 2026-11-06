// Verified contacts & key-change alerts (F12).
//
// verified/{uid}/{peerUid} = { fp, ts } — owner only. `fp` is keyFingerprint(peer pubKey) at the moment I
// compared safety numbers. The peer's public key is always read live from users/{peer}/pubKey (never the
// keystore cache), so a key swap shows up as status 'changed' immediately.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, onValue, ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from './firebase.js';
import { keyFingerprint } from './crypto.js';

const uidOf = (me) => (typeof me === 'string' ? me : me?.uid) || null;

/** Fingerprint of the peer's CURRENT public key, read from the server (bypasses keystore cache). */
export async function fetchPeerFingerprint(peerUid) {
  const snap = await get(ref(db, `users/${peerUid}/pubKey`));
  const jwk = snap.val();
  if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('This person has no encryption key yet');
  return keyFingerprint(jwk);
}

/**
 * Mark `peerUid` verified with the fingerprint of their current key.
 * `expectFp` (optional): the fingerprint the user actually saw (e.g. in SafetyNumberModal). If the live
 * key differs, nothing is stored and an error is thrown — the user compared a number for an old key.
 */
export async function markVerified(me, peerUid, { expectFp } = {}) {
  const uid = uidOf(me);
  if (!uid || !peerUid || uid === peerUid) throw new Error('Nothing to verify');
  const fp = await fetchPeerFingerprint(peerUid);
  if (expectFp && expectFp !== fp) {
    throw new Error('Their key changed while this window was open. Close it and compare the new safety number.');
  }
  await set(ref(db, `verified/${uid}/${peerUid}`), { fp, ts: serverTimestamp() });
  return fp;
}

export function clearVerified(me, peerUid) {
  const uid = uidOf(me);
  if (!uid || !peerUid) return Promise.resolve();
  return remove(ref(db, `verified/${uid}/${peerUid}`));
}

/**
 * Detailed live status:
 *   { status: 'loading' | 'nokey' | 'unverified' | 'verified' | 'changed', fp, verifiedFp, verifiedAt, error }
 */
export function useVerification(me, peerUid) {
  const uid = uidOf(me);
  const [rec, setRec] = useState({ key: null, value: undefined });
  const [cur, setCur] = useState({ key: null, fp: undefined });

  useEffect(() => {
    if (!uid || !peerUid) return undefined;
    const key = `${uid}|${peerUid}`;
    return onValue(
      ref(db, `verified/${uid}/${peerUid}`),
      (s) => {
        const v = s.val();
        setRec({ key, value: v && typeof v.fp === 'string' ? { fp: v.fp, ts: typeof v.ts === 'number' ? v.ts : 0 } : null });
      },
      () => setRec({ key, value: null }),
    );
  }, [uid, peerUid]);

  useEffect(() => {
    if (!peerUid) return undefined;
    let alive = true;
    let seq = 0;
    // A live listener on the key itself: always the server's value, and it catches rotations mid-chat.
    const unsub = onValue(
      ref(db, `users/${peerUid}/pubKey`),
      (s) => {
        const jwk = s.val();
        const mine = ++seq;
        if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
          setCur({ key: peerUid, fp: null });
          return;
        }
        keyFingerprint(jwk).then(
          (fp) => alive && mine === seq && setCur({ key: peerUid, fp }),
          () => alive && mine === seq && setCur({ key: peerUid, fp: null }),
        );
      },
      () => alive && setCur({ key: peerUid, fp: null }),
    );
    return () => {
      alive = false;
      unsub();
    };
  }, [peerUid]);

  return useMemo(() => {
    const recV = rec.key === `${uid}|${peerUid}` ? rec.value : undefined;
    const curFp = cur.key === peerUid ? cur.fp : undefined;
    if (!uid || !peerUid || recV === undefined || curFp === undefined) {
      return { status: 'loading', fp: null, verifiedFp: null, verifiedAt: 0 };
    }
    const base = { fp: curFp, verifiedFp: recV?.fp || null, verifiedAt: recV?.ts || 0 };
    if (!curFp) return { status: recV ? 'changed' : 'nokey', ...base };
    if (!recV) return { status: 'unverified', ...base };
    return { status: recV.fp === curFp ? 'verified' : 'changed', ...base };
  }, [uid, peerUid, rec, cur]);
}

/** 'loading' | 'nokey' | 'unverified' | 'verified' | 'changed' */
export function useKeyChangeStatus(me, peerUid) {
  return useVerification(me, peerUid).status;
}

// ---------- One-time send confirmation while a key is 'changed' ----------
// Acknowledgements are per tab (sessionStorage) and per (peer, new fingerprint), so a further change
// asks again.

const ACK_KEY = 'codehub.keyChangeAck';

function readAcks() {
  try {
    return JSON.parse(sessionStorage.getItem(ACK_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

/**
 * For the composer: `{ mustConfirm, acknowledge }`. When `mustConfirm` is true the integrator shows a
 * confirm before the first send, then calls `acknowledge()`.
 */
export function useKeyChangeAck(me, peerUid) {
  const v = useVerification(me, peerUid);
  const ackId = `${peerUid}|${v.fp || 'none'}`;
  const [localAck, setLocalAck] = useState(null); // fallback when sessionStorage is unavailable
  const acked = useMemo(() => localAck === ackId || !!readAcks()[ackId], [ackId, localAck]);
  const acknowledge = useCallback(() => {
    try {
      const a = readAcks();
      a[ackId] = Date.now();
      sessionStorage.setItem(ACK_KEY, JSON.stringify(a));
    } catch {
      /* private mode: localAck still covers this mount */
    }
    setLocalAck(ackId);
  }, [ackId]);
  return { status: v.status, mustConfirm: v.status === 'changed' && !acked, acknowledge };
}

/** Paths deleteAccount() must clear for `uid`. */
export const verifyCleanupPaths = (uid) => [`verified/${uid}`];

// Premium membership status: the contract every premium feature reads.
//
// premium/{uid} = { at, until, m }: written by the member when they redeem the current monthly code
// (the rules compare their guess in promoAttempts/{uid} with premiumCodes/{m}/c, readable only by the
// owner). `until` = redemption time + 30 days (server clock). Anyone signed in may read one member's
// record (to show premium perks); see docs/features/premium.md.
import { useEffect, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { serverNow } from '../../../lib/messages.js';

/** How long one redemption lasts. */
export const PREMIUM_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a premium record is active at server time `now`. */
export function isPremiumActive(rec, now = serverNow()) {
  return !!rec && typeof rec.until === 'number' && rec.until > now;
}

/**
 * Live premium state of `uid`: `{ loading, record, active, until }`. Re-renders when the record
 * changes and when it expires.
 */
export function usePremium(uid) {
  const [state, setState] = useState({ loading: !!uid, record: null });
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!uid) {
      setState({ loading: false, record: null });
      return undefined;
    }
    setState({ loading: true, record: null });
    return onValue(
      ref(db, `premium/${uid}`),
      (s) => setState({ loading: false, record: s.val() }),
      () => setState({ loading: false, record: null }),
    );
  }, [uid]);
  const until = typeof state.record?.until === 'number' ? state.record.until : 0;
  const active = isPremiumActive(state.record);
  useEffect(() => {
    if (!active) return undefined;
    const ms = Math.min(until - serverNow() + 500, 2 ** 31 - 1);
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [active, until]);
  return { loading: state.loading, record: state.record, active, until };
}

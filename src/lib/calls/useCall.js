// App-wide call store (one active call per tab) plus React hooks.
//   useActiveCall()       → snapshot of the current session (or null) + actions; drives CallView/MiniCallBar.
//   useCallMeta(scope)    → live `calls/{scope}` (participants) for headers and voice channels.
//   useCall(scope)        → both, scoped: { meta, participants, active, inThisCall, join(kind), leave }.
//   useIncomingCalls(me)  → ringing call notifs still live (for IncomingCallModal).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { endAt, onValue, query, ref, orderByChild, startAt, update } from 'firebase/database';
import { db } from '../firebase.js';
import { onLock } from '../keystore.js';
import { CallSession } from './mesh.js';
import { RING_MS, STALE_MS, callPath, cleanupIfEmpty, scopeFromRef } from './core.js';

let session = null;
let snap = null;
const listeners = new Set();

function snapshot(s) {
  if (!s) return null;
  return {
    scope: s.scope,
    me: s.me,
    kind: s.kind,
    status: s.status,
    error: s.error,
    callId: s.callId,
    mic: s.mic,
    deafened: s.deafened,
    camOn: s.camOn,
    screenOn: s.screenOn,
    devices: s.devices,
    slots: s.slots,
    speaking: new Set(s.speaking),
    localVideo: s.videoOut,
    peers: [...s.peers.values()].map((p) => ({ uid: p.uid, stream: p.stream, state: p.state, tracks: p.stream.getTracks().length })),
  };
}

function publish() {
  snap = snapshot(session);
  listeners.forEach((fn) => fn());
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Start or join the call in `scope`. Ends any other active call first. */
export async function joinCall(scope, me, { kind = 'audio', ring = true } = {}) {
  if (session && session.scope === scope && !session.closed) return session;
  if (session) await leaveCall();
  const s = new CallSession({
    scope,
    me,
    kind,
    onChange: (x) => {
      if (session === x) publish();
    },
  });
  session = s;
  publish();
  await s.start({ ring });
  return s;
}

export async function leaveCall() {
  const s = session;
  if (!s) return;
  await s.hangup();
  if (session === s) {
    session = null;
    publish();
  }
}

/** Clear a finished/errored session from the store (after its error was shown). */
export function dismissCall() {
  if (session && session.closed) {
    session = null;
    publish();
  }
}

export const callActions = {
  toggleMic: () => session?.toggleMic(),
  toggleDeafen: () => session?.toggleDeafen(),
  toggleCam: () => session?.toggleCam(),
  toggleScreen: () => session?.toggleScreen(),
  setDevices: (patch) => session?.setDevices(patch),
  leave: leaveCall,
  dismiss: dismissCall,
};

// Locking the vault (sign-out) ends the call: keys are gone.
onLock(() => {
  if (session) leaveCall();
});
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (session) session.hangup();
  });
}

export function useActiveCall() {
  return useSyncExternalStore(subscribe, () => snap, () => null);
}

/** Live call meta for a scope: `{ id, kind, ts, startedBy, participants: [slot…] }` or null. */
export function useCallMeta(scope) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    if (!scope) return undefined;
    setMeta(null);
    let cleaned = false;
    return onValue(
      ref(db, callPath(scope)),
      (s) => {
        const v = s.val();
        if (!v?.id) return setMeta(null);
        const participants = Object.entries(v.slots || {})
          .filter(([, x]) => x?.uid)
          .map(([i, x]) => ({ index: Number(i), ...x }))
          .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
        // Client-side stale cleanup: a call with no slots for 60 s is over.
        if (!participants.length && typeof v.ts === 'number' && Date.now() - v.ts > STALE_MS && !cleaned) {
          cleaned = true;
          cleanupIfEmpty(scope).catch(() => {});
        }
        setMeta({ id: v.id, kind: v.kind === 'video' ? 'video' : 'audio', ts: v.ts, startedBy: v.startedBy, participants });
      },
      () => setMeta(null),
    );
  }, [scope]);
  return meta;
}

export function useCall(scope, me) {
  const meta = useCallMeta(scope);
  const active = useActiveCall();
  const inThisCall = !!active && active.scope === scope && (active.status === 'live' || active.status === 'joining');
  return useMemo(
    () => ({
      meta,
      participants: meta?.participants || [],
      active,
      inThisCall,
      join: (kind = meta?.kind || 'audio', opts) => joinCall(scope, me, { kind, ...opts }),
      leave: leaveCall,
    }),
    [meta, active, inThisCall, scope, me],
  );
}

/**
 * Ringing calls for me: unread `call` notifs from the last 30 s whose call is still live and that I
 * am not already in. Returns `[{ nid, from, scope, callId, ts }]`. One small time-bounded query.
 */
export function useIncomingCalls(me) {
  const [notifs, setNotifs] = useState([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!me) return undefined;
    const q = query(ref(db, `notifs/${me}`), orderByChild('ts'), startAt(Date.now() - RING_MS), endAt(Date.now() + 86_400_000));
    const off = onValue(
      q,
      (s) => {
        const out = [];
        s.forEach((c) => {
          const v = c.val();
          const scope = scopeFromRef(v?.ref);
          if (v?.kind === 'call' && !v.read && scope && v.ref?.callId) out.push({ nid: c.key, from: v.from, scope, callId: v.ref.callId, ts: v.ts });
        });
        setNotifs(out);
      },
      () => setNotifs([]),
    );
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [me]);
  const active = useActiveCall();
  return useMemo(() => {
    const now = Date.now();
    return notifs.filter((n) => now - (n.ts || 0) < RING_MS && !(active && active.scope === n.scope && !['ended', 'error'].includes(active.status)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifs, active, tick]);
}

/** Mark a ring notification handled (read). */
export function markRingHandled(me, nid) {
  return update(ref(db, `notifs/${me}/${nid}`), { read: true }).catch(() => {});
}

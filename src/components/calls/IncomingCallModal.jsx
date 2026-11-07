// Incoming DM/group call: Accept/Decline with a WebAudio ringtone. Mount once at app level.
import { useEffect, useState } from 'react';
import { useProfile } from '../../lib/profiles.js';
import { joinCall, markRingHandled, useCallMeta, useIncomingCalls } from '../../lib/calls/useCall.js';
import { startRingtone } from '../../lib/calls/media.js';
import { Avatar } from '../layout/ui.jsx';
import CallIcon from './CallIcon.jsx';
import './calls.css';

function Ring({ me, ring, onAccepted, muted }) {
  const meta = useCallMeta(ring.scope);
  const caller = useProfile(ring.from);
  const [busy, setBusy] = useState(false);
  const live = !!meta && meta.id === ring.callId && meta.participants.length > 0;
  useEffect(() => {
    if (!live || muted) return undefined;
    return startRingtone();
  }, [live, muted]);
  useEffect(() => {
    if (meta === null) return undefined;
    // Call ended (or was replaced) before I answered: drop the ring quietly.
    if (!live) {
      const t = setTimeout(() => markRingHandled(me, ring.nid), 3000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [live, meta, me, ring.nid]);
  if (!live) return null;
  const accept = async () => {
    setBusy(true);
    await markRingHandled(me, ring.nid);
    await joinCall(ring.scope, me, { kind: meta.kind, ring: false });
    onAccepted?.(ring.scope);
  };
  const decline = () => markRingHandled(me, ring.nid);
  return (
    <div className="call-incoming" role="alertdialog" aria-label={`Incoming call from ${caller?.name || 'someone'}`}>
      <Avatar profile={caller} size={56} />
      <div className="call-incoming-text">
        <strong>{caller?.name || 'Someone'}</strong>
        <span className="call-dim">
          Incoming {meta.kind === 'video' ? 'video' : 'voice'} call{ring.scope.startsWith('grp_') ? ' · group' : ''}
        </span>
      </div>
      <div className="call-incoming-actions">
        <button className="call-ctl hangup" onClick={decline} disabled={busy} title="Decline">
          <CallIcon name="hangup" />
        </button>
        <button className="call-ctl accept" onClick={accept} disabled={busy} title="Accept">
          <CallIcon name={meta.kind === 'video' ? 'video' : 'phone'} />
        </button>
      </div>
    </div>
  );
}

/**
 * Props: `me` (uid), `onAccepted(scope)` (open the call view), `isBlocked(uid)` optional,
 * `muted` optional: a boolean, or `(scope) => boolean` (e.g. the DM or group is muted in notification
 * settings). A muted ring still shows Accept/Decline, without the ringtone.
 */
export default function IncomingCallModal({ me, onAccepted, isBlocked, muted }) {
  const rings = useIncomingCalls(me).filter((r) => r.from !== me && !isBlocked?.(r.from));
  if (!rings.length) return null;
  const ring = rings[rings.length - 1];
  const silent = typeof muted === 'function' ? !!muted(ring.scope) : !!muted;
  return (
    <div className="call-incoming-wrap">
      <Ring key={ring.nid} me={me} ring={ring} onAccepted={onAccepted} muted={silent} />
    </div>
  );
}

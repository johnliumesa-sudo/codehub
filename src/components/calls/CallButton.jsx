// Voice + video call buttons for DM and group headers. Shows "Join" when a call is already live.
import { useState } from 'react';
import { useCall } from '../../lib/calls/useCall.js';
import { mediaSupported } from '../../lib/calls/media.js';
import CallIcon from './CallIcon.jsx';
import './calls.css';

export default function CallButton({ scope, me, onJoined }) {
  const { meta, participants, inThisCall, join } = useCall(scope, me);
  const [busy, setBusy] = useState(false);
  if (!scope || !me || !mediaSupported()) return null;
  const live = participants.length > 0;

  const start = async (kind) => {
    if (busy || inThisCall) return onJoined?.(scope);
    setBusy(true);
    try {
      await join(kind);
      onJoined?.(scope);
    } finally {
      setBusy(false);
    }
  };

  if (live && !inThisCall) {
    return (
      <button className="btn sm call-join-btn" onClick={() => start(meta?.kind)} disabled={busy} title="Join the call">
        <CallIcon name={meta?.kind === 'video' ? 'video' : 'phone'} size={15} />
        Join call · {participants.length}
      </button>
    );
  }
  return (
    <span className="call-btns">
      <button className="btn ghost sm" onClick={() => start('audio')} disabled={busy} title={inThisCall ? 'Open call' : 'Start voice call'} aria-label="Start voice call">
        <CallIcon name="phone" size={17} />
      </button>
      <button className="btn ghost sm" onClick={() => start('video')} disabled={busy} title={inThisCall ? 'Open call' : 'Start video call'} aria-label="Start video call">
        <CallIcon name="video" size={17} />
      </button>
    </span>
  );
}

// Compact bar for the active call; stays visible while navigating. Hide it while CallView is open.
import { useActiveCall, callActions } from '../../lib/calls/useCall.js';
import CallIcon from './CallIcon.jsx';
import './calls.css';

/** Props: `label` (where the call is, e.g. "#lounge" or a DM name), `onOpen(scope)`, `hidden`. */
export default function MiniCallBar({ label, onOpen, hidden }) {
  const call = useActiveCall();
  if (!call || hidden) return null;
  if (call.status === 'ended' || call.status === 'error') {
    return (
      <div className="call-mini ended" role="status">
        <span>{call.status === 'error' ? call.error || 'Call failed' : 'Call ended'}</span>
        <button className="btn ghost sm" onClick={callActions.dismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  const n = Object.values(call.slots || {}).filter((s) => s?.uid).length;
  return (
    <div className="call-mini" role="region" aria-label="Active call">
      <button className="call-mini-main" onClick={() => onOpen?.(call.scope)} title="Open call">
        <span className={`call-mini-dot ${call.status === 'live' ? 'live' : ''}`} />
        <span className="call-mini-text">
          <strong>{call.status === 'joining' ? 'Joining…' : call.rejoining ? 'Reconnecting…' : 'In call'}</strong>
          <span className="call-dim">{label ? `${label} · ` : ''}{n || 1} {n === 1 ? 'person' : 'people'}</span>
        </span>
      </button>
      <button className={`call-ctl sm ${call.mic ? '' : 'off'}`} onClick={callActions.toggleMic} title={call.mic ? 'Mute' : 'Unmute'} aria-label="Mute" aria-pressed={!call.mic} disabled={call.status !== 'live'}>
        <CallIcon name={call.mic ? 'mic' : 'micOff'} size={16} />
      </button>
      <button className={`call-ctl sm ${call.deafened ? 'off' : ''}`} onClick={callActions.toggleDeafen} title={call.deafened ? 'Undeafen' : 'Deafen'} aria-label="Deafen" aria-pressed={call.deafened} disabled={call.status !== 'live'}>
        <CallIcon name={call.deafened ? 'headsetOff' : 'headset'} size={16} />
      </button>
      <button className="call-ctl sm hangup" onClick={callActions.leave} title="Leave call" aria-label="Leave call">
        <CallIcon name="hangup" size={16} />
      </button>
    </div>
  );
}

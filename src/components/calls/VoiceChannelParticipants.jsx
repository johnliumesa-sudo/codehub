// Participants under a voice channel row in ChannelSidebar. Drop-in: clicking the channel joins.
import { useProfiles } from '../../lib/profiles.js';
import { useActiveCall, useCallMeta } from '../../lib/calls/useCall.js';
import { voiceScope } from '../../lib/calls/core.js';
import { Avatar } from '../layout/ui.jsx';
import CallIcon from './CallIcon.jsx';
import './calls.css';

export default function VoiceChannelParticipants({ sid, cid }) {
  const scope = voiceScope(sid, cid);
  const meta = useCallMeta(scope);
  const active = useActiveCall();
  const parts = meta?.participants || [];
  const profiles = useProfiles(parts.map((p) => p.uid));
  if (!parts.length) return null;
  const speaking = active?.scope === scope ? active.speaking : null;
  return (
    <ul className="call-vc-list" aria-label="In voice">
      {parts.map((p) => (
        <li key={p.uid} className={`call-vc-item ${speaking?.has(p.uid) ? 'speaking' : ''}`}>
          <Avatar profile={profiles[p.uid]} size={20} ring={speaking?.has(p.uid) ? 'var(--ok)' : undefined} />
          <span className="call-vc-name">{profiles[p.uid]?.name || '…'}</span>
          {p.screen && <span className="call-live-tag">LIVE</span>}
          {!p.mic && <CallIcon name="micOff" size={13} title="Muted" />}
          {p.cam && <CallIcon name="video" size={13} title="Camera on" />}
        </li>
      ))}
    </ul>
  );
}

import { usePresence } from '../../lib/presence.js';
import { Avatar, Icon, PRESENCE_LABEL } from './ui.jsx';

export default function UserPanel({ me, onSettings }) {
  const presence = usePresence(me.uid);
  return (
    <div className="ly-userpanel">
      <button className="ly-user-main" onClick={onSettings} title="Profile & settings">
        <Avatar profile={me} size={34} presence={presence} ring="var(--bg-0)" />
        <span className="ly-user-text">
          <span className="ly-user-name">{me.name}</span>
          <span className="ly-user-status">{me.status || PRESENCE_LABEL[presence]}</span>
        </span>
      </button>
      <button className="btn ghost sm ly-icon-btn" onClick={onSettings} title="Settings" aria-label="Settings">
        <Icon name="gear" size={17} />
      </button>
    </div>
  );
}

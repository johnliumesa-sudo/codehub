// Title block for the app header (Header.jsx, home mode) while a group is open.
// Props: { group (from useGroup / useMyGroups), memberCount?, onSettings? }
import { Icon } from '../layout/ui.jsx';
import GroupAvatar from './GroupAvatar.jsx';
import './groups.css';

export default function GroupHeaderTitle({ group, memberCount, onSettings }) {
  const name = group?.name || (group?.nameFailed ? 'Encrypted group' : '…');
  return (
    <div className="ly-head-title grp-head-title">
      <GroupAvatar gid={group?.gid} name={group?.name} failed={group?.nameFailed} size={26} />
      <span className="ly-head-name">{name}</span>
      {typeof memberCount === 'number' && memberCount > 0 && (
        <span className="ly-head-topic">{memberCount === 1 ? '1 member' : `${memberCount} members`}</span>
      )}
      {onSettings && (
        <button className="btn ghost sm ly-icon-btn grp-head-gear" onClick={onSettings} title="Group settings" aria-label="Group settings">
          <Icon name="gear" size={16} />
        </button>
      )}
    </div>
  );
}

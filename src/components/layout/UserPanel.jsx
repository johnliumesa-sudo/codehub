import { Avatar, Icon, useToast } from './ui.jsx';
import { CosmeticBadge, useNameColor } from '../shop/Cosmetics.jsx';
import AdminBadge, { AdminShieldButton } from '../admin/AdminBadge.jsx';
import { PremiumBadge, PremiumName } from '../../features/premium/components/PremiumBits.jsx';
import { MyStatusLine, StatusButton, useMyDisplayPresence } from '../../features/personal/components/StatusMenu.jsx';

export default function UserPanel({ me, onSettings, onAdmin }) {
  // My own dot also shows my chosen mode (invisible, do not disturb).
  const presence = useMyDisplayPresence(me.uid);
  const nameColor = useNameColor(me.uid);
  const toast = useToast();
  return (
    <div className="ly-userpanel">
      <button className="ly-user-main" onClick={onSettings} title="Profile & settings">
        <Avatar profile={me} size={34} presence={presence} ring="var(--bg-0)" />
        <span className="ly-user-text">
          <span className="ly-user-name" style={nameColor ? { color: nameColor } : undefined}>
            <PremiumName uid={me.uid}>{me.name}</PremiumName>
            <CosmeticBadge uid={me.uid} />
            <PremiumBadge uid={me.uid} size={12} />
            <AdminBadge uid={me.uid} size={12} />
          </span>
          <span className="ly-user-status"><MyStatusLine me={me} display={presence} /></span>
        </span>
      </button>
      <StatusButton me={me} onError={(t) => toast(t, 'error')} />
      {onAdmin && <AdminShieldButton onOpen={onAdmin} />}
      <button className="btn ghost sm ly-icon-btn" onClick={onSettings} title="Settings" aria-label="Settings">
        <Icon name="gear" size={17} />
      </button>
    </div>
  );
}

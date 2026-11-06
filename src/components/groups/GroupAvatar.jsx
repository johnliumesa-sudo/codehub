// Round group icon: initials of the (decrypted) name on a color derived from the group id.
import { groupColor } from '../../lib/groups.js';
import { initials } from '../../lib/profiles.js';
import { Icon } from '../layout/ui.jsx';
import './groups.css';

export default function GroupAvatar({ gid, name, size = 32, failed = false }) {
  const style = { width: size, height: size, background: groupColor(gid), fontSize: Math.max(10, Math.round(size * 0.36)) };
  return (
    <span className={`avatar grp-avatar ${failed ? 'failed' : ''}`} style={style} aria-hidden="true">
      {failed ? <Icon name="lock" size={Math.round(size * 0.45)} /> : name ? initials(name) : <Icon name="users" size={Math.round(size * 0.5)} />}
    </span>
  );
}

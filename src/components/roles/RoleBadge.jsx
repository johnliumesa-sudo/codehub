// Small role / timeout markers used in the member list, member card and settings.
import { Icon } from '../layout/ui.jsx';
import { roleLabel, roleOf } from '../../lib/roles.js';
import { fmtUntil } from '../../lib/moderation.js';
import './roles.css';

export function ClockIcon({ size = 13, className = '', title }) {
  return (
    <svg
      className={`rl-clock ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2" />
    </svg>
  );
}

/** Clock shown next to a timed-out member. `until` = untilMs (falsy renders nothing). */
export function TimeoutMark({ until, size = 13 }) {
  if (!until) return null;
  return <ClockIcon size={size} className="rl-timeout-mark" title={`Timed out until ${fmtUntil(until)}`} />;
}

/**
 * Role chip. Pass `role` (a custom role record) directly, or `member` + `roles` to resolve it.
 * Owners and admins show their built-in tag; plain members render nothing unless `showMember`.
 */
export default function RoleBadge({ member, roles, role, showBuiltIn = true, showMember = false, small = false }) {
  const builtIn = member?.role === 'owner' || member?.role === 'admin' ? member.role : null;
  const custom = role || (member ? roleOf(member, roles) : null);
  const cls = `rl-badge ${small ? 'sm' : ''}`;

  if (builtIn && showBuiltIn && !role) {
    return (
      <span className={`${cls} ${builtIn}`}>
        <Icon name={builtIn === 'owner' ? 'crown' : 'shield'} size={small ? 11 : 12} />
        {builtIn === 'owner' ? 'Owner' : 'Admin'}
      </span>
    );
  }
  if (custom) {
    return (
      <span className={cls} style={{ '--rl-color': custom.color }} title={custom.failed ? "This role's name couldn't be decrypted" : undefined}>
        <span className="rl-dot" />
        <span className="rl-badge-name">{roleLabel(custom)}</span>
      </span>
    );
  }
  if (showMember && member) {
    return <span className={`${cls} plain`}>Member</span>;
  }
  return null;
}

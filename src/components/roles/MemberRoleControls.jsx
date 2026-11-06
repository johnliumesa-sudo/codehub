// Per-member moderation controls: custom role dropdown, timeout presets and kick/ban.
// Each control appears only when can(perm) && outranks(target), mirroring the rules; every
// successful action appends a best-effort encrypted audit entry.
import { useState } from 'react';
import { banMember, kickMember } from '../../lib/servers.js';
import { assignRole, assignableRoles, can, outranks, roleLabel, roleOf } from '../../lib/roles.js';
import { TIMEOUT_PRESETS, fmtUntil, serverNow, setTimeoutFor, writeAudit } from '../../lib/moderation.js';
import { ConfirmButton, Icon, Menu, MenuItem, useToast } from '../layout/ui.jsx';
import { ClockIcon } from './RoleBadge.jsx';
import './roles.css';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

/**
 * Props:
 *  sid
 *  me        my member record { uid, role, roleId? }
 *  member    target member record { uid, role, roleId? }
 *  roles     roles map from useServerRoles
 *  timeoutUntil  target's active timeout (untilMs) or 0
 *  name      target's display name (for toasts)
 *  showKickBan   default true; false renders role + timeout only (e.g. in the member card)
 *  layout    'row' (settings list) | 'stack' (member card)
 */
export default function MemberRoleControls({ sid, me, member, roles, timeoutUntil = 0, name, showKickBan = true, layout = 'row' }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  if (!me || !member || me.uid === member.uid) return null;

  const above = outranks(me, member, roles);
  if (!above) return null;
  const canRoles = can(me, roles, 'manageRoles');
  const canTimeout = can(me, roles, 'timeout');
  const canKick = showKickBan && can(me, roles, 'kick');
  const canBan = showKickBan && can(me, roles, 'ban');
  if (!canRoles && !canTimeout && !canKick && !canBan) return null;

  const who = name || 'Member';
  const current = roleOf(member, roles);
  const dangling = typeof member.roleId === 'string' && member.roleId && !current;
  const options = assignableRoles(me, roles);
  const timedOut = timeoutUntil > serverNow();

  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = (rid) =>
    run(async () => {
      await assignRole(sid, member.uid, rid || null);
      const next = rid ? roles[rid] : null;
      writeAudit(sid, me, {
        action: 'role.assign',
        target: member.uid,
        detail: next ? `→ ${roleLabel(next)}` : current ? `removed ${roleLabel(current)}` : 'cleared role',
      });
    }, rid ? `${who} now has ${roleLabel(roles[rid])}` : `Removed ${who}'s role`);

  const timeout = (ms, label) =>
    run(async () => {
      await setTimeoutFor(sid, member.uid, ms);
      writeAudit(sid, me, { action: 'timeout', target: member.uid, detail: ms ? label : 'removed' });
    }, ms ? `${who} is timed out for ${label}` : `Lifted ${who}'s timeout`);

  return (
    <div className={`rl-controls ${layout}`}>
      {canRoles && (
        <select
          className="input rl-role-select"
          value={dangling ? '__dangling' : member.roleId || ''}
          disabled={busy}
          onChange={(e) => e.target.value !== '__dangling' && changeRole(e.target.value)}
          aria-label={`Custom role for ${who}`}
          title="Custom role — only roles below yours are listed"
          style={current ? { '--rl-color': current.color } : undefined}
        >
          <option value="">No role</option>
          {dangling && <option value="__dangling" disabled>(deleted role)</option>}
          {options.map((r) => (
            <option key={r.rid} value={r.rid}>
              {roleLabel(r)} · {r.position}
            </option>
          ))}
        </select>
      )}
      {canTimeout && (
        <span className="rl-menu-anchor">
          <button
            className={`btn sm ${timedOut ? 'rl-timed' : ''}`}
            disabled={busy}
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={timedOut ? `Timed out until ${fmtUntil(timeoutUntil)}` : 'Time out'}
          >
            <ClockIcon size={13} /> {timedOut ? 'Timed out' : 'Timeout'}
          </button>
          <Menu open={menuOpen} onClose={() => setMenuOpen(false)} align="right" className="rl-timeout-menu">
            {TIMEOUT_PRESETS.map((p) => (
              <MenuItem key={p.ms} onClick={() => timeout(p.ms, p.label)}>{p.label}</MenuItem>
            ))}
            {timedOut && <div className="ly-menu-sep" />}
            {timedOut && <MenuItem icon="x" danger onClick={() => timeout(null)}>Remove timeout</MenuItem>}
          </Menu>
        </span>
      )}
      {canKick && (
        <ConfirmButton
          className="btn sm"
          confirmLabel="Kick?"
          disabled={busy}
          onConfirm={() =>
            run(async () => {
              await kickMember(sid, member.uid);
              writeAudit(sid, me, { action: 'kick', target: member.uid });
            }, `${who} was removed`)
          }
        >
          Kick
        </ConfirmButton>
      )}
      {canBan && (
        <ConfirmButton
          confirmLabel="Ban?"
          disabled={busy}
          onConfirm={() =>
            run(async () => {
              await banMember(sid, member.uid);
              writeAudit(sid, me, { action: 'ban', target: member.uid });
            }, `${who} was banned`)
          }
        >
          <Icon name="ban" size={13} /> Ban
        </ConfirmButton>
      )}
    </div>
  );
}

// Server Settings → Roles. Visible to owner, admins and anyone with `manageRoles`.
// Lists custom roles high → low; create / edit / reorder (position) / delete roles below my rank.
import { useState } from 'react';
import {
  PERMS,
  PERM_LABELS,
  can,
  deleteRole,
  isStaff,
  maxAssignablePosition,
  roleEditBlocker,
  roleLabel,
  roleOf,
  sortRoles,
  updateRole,
  useServerRoles,
} from '../../lib/roles.js';
import { writeAudit } from '../../lib/moderation.js';
import { ConfirmButton, Icon, useToast } from '../layout/ui.jsx';
import RoleEditor from './RoleEditor.jsx';
import './roles.css';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

function PositionInput({ role, disabled, onCommit }) {
  const [v, setV] = useState(String(role.position));
  const [last, setLast] = useState(role.position);
  if (last !== role.position) {
    setLast(role.position);
    setV(String(role.position));
  }
  const commit = () => {
    const n = Number(v);
    if (n === role.position) return;
    onCommit(n).catch(() => setV(String(role.position)));
  };
  return (
    <input
      className="input rl-pos-inline"
      type="number"
      min={1}
      max={899}
      step={1}
      value={v}
      disabled={disabled}
      aria-label={`Position of ${roleLabel(role)}`}
      title={disabled ? 'Locked' : 'Position — higher outranks lower. Press Enter to save.'}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') setV(String(role.position));
      }}
    />
  );
}

/**
 * Props: sid, me (my member record { uid, role, roleId }), members (from useMembers, with roleId),
 *        roles? (map from useServerRoles — fetched here when omitted)
 */
export default function RolesTab({ sid, me, members, roles: rolesProp }) {
  const own = useServerRoles(rolesProp ? null : sid);
  const roles = rolesProp || own.roles;
  const loading = !rolesProp && own.loading;
  const toast = useToast();
  const [editing, setEditing] = useState(null); // null | 'new' | rid

  const list = sortRoles(roles);
  const mayManage = can(me, roles, 'manageRoles');
  const staff = isStaff(me);
  const mine = roleOf(me, roles);
  const createBlock = !mayManage
    ? 'You need the “Manage roles” permission.'
    : maxAssignablePosition(me, roles) === null
      ? 'Your role is at the lowest position, so there is no room below it.'
      : null;

  // A role deleted elsewhere while open simply drops back to the list.
  const role = editing && editing !== 'new' ? roles[editing] || null : null;
  if (editing === 'new' || role) {
    return (
      <RoleEditor
        key={editing}
        sid={sid}
        me={me}
        roles={roles}
        members={members}
        role={role}
        onDone={() => setEditing(null)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const count = (rid) => (members || []).filter((m) => m.role === 'member' && m.roleId === rid).length;

  const reposition = async (role, n) => {
    const next = { ...role, position: n };
    const why = roleEditBlocker(me, roles, role, next);
    if (why) {
      toast(why, 'error');
      throw new Error(why);
    }
    try {
      await updateRole(sid, role.rid, { position: n });
      writeAudit(sid, me, { action: 'role.update', target: role.rid, detail: `${roleLabel(role)} · position ${role.position}→${n}` });
    } catch (e) {
      toast(errMsg(e), 'error');
      throw e;
    }
  };

  return (
    <div className="ly-form rl-tab">
      <div className="rl-tab-head">
        <div>
          <div className="ly-list-head">Roles — {list.length}</div>
          <p className="muted ly-hint">
            {staff
              ? 'Owner (1000) and admins (900) outrank every custom role. Members can hold one custom role.'
              : mine
                ? `Your role “${roleLabel(mine)}” is at position ${mine.position}. You can manage roles below it.`
                : 'You can view roles but not change them.'}
          </p>
        </div>
        <button className="btn primary" disabled={!!createBlock} title={createBlock || 'Create a role'} onClick={() => setEditing('new')}>
          <Icon name="plus" size={15} /> Create role
        </button>
      </div>

      <div className="rl-builtin">
        <span className="rl-badge owner"><Icon name="crown" size={12} /> Owner · 1000</span>
        <span className="rl-badge admin"><Icon name="shield" size={12} /> Admins · 900</span>
        <span className="muted rl-help">All permissions, built in.</span>
      </div>

      {loading && <div className="spinner ly-spinner-sm" />}
      {own.error && !rolesProp && <p className="error-text">Couldn't load roles.</p>}
      {!loading && list.length === 0 && <p className="muted">No custom roles yet. Create one to delegate moderation without making someone an admin.</p>}

      <div className="ly-rows">
        {list.map((r) => {
          const lock = roleEditBlocker(me, roles, r, null);
          const permNames = PERMS.filter((p) => r.perms[p]);
          const n = count(r.rid);
          return (
            <div key={r.rid} className={`ly-row rl-role-row ${lock ? 'locked' : ''}`} style={{ '--rl-color': r.color }}>
              <div className="ly-row-main">
                <span className="rl-dot lg" />
                <span className="rl-role-main">
                  <span className="rl-role-name" title={r.failed ? "This role's name couldn't be decrypted with your server key" : undefined}>
                    {roleLabel(r)}
                    {lock && <Icon name="lock" size={12} className="rl-lock" title={lock} />}
                  </span>
                  <span className="muted rl-role-meta">
                    {n} member{n === 1 ? '' : 's'} ·{' '}
                    {permNames.length ? permNames.map((p) => PERM_LABELS[p]).join(', ') : 'no permissions'}
                  </span>
                </span>
              </div>
              <div className="ly-row-actions">
                <PositionInput role={r} disabled={!!lock} onCommit={(v) => reposition(r, v)} />
                <button className="btn sm" onClick={() => setEditing(r.rid)} title={lock || 'Edit role'}>
                  <Icon name={lock ? 'lock' : 'pencil'} size={13} /> {lock ? 'View' : 'Edit'}
                </button>
                {!lock && (
                  <ConfirmButton
                    confirmLabel={n ? `Delete (${n})?` : 'Delete?'}
                    onConfirm={async () => {
                      try {
                        await deleteRole(sid, r.rid, members, me, roles);
                        writeAudit(sid, me, { action: 'role.delete', target: r.rid, detail: roleLabel(r) });
                        toast('Role deleted', 'success');
                      } catch (e) {
                        toast(errMsg(e), 'error');
                      }
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </ConfirmButton>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="muted ly-hint">
        <Icon name="lock" size={12} /> Role names are encrypted with the server key. Color, position and permissions are plaintext
        metadata so the database rules can enforce them. Deleting a role removes it from everyone; members you can't manage keep a
        dead reference that grants nothing.
      </p>
    </div>
  );
}

// Create / edit one custom role. Only roles below my rank are editable and I can only grant
// permissions I hold; disabled controls say why. The rules enforce the same constraints.
import { useMemo, useState } from 'react';
import {
  MAX_ROLE_NAME,
  PERMS,
  PERM_HINTS,
  PERM_LABELS,
  ROLE_COLORS,
  canGrantPerm,
  cleanRoleName,
  createRole,
  deleteRole,
  isHexColor,
  isStaff,
  maxAssignablePosition,
  roleEditBlocker,
  roleLabel,
  suggestPosition,
  updateRole,
} from '../../lib/roles.js';
import { writeAudit } from '../../lib/moderation.js';
import { ConfirmButton, Icon, useToast } from '../layout/ui.jsx';
import './roles.css';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const emptyPerms = () => Object.fromEntries(PERMS.map((p) => [p, false]));

/**
 * Props: sid, me (my member record), roles (map), members (for delete cleanup),
 *        role (record to edit, or null to create), onDone(rid|null), onCancel
 */
export default function RoleEditor({ sid, me, roles, members, role, onDone, onCancel }) {
  const toast = useToast();
  const editing = !!role;
  const [name, setName] = useState(editing ? role.name || '' : '');
  const [color, setColor] = useState(editing ? role.color : ROLE_COLORS[0]);
  const [hex, setHex] = useState(editing ? role.color : ROLE_COLORS[0]);
  const [position, setPosition] = useState(String(editing ? role.position : suggestPosition(me, roles)));
  const [perms, setPerms] = useState(editing ? { ...emptyPerms(), ...role.perms } : emptyPerms());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const staff = isStaff(me);
  const maxPos = maxAssignablePosition(me, roles);
  const pos = Number(position);
  const next = useMemo(() => ({ name, color, position: pos, perms }), [name, color, pos, perms]);
  // Locked = I can't touch the role as it stands (above me / no permission).
  const lockReason =
    roleEditBlocker(me, roles, editing ? role : null, null) ||
    (!editing && maxPos === null ? 'Your role is at the lowest position, so there is no room below it for a new role.' : null);
  const blocker = roleEditBlocker(me, roles, editing ? role : null, next);
  const locked = !!lockReason;
  const nameFailed = editing && role.failed;
  const holders = editing ? (members || []).filter((m) => m.roleId === role.rid).length : 0;

  const dirty =
    !editing ||
    cleanRoleName(name) !== (role.name || '') ||
    color !== role.color ||
    pos !== role.position ||
    PERMS.some((p) => !!perms[p] !== !!role.perms?.[p]);

  const pickHex = (v) => {
    setHex(v);
    const h = v.startsWith('#') ? v : `#${v}`;
    if (isHexColor(h)) setColor(h.toLowerCase());
  };

  const save = async (e) => {
    e.preventDefault();
    if (blocker || locked) return setError(lockReason || blocker);
    setBusy(true);
    setError('');
    try {
      if (editing) {
        const patch = {};
        const clean = cleanRoleName(name);
        if (clean !== (role.name || '')) patch.name = clean;
        if (color !== role.color) patch.color = color;
        if (pos !== role.position) patch.position = pos;
        const changedPerms = PERMS.filter((p) => !!perms[p] !== !!role.perms?.[p]);
        if (changedPerms.length) patch.perms = perms;
        await updateRole(sid, role.rid, patch);
        writeAudit(sid, me, {
          action: 'role.update',
          target: role.rid,
          detail: [
            clean,
            patch.name ? `renamed from ${roleLabel(role)}` : null,
            patch.position !== undefined ? `position ${role.position}→${pos}` : null,
            patch.color ? `color ${color}` : null,
            changedPerms.length ? `perms ${changedPerms.map((p) => `${perms[p] ? '+' : '−'}${p}`).join(' ')}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        });
        toast('Role saved', 'success');
        onDone?.(role.rid);
      } else {
        const clean = cleanRoleName(name);
        const rid = await createRole(sid, { name: clean, color, position: pos, perms });
        writeAudit(sid, me, {
          action: 'role.create',
          target: rid,
          detail: `${clean} · position ${pos}${PERMS.some((p) => perms[p]) ? ` · ${PERMS.filter((p) => perms[p]).join(' ')}` : ''}`,
        });
        toast(`Created ${clean}`, 'success');
        onDone?.(rid);
      }
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await deleteRole(sid, role.rid, members, me, roles);
      writeAudit(sid, me, { action: 'role.delete', target: role.rid, detail: roleLabel(role) });
      toast('Role deleted', 'success');
      onDone?.(null);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <form className="rl-editor" onSubmit={save}>
      <div className="rl-editor-head">
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          <Icon name="back" size={14} /> Roles
        </button>
        <span className="rl-editor-title">
          <span className="rl-dot lg" style={{ '--rl-color': color }} />
          {editing ? (nameFailed ? 'Locked role' : `Edit ${roleLabel(role)}`) : 'New role'}
        </span>
      </div>

      {locked && (
        <div className="rl-callout">
          <Icon name="lock" size={14} /> {lockReason}
        </div>
      )}

      <fieldset className="rl-fieldset" disabled={locked || busy}>
        <label className="field">
          Role name
          <input
            className="input"
            value={name}
            maxLength={MAX_ROLE_NAME}
            onChange={(e) => setName(e.target.value)}
            placeholder={nameFailed ? "Couldn't decrypt — type a new name" : 'Moderators'}
            autoFocus={!editing}
          />
        </label>

        <div className="ly-field">
          Color
          <div className="rl-swatches" role="radiogroup" aria-label="Role color">
            {ROLE_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                className={`rl-swatch ${color === c ? 'on' : ''}`}
                style={{ '--rl-color': c }}
                onClick={() => {
                  setColor(c);
                  setHex(c);
                }}
              />
            ))}
            <input
              className="input rl-hex"
              value={hex}
              maxLength={7}
              onChange={(e) => pickHex(e.target.value.trim())}
              aria-label="Custom hex color"
              spellCheck={false}
            />
          </div>
        </div>

        <label className="field">
          Position
          <input
            className="input rl-pos"
            type="number"
            min={1}
            max={maxPos || 1}
            step={1}
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
          <span className="rl-help">
            Higher positions outrank lower ones (1–{maxPos ?? '—'} for you). Owner is 1000 and admins are 900.
            {!staff && maxPos !== null && ' You can only use positions below your own role.'}
          </span>
        </label>

        <div className="ly-field">
          Permissions
          <div className="rl-perms">
            {PERMS.map((p) => {
              const grantable = canGrantPerm(me, roles, p);
              const off = !grantable && !perms[p];
              return (
                <label
                  key={p}
                  className={`rl-perm ${off || !grantable ? 'disabled' : ''}`}
                  title={grantable ? PERM_HINTS[p] : "You can't grant a permission you don't have"}
                >
                  <input
                    type="checkbox"
                    checked={!!perms[p]}
                    disabled={!grantable}
                    onChange={(e) => setPerms((x) => ({ ...x, [p]: e.target.checked }))}
                  />
                  <span className="rl-perm-text">
                    <strong>{PERM_LABELS[p]}</strong>
                    <span className="muted">{grantable ? PERM_HINTS[p] : "You don't have this permission, so you can't change it."}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </fieldset>

      <p className="muted ly-hint">
        <Icon name="lock" size={12} /> The role name is end-to-end encrypted. Its color, position and permissions are visible to the
        database so the security rules can enforce them.
      </p>
      {(error || (!locked && dirty && blocker)) && <p className="error-text">{error || blocker}</p>}

      <div className="ly-form-actions">
        {editing && !locked && (
          <ConfirmButton className="btn danger" confirmLabel={holders ? `Delete (${holders} members)?` : 'Delete role?'} onConfirm={remove}>
            <Icon name="trash" size={14} /> Delete
          </ConfirmButton>
        )}
        <span className="ly-grow" />
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={busy || locked || !!blocker || !dirty}>
          {busy ? <span className="spinner ly-spinner-sm" /> : editing ? 'Save role' : 'Create role'}
        </button>
      </div>
    </form>
  );
}

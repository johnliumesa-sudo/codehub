// Small shared pieces of the add-on UI. Every string from the database renders as React text.
import { useProfile } from '../../../lib/profiles.js';
import { useAdminBadge } from '../../../lib/admin.js';
import { ADDON_PERMS, PERM_INFO, normalizePerms, runBlock } from '../lib/manifest.js';

export function AddonIcon({ icon, size = 'md' }) {
  return (
    <span className={`ad-glyph ${size}`} aria-hidden="true">
      {icon || '🧩'}
    </span>
  );
}

/** Read-only list of permissions with what they mean. */
export function PermList({ perms, empty = 'No permissions: it only draws in its own panel.' }) {
  const list = normalizePerms(perms);
  if (!list.length) return <p className="ad-perm-none muted">{empty}</p>;
  return (
    <ul className="ad-perms">
      {list.map((p) => (
        <li key={p} className={PERM_INFO[p].risk ? 'risk' : ''}>
          <strong>{PERM_INFO[p].label}</strong>
          <span className="muted">{PERM_INFO[p].detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Checkboxes for granting (a subset of) the requested permissions. */
export function PermPicker({ requested, value, onChange, legend = 'Permissions to grant' }) {
  const req = normalizePerms(requested);
  const val = normalizePerms(value);
  if (!req.length) return <p className="ad-perm-none muted">This add-on asks for no permissions.</p>;
  return (
    <fieldset className="ad-perm-pick">
      <legend>{legend}</legend>
      {req.map((p) => (
        <label key={p} className={`ad-check${PERM_INFO[p].risk ? ' risk' : ''}`}>
          <input
            type="checkbox"
            checked={val.includes(p)}
            onChange={(e) => onChange(normalizePerms(e.target.checked ? [...val, p] : val.filter((x) => x !== p)))}
          />
          <span>
            <strong>{PERM_INFO[p].label}</strong>
            <span className="muted">{PERM_INFO[p].detail}</span>
          </span>
        </label>
      ))}
      <p className="ad-hint muted">Calls that need a permission you leave unticked fail inside the add-on.</p>
    </fieldset>
  );
}

/** Checkbox group for the builder (all permissions). */
export function PermRequestPicker({ value, onChange }) {
  const val = normalizePerms(value);
  return (
    <fieldset className="ad-perm-pick">
      <legend>Permissions requested</legend>
      {ADDON_PERMS.map((p) => (
        <label key={p} className="ad-check">
          <input
            type="checkbox"
            checked={val.includes(p)}
            onChange={(e) => onChange(normalizePerms(e.target.checked ? [...val, p] : val.filter((x) => x !== p)))}
          />
          <span>
            <strong>{PERM_INFO[p].label}</strong> <code className="ad-code-inline">{p}</code>
            <span className="muted">{PERM_INFO[p].detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const BLOCK_LABEL = {
  removed: 'removed from the directory',
  publisher: 'publisher changed',
  runtime: 'needs update for the new add-on runtime',
};

/** Chip for an installed add-on that won't run (see runBlock), or nothing while it may. */
export function BlockChip({ install, manifest, loading = false }) {
  if (loading) return null;
  const reason = runBlock(install, manifest);
  return reason ? <span className="ad-chip warn">{BLOCK_LABEL[reason]}</span> : null;
}

/** Chip for a listing written for the old runtime (it can't be installed until updated). */
export function OldRuntimeChip() {
  return <span className="ad-chip warn">{BLOCK_LABEL.runtime}</span>;
}

export function PermChips({ perms }) {
  const list = normalizePerms(perms);
  if (!list.length) return <span className="ad-chip quiet">no permissions</span>;
  return list.map((p) => (
    <span key={p} className={`ad-chip${PERM_INFO[p].risk ? ' risk' : ''}`}>
      {PERM_INFO[p].label}
    </span>
  ));
}

export function Publisher({ uid }) {
  const p = useProfile(uid);
  const admin = useAdminBadge(uid);
  return (
    <span className="ad-publisher">
      <span style={{ color: p?.color || undefined }}>{p?.name || 'Unknown user'}</span>
      {admin && <span className="ad-chip admin" title="Codehub app admin">app admin</span>}
    </span>
  );
}

export const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');

export const errText = (e) => String(e?.message || e || 'Something went wrong').replace(/^Error:\s*/, '');

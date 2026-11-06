// Server Settings → Audit log. Visible to owner, admins and `viewAudit`. Shows the newest 100
// encrypted moderation entries (decrypted locally with the server key).
import { useMemo, useState } from 'react';
import { useProfiles } from '../../lib/profiles.js';
import { AUDIT_LABELS, MEMBER_ACTIONS, useAuditLog } from '../../lib/moderation.js';
import { Avatar, Icon } from '../layout/ui.jsx';
import './roles.css';

const GROUPS = [
  ['all', 'All actions'],
  ['members', 'Members (kick, ban, timeout)'],
  ['roles', 'Roles'],
  ['invites', 'Invites'],
  ['channels', 'Channels'],
];

const inGroup = (g, action) =>
  g === 'all' ||
  (g === 'members' && MEMBER_ACTIONS.has(action)) ||
  (g === 'roles' && action.startsWith('role.') && action !== 'role.assign') ||
  (g === 'invites' && action.startsWith('invite.')) ||
  (g === 'channels' && action.startsWith('channel.'));

function fmtWhen(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

const ICON = { kick: 'door', ban: 'ban', unban: 'check', 'invite.create': 'link', 'invite.revoke': 'link' };
const iconFor = (a) => ICON[a] || (a?.startsWith('role') ? 'shield' : a?.startsWith('channel') ? 'hash' : a === 'member.role' ? 'crown' : 'dot');

function Target({ e, profiles }) {
  if (e.target == null) return null;
  if (MEMBER_ACTIONS.has(e.action)) return <strong>{profiles[e.target]?.name || 'a former member'}</strong>;
  if (e.action.startsWith('invite.')) return <code className="ly-code">{String(e.target).slice(-8)}</code>;
  if (e.action.startsWith('channel.')) return <strong>{typeof e.detail === 'string' && e.detail ? `#${e.detail.split(' · ')[0]}` : 'a channel'}</strong>;
  if (e.action.startsWith('role.')) return <strong>{typeof e.detail === 'string' && e.detail ? e.detail.split(' · ')[0] : 'a role'}</strong>;
  return <code className="ly-code">{String(e.target).slice(-8)}</code>;
}

function detailText(e) {
  if (e.detail == null) return '';
  const s = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
  // For channel/role entries the first segment is already shown as the target.
  if (e.action.startsWith('channel.') || (e.action.startsWith('role.') && e.action !== 'role.assign')) {
    return s.split(' · ').slice(1).join(' · ');
  }
  return s;
}

/** Props: sid, canView (STAFF || can('viewAudit')) */
export default function AuditLogTab({ sid, canView = true }) {
  const { entries, loading, error } = useAuditLog(sid, { enabled: canView });
  const [group, setGroup] = useState('all');
  const [who, setWho] = useState('');

  const uids = useMemo(() => {
    const s = new Set();
    entries.forEach((e) => {
      s.add(e.by);
      if (e.target && MEMBER_ACTIONS.has(e.action)) s.add(e.target);
    });
    return [...s];
  }, [entries]);
  const profiles = useProfiles(uids);
  const actors = useMemo(() => [...new Set(entries.map((e) => e.by))], [entries]);

  if (!canView) return <p className="muted">You need the “View audit log” permission to see this.</p>;

  const shown = entries.filter((e) => (e.failed || e.pending || inGroup(group, e.action)) && (!who || e.by === who));

  return (
    <div className="ly-form rl-tab">
      <div className="rl-audit-filters">
        <select className="input" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Filter by action">
          {GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="input" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filter by moderator">
          <option value="">Everyone</option>
          {actors.map((u) => <option key={u} value={u}>{profiles[u]?.name || u.slice(0, 8)}</option>)}
        </select>
      </div>

      {loading && <div className="spinner ly-spinner-sm" />}
      {error && <p className="error-text">Couldn't load the audit log — you may not have access.</p>}
      {!loading && !error && shown.length === 0 && (
        <p className="muted">{entries.length ? 'No entries match these filters.' : 'No moderation actions recorded yet.'}</p>
      )}

      <ol className="rl-audit">
        {shown.map((e) => (
          <li key={e.aid} className={`rl-audit-row ${e.failed ? 'failed' : ''}`}>
            <Avatar profile={profiles[e.by]} size={28} ring="var(--bg-2)" />
            <div className="rl-audit-main">
              {e.pending ? (
                <span className="ly-skel-line" />
              ) : e.failed || e.action === 'unknown' ? (
                <span className="muted">
                  <Icon name="lock" size={12} /> <strong>{profiles[e.by]?.name || '…'}</strong> — entry couldn't be decrypted
                </span>
              ) : (
                <>
                  <span className="rl-audit-line">
                    <Icon name={iconFor(e.action)} size={13} className={`rl-audit-icon ${e.action.replace('.', '-')}`} />
                    <strong>{profiles[e.by]?.name || '…'}</strong> {AUDIT_LABELS[e.action] || e.action} <Target e={e} profiles={profiles} />
                  </span>
                  {detailText(e) && <span className="muted rl-audit-detail">{detailText(e)}</span>}
                </>
              )}
            </div>
            <time className="muted rl-audit-time" dateTime={e.ts ? new Date(e.ts).toISOString() : undefined} title={e.ts ? new Date(e.ts).toLocaleString() : ''}>
              {fmtWhen(e.ts)}
            </time>
          </li>
        ))}
      </ol>

      <p className="muted ly-hint">
        <Icon name="lock" size={12} /> Entries are encrypted with the server key; the database only sees who wrote each one and when.
        Logging is best effort — it's written by the moderator's own app after each action, so it can't be guaranteed complete.
        Showing the newest 100 entries.
      </p>
    </div>
  );
}

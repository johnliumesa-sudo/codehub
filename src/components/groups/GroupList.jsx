// "Groups" section for the DM home sidebar. Unread = groups/{gid}/last newer than reads/{me}/grp_{gid}
// and written by someone else.
//
// Props: { me, activeGid, onSelect(group), onCreate(), reads, groups?, loading?, filter? }
//   `groups`/`loading` may be passed in (from useMyGroups in Workspace) to share one subscription;
//   otherwise the list subscribes itself. `filter` narrows by decrypted name (the DM search box).
import { groupScope, isGroupUnread, useMyGroups } from '../../lib/groups.js';
import { isMuted, useNotifPrefs } from '../../lib/notify.js';
import { Icon } from '../layout/ui.jsx';
import GroupAvatar from './GroupAvatar.jsx';
import './groups.css';

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function GroupList({ me, activeGid, onSelect, onCreate, reads = {}, groups: groupsProp, loading: loadingProp, filter = '' }) {
  const own = useMyGroups(groupsProp ? null : me?.uid);
  const groups = groupsProp || own.groups;
  const loading = groupsProp ? !!loadingProp : own.loading;
  const notifPrefs = useNotifPrefs(me?.uid);

  const f = filter.trim().toLowerCase();
  const shown = f ? groups.filter((g) => (g.name || '').toLowerCase().includes(f)) : groups;

  return (
    <section className="ly-section grp-list">
      <div className="ly-section-head">
        <span className="ly-section-title static">Groups</span>
        <button className="ly-section-add" onClick={onCreate} aria-label="New group" title="New group">
          <Icon name="plus" size={15} />
        </button>
      </div>
      {loading && (
        <div className="ly-skel-group">
          {[0, 1].map((i) => (
            <div key={i} className="ly-skel-row"><span className="ly-skel-circle" /><span className="ly-skel-line" /></div>
          ))}
        </div>
      )}
      {!loading &&
        shown.map((g) => {
          const active = g.gid === activeGid;
          const unread = !active && isGroupUnread(g, reads, me?.uid) && !isMuted(notifPrefs, groupScope(g.gid));
          const owner = g.ownerId && g.ownerId === me?.uid;
          return (
            <div key={g.gid} className={`ly-dm grp-row ${active ? 'active' : ''} ${unread ? 'unread' : ''}`}>
              <button className="ly-dm-main" onClick={() => onSelect(g)} disabled={g.status !== 'ready'} aria-current={active ? 'page' : undefined}>
                <GroupAvatar gid={g.gid} name={g.name} failed={g.nameFailed} size={32} />
                <span className="ly-dm-text">
                  <span className="ly-dm-name">
                    {g.status !== 'ready' ? '…' : g.nameFailed ? 'Encrypted group' : g.name || '…'}
                    {owner && <Icon name="crown" size={12} className="grp-owner-icon" title="You own this group" />}
                  </span>
                  <span className="ly-dm-status">
                    {g.nameFailed ? "Can't decrypt — open to request a new key" : owner && g.needsRotate ? 'Rotating key…' : 'Group · encrypted'}
                  </span>
                </span>
                <span className="ly-dm-meta">
                  {unread ? <span className="ly-unread-dot" /> : <span className="ly-dm-time">{relTime(g.last?.ts || g.createdAt)}</span>}
                </span>
              </button>
            </div>
          );
        })}
      {!loading && groups.length === 0 && (
        <p className="ly-section-empty grp-empty">
          No groups yet. <button className="grp-link" onClick={onCreate}>Start one</button>
        </p>
      )}
      {!loading && groups.length > 0 && shown.length === 0 && <p className="ly-section-empty">No matching groups</p>}
    </section>
  );
}

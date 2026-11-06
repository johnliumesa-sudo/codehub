import { useMemo, useState } from 'react';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import { dmScope } from '../../lib/servers.js';
import { Avatar, Icon } from './ui.jsx';
import GroupList from '../groups/GroupList.jsx';
import { isMuted, useNotifPrefs } from '../../lib/notify.js';

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function DmSidebar({ dms, loading, error, activeDmId, reads, myUid, onSelect, onNewDm, onHide, onFriends, friendRequests = 0, groups, groupsLoading, activeGid, onSelectGroup, onNewGroup }) {
  const [filter, setFilter] = useState('');
  const notifPrefs = useNotifPrefs(myUid);
  const peers = useMemo(() => dms.map((d) => d.peer), [dms]);
  const profiles = useProfiles(peers);
  const presence = usePresences(peers);

  const f = filter.trim().toLowerCase();
  const shown = f ? dms.filter((d) => (profiles[d.peer]?.name || '').toLowerCase().includes(f)) : dms;

  return (
    <div className="ly-sidebar-inner">
      <header className="ly-side-head">
        <div className="ly-search-box">
          <Icon name="search" size={15} />
          <input
            className="ly-search-input"
            placeholder="Find a conversation"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter conversations"
          />
        </div>
      </header>
      <div className="ly-side-scroll">
        <button className={`ly-friends-link ${activeDmId || activeGid ? '' : 'active'}`} onClick={onFriends}>
          <Icon name="users" size={18} /> Friends
          {friendRequests > 0 && <span className="fr-badge" title="Pending friend requests">{friendRequests}</span>}
        </button>
        <GroupList
          me={{ uid: myUid }}
          activeGid={activeGid}
          onSelect={onSelectGroup}
          onCreate={onNewGroup}
          reads={reads}
          groups={groups}
          loading={groupsLoading}
          filter={filter}
        />
        <section className="ly-section">
          <div className="ly-section-head">
            <span className="ly-section-title static">Direct messages</span>
            <button className="ly-section-add" onClick={onNewDm} aria-label="New direct message" title="New direct message">
              <Icon name="plus" size={15} />
            </button>
          </div>
          {error && <div className="ly-callout danger">Couldn't load conversations.</div>}
          {loading && (
            <div className="ly-skel-group">
              {[0, 1, 2].map((i) => (
                <div key={i} className="ly-skel-row"><span className="ly-skel-circle" /><span className="ly-skel-line" /></div>
              ))}
            </div>
          )}
          {!loading &&
            shown.map((d) => {
              const p = profiles[d.peer];
              const active = d.dmId === activeDmId;
              const unread = !active && d.lastTs > (reads[dmScope(d.dmId)] || 0) && !isMuted(notifPrefs, dmScope(d.dmId));
              return (
                <div key={d.dmId} className={`ly-dm ${active ? 'active' : ''} ${unread ? 'unread' : ''}`}>
                  <button className="ly-dm-main" onClick={() => onSelect(d)}>
                    <Avatar profile={p} size={32} presence={presence[d.peer] || 'offline'} />
                    <span className="ly-dm-text">
                      <span className="ly-dm-name">{p?.name || '…'}</span>
                      {p?.status && <span className="ly-dm-status">{p.status}</span>}
                    </span>
                    <span className="ly-dm-meta">
                      {unread ? <span className="ly-unread-dot" /> : <span className="ly-dm-time">{relTime(d.lastTs)}</span>}
                    </span>
                  </button>
                  <button className="ly-dm-close" onClick={() => onHide(d)} aria-label="Close conversation" title="Close conversation">
                    <Icon name="x" size={14} />
                  </button>
                </div>
              );
            })}
          {!loading && dms.length === 0 && (
            <div className="ly-side-empty">
              <p>No conversations yet.</p>
              <button className="btn primary sm" onClick={onNewDm}>
                <Icon name="message" size={14} /> Start a DM
              </button>
            </div>
          )}
          {!loading && dms.length > 0 && shown.length === 0 && <p className="ly-section-empty">No matches</p>}
        </section>
      </div>
    </div>
  );
}

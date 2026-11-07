// Right panel for a group conversation: members split by presence, owner marked, quick DM button.
// Props: { gid, me, onMessage?(uid), onManage?() }
import { useMemo } from 'react';
import { MAX_GROUP_MEMBERS, useGroup, useGroupMembers } from '../../lib/groups.js';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import { Avatar, Icon } from '../layout/ui.jsx';
import './groups.css';
import { NoteMark } from '../../features/personal/components/UserNote.jsx';
import { CustomStatusText } from '../../features/personal/components/StatusBits.jsx';

export default function GroupMembersPanel({ gid, me, onMessage, onManage }) {
  const group = useGroup(gid);
  const { members, loading } = useGroupMembers(gid);
  const uids = useMemo(() => members.map((m) => m.uid), [members]);
  const profiles = useProfiles(uids);
  const presence = usePresences(uids);
  const owner = group.status === 'ready' && group.ownerId === me?.uid;

  const sections = useMemo(() => {
    const sorted = [...members].sort(
      (a, b) =>
        (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) ||
        (profiles[a.uid]?.name || '').localeCompare(profiles[b.uid]?.name || '', undefined, { sensitivity: 'base' }),
    );
    const isOn = (m) => (presence[m.uid] || 'offline') !== 'offline';
    return [
      { key: 'online', title: 'Online', list: sorted.filter(isOn) },
      { key: 'offline', title: 'Offline', list: sorted.filter((m) => !isOn(m)) },
    ];
  }, [members, profiles, presence]);

  return (
    <aside className="ly-members-inner grp-members" aria-label="Group members">
      <div className="ly-side-scroll">
        <div className="grp-members-top">
          <span className="muted">{members.length}/{MAX_GROUP_MEMBERS} members</span>
          {onManage && (
            <button className="btn ghost sm" onClick={onManage}>
              <Icon name={owner ? 'userPlus' : 'gear'} size={14} /> {owner ? 'Manage' : 'Settings'}
            </button>
          )}
        </div>
        {loading && (
          <div className="ly-skel-group">
            {[0, 1, 2].map((i) => (
              <div key={i} className="ly-skel-row"><span className="ly-skel-circle" /><span className="ly-skel-line" /></div>
            ))}
          </div>
        )}
        {!loading &&
          sections.map(
            (s) =>
              s.list.length > 0 && (
                <section key={s.key} className="ly-section">
                  <div className="ly-section-head">
                    <span className="ly-section-title static">{s.title} — {s.list.length}</span>
                  </div>
                  {s.list.map((m) => {
                    const p = profiles[m.uid];
                    const pr = presence[m.uid] || 'offline';
                    const isMe = m.uid === me?.uid;
                    return (
                      <div key={m.uid} className={`grp-member ${pr}`}>
                        <Avatar profile={p} size={32} presence={pr} />
                        <span className="ly-dm-text">
                          <span className="ly-member-name">
                            {p?.name || '…'}
                            {m.role === 'owner' && <Icon name="crown" size={13} className="grp-owner-icon" title="Owner" />}
                            {!isMe && <NoteMark uid={m.uid} />}
                          </span>
                          {isMe ? <span className="ly-dm-status">You</span> : <CustomStatusText uid={m.uid} fallback={p?.status} />}
                        </span>
                        {!isMe && onMessage && (
                          <button className="grp-member-dm" onClick={() => onMessage(m.uid)} title={`Message ${p?.name || ''}`} aria-label={`Message ${p?.name || ''}`}>
                            <Icon name="message" size={15} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </section>
              ),
          )}
        {!loading && members.length === 0 && <p className="ly-section-empty">No members</p>}
      </div>
    </aside>
  );
}

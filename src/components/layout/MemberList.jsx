import { useEffect, useMemo, useRef, useState } from 'react';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import { Avatar, Icon, PRESENCE_LABEL } from './ui.jsx';
import { groupMembersByRole } from '../../lib/roles.js';
import RoleBadge, { TimeoutMark } from '../roles/RoleBadge.jsx';
import MemberRoleControls from '../roles/MemberRoleControls.jsx';
import { CosmeticBadge, CosmeticName, useNameColor } from '../shop/Cosmetics.jsx';
import AdminBadge from '../admin/AdminBadge.jsx';
import ReportButton from '../admin/ReportButton.jsx';
import BlockButton from '../safety/BlockButton.jsx';

const ROLE_ICON = { owner: 'crown', admin: 'shield' };

function ProfileCard({ uid, profile, role, presence, pos, isMe, onMessage, onClose, member, sid, meMember, roles, timeoutUntil, myUid }) {
  const ref = useRef(null);
  const nameColor = useNameColor(uid);
  useEffect(() => {
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const onKey = (e) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const top = Math.max(12, Math.min(pos.top, window.innerHeight - 260));
  const style = window.innerWidth < 560 ? { left: 12, right: 12, top } : { top, left: Math.max(12, pos.left - 300) };
  return (
    <div ref={ref} className="ly-profile-card" style={style} role="dialog" aria-label={profile?.name}>
      <div className="ly-profile-banner" style={{ background: profile?.color || 'var(--accent)' }} />
      <div className="ly-profile-body">
        <Avatar profile={profile} size={64} presence={presence} ring="var(--bg-2)" />
        <div className="ly-profile-name">
          <span style={nameColor ? { color: nameColor } : undefined}>{profile?.name || '…'}</span>
          <CosmeticBadge uid={uid} size="md" />
          {ROLE_ICON[role] && <span className={`ly-role-tag ${role}`}><Icon name={ROLE_ICON[role]} size={12} /> {role}</span>}
          {member?.role === 'member' && <RoleBadge member={member} roles={roles} small />}
          <AdminBadge uid={uid} size={14} />
          <TimeoutMark until={timeoutUntil} />
        </div>
        <div className="muted ly-profile-presence">{PRESENCE_LABEL[presence]}</div>
        {profile?.status && <div className="ly-profile-status">{profile.status}</div>}
        {!isMe && (
          <>
            <button className="btn primary" onClick={() => onMessage(uid)}>
              <Icon name="message" size={15} /> Message
            </button>
            <ReportButton kind="user" target={uid} small label="Report user" />
            <BlockButton me={myUid} uid={uid} name={profile?.name} onDone={onClose} />
          </>
        )}
        {!isMe && sid && meMember && member && (
          <MemberRoleControls
            sid={sid}
            me={meMember}
            member={member}
            roles={roles}
            timeoutUntil={timeoutUntil}
            name={profile?.name}
            showKickBan={false}
            layout="stack"
          />
        )}
        {isMe && <div className="muted ly-profile-presence">This is you</div>}
        <code className="ly-profile-uid" title="User id">{uid}</code>
      </div>
    </div>
  );
}

export default function MemberList({ members, loading, myUid, onMessage, sid, meMember, roles = {}, timeouts = {} }) {
  const uids = useMemo(() => members.map((m) => m.uid), [members]);
  const profiles = useProfiles(uids);
  const presence = usePresences(uids);
  const [card, setCard] = useState(null);

  // Sections by rank: Owner, Admins, custom roles (by position, in role color), Members.
  // Presence still shows through the row class (offline rows are dimmed).
  const groups = useMemo(
    () =>
      groupMembersByRole(members, roles, (u) => profiles[u]?.name).map((g) => ({
        key: g.key,
        title: g.title,
        color: g.color,
        list: g.members,
      })),
    [members, roles, profiles],
  );

  return (
    <aside className="ly-members-inner" aria-label="Members">
      <div className="ly-side-scroll">
        {loading && (
          <div className="ly-skel-group">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="ly-skel-row"><span className="ly-skel-circle" /><span className="ly-skel-line" /></div>
            ))}
          </div>
        )}
        {!loading &&
          groups.map(
            (g) =>
              g.list.length > 0 && (
                <section key={g.key} className="ly-section">
                  <div className="ly-section-head">
                    <span className="ly-section-title static" style={g.color ? { color: g.color } : undefined}>{g.title} — {g.list.length}</span>
                  </div>
                  {g.list.map((m) => {
                    const p = profiles[m.uid];
                    const pr = presence[m.uid] || 'offline';
                    return (
                      <button
                        key={m.uid}
                        className={`ly-member ${pr}`}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setCard({ uid: m.uid, role: m.role, member: m, pos: { top: r.top, left: r.left } });
                        }}
                      >
                        <Avatar profile={p} size={32} presence={pr} />
                        <span className="ly-dm-text">
                          <span className="ly-member-name">
                            <CosmeticName uid={m.uid} fallbackColor={roles[m.roleId]?.color || (m.role !== 'member' ? p?.color : undefined)}>
                              {p?.name || '…'}
                            </CosmeticName>
                            {ROLE_ICON[m.role] && <Icon name={ROLE_ICON[m.role]} size={13} className={`ly-role-icon ${m.role}`} title={m.role} />}
                            <AdminBadge uid={m.uid} />
                            <TimeoutMark until={timeouts[m.uid]} />
                          </span>
                          {p?.status && <span className="ly-dm-status">{p.status}</span>}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ),
          )}
        {!loading && members.length === 0 && <p className="ly-section-empty">No members</p>}
      </div>
      {card && (
        <ProfileCard
          uid={card.uid}
          role={card.role}
          member={card.member}
          sid={sid}
          meMember={meMember}
          roles={roles}
          timeoutUntil={timeouts[card.uid] || 0}
          myUid={myUid}
          pos={card.pos}
          profile={profiles[card.uid]}
          presence={presence[card.uid] || 'offline'}
          isMe={card.uid === myUid}
          onClose={() => setCard(null)}
          onMessage={(uid) => {
            setCard(null);
            onMessage(uid);
          }}
        />
      )}
    </aside>
  );
}

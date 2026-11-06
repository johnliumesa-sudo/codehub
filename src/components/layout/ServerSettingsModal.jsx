import { useEffect, useMemo, useState } from 'react';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import {
  MAX_SERVER_NAME,
  createInvite,
  deleteServer,
  inviteLink,
  inviteState,
  leaveServer,
  revokeInvite,
  setMemberRole,
  unbanMember,
  updateServer,
} from '../../lib/servers.js';
import { sendServerInvite, useFriends } from '../../lib/friends.js';
import { can, outranks } from '../../lib/roles.js';
import { writeAudit } from '../../lib/moderation.js';
import RolesTab from '../roles/RolesTab.jsx';
import AuditLogTab from '../roles/AuditLogTab.jsx';
import MemberRoleControls from '../roles/MemberRoleControls.jsx';
import RoleBadge, { TimeoutMark } from '../roles/RoleBadge.jsx';
import { useDbValue } from './hooks.js';
import { ColorPicker } from './modals.jsx';
import { Avatar, ConfirmButton, Icon, Modal, copyText, useToast } from './ui.jsx';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const EXPIRY = [
  ['30 minutes', 30 * 60e3],
  ['1 hour', 60 * 60e3],
  ['1 day', 24 * 60 * 60e3],
  ['7 days', 7 * 24 * 60 * 60e3],
  ['Never', 0],
];
const USES = [['No limit', 0], ['1 use', 1], ['5 uses', 5], ['10 uses', 10], ['25 uses', 25], ['100 uses', 100]];

function fmtExpiry(ts) {
  if (!ts) return 'Never expires';
  const d = ts - Date.now();
  if (d <= 0) return 'Expired';
  if (d < 3_600_000) return `Expires in ${Math.ceil(d / 60_000)}m`;
  if (d < 86_400_000) return `Expires in ${Math.ceil(d / 3_600_000)}h`;
  return `Expires in ${Math.ceil(d / 86_400_000)}d`;
}

// ---------- Overview ----------

function Overview({ sid, meta, myRole, me, onLeft, onDeleted }) {
  const [name, setName] = useState(meta.name || '');
  const [color, setColor] = useState(meta.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const toast = useToast();
  const admin = myRole === 'owner' || myRole === 'admin'; // rename stays owner/admin (meta rule)
  const dirty = (name.trim() && name.trim() !== meta.name) || color !== meta.color;

  useEffect(() => {
    if (meta.name && !name) setName(meta.name);
  }, [meta.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await updateServer(sid, { name: name.trim() !== meta.name ? name : undefined, color: color !== meta.color ? color : undefined });
      toast('Server updated', 'success');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ly-form">
      {admin ? (
        <form onSubmit={save} className="ly-form">
          <label className="field">
            Server name
            <input className="input" value={name} maxLength={MAX_SERVER_NAME} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="ly-field">
            Color
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {error && <p className="error-text">{error}</p>}
          <div className="ly-form-actions">
            <span className="ly-grow muted ly-hint"><Icon name="lock" size={12} /> The name is encrypted; only members can read it.</span>
            <button className="btn primary" disabled={busy || !dirty}>{busy ? <span className="spinner ly-spinner-sm" /> : 'Save changes'}</button>
          </div>
        </form>
      ) : (
        <p className="muted">Only owners and admins can change server settings.</p>
      )}

      <div className="ly-danger-zone">
        <h3>Danger zone</h3>
        {myRole !== 'owner' ? (
          <div className="ly-danger-row">
            <div>
              <strong>Leave server</strong>
              <p className="muted">You'll need a new invite to come back.</p>
            </div>
            <ConfirmButton
              confirmLabel="Leave now?"
              onConfirm={async () => {
                try {
                  await leaveServer(sid, me.uid);
                  onLeft();
                } catch (err) {
                  toast(errMsg(err), 'error');
                }
              }}
            >
              <Icon name="door" size={14} /> Leave
            </ConfirmButton>
          </div>
        ) : (
          <div className="ly-danger-row column">
            <div>
              <strong>Delete server</strong>
              <p className="muted">Permanently deletes all channels, messages and code workspaces for everyone. Type the server name to confirm.</p>
            </div>
            <div className="ly-inline">
              <input className="input" placeholder={meta.name || ''} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
              <ConfirmButton
                disabled={!meta.name || confirmName.trim() !== meta.name}
                confirmLabel="Delete forever?"
                onConfirm={async () => {
                  try {
                    await deleteServer(sid, me.uid);
                    onDeleted();
                  } catch (err) {
                    toast(errMsg(err), 'error');
                  }
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </ConfirmButton>
            </div>
            <p className="muted ly-hint">Ownership transfer isn't available yet — if you want to step away, promote an admin first.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Invites ----------

// Friends and DM contacts who aren't members yet; each gets a single-use invite in an encrypted DM.
function InviteByDm({ sid, me, serverName, memberUids }) {
  const toast = useToast();
  const friends = useFriends(me.uid);
  const { value: dmsVal } = useDbValue(`userDms/${me.uid}`);
  const [sent, setSent] = useState({}); // uid -> 'busy' | 'sent'
  const uids = useMemo(() => {
    const set = new Set(friends.list.filter((f) => f.state === 'friends').map((f) => f.uid));
    Object.values(dmsVal || {}).forEach((d) => d?.peer && set.add(d.peer));
    memberUids.forEach((u) => set.delete(u));
    set.delete(me.uid);
    return [...set];
  }, [friends.list, dmsVal, memberUids, me.uid]);
  const profiles = useProfiles(uids);
  const presence = usePresences(uids);
  const sorted = [...uids].sort((a, b) => (profiles[a]?.name || '').localeCompare(profiles[b]?.name || ''));

  const send = async (uid) => {
    setSent((s) => ({ ...s, [uid]: 'busy' }));
    try {
      await sendServerInvite(me, uid, sid, serverName);
      setSent((s) => ({ ...s, [uid]: 'sent' }));
      toast(`Invite sent to ${profiles[uid]?.name || 'them'}`, 'success');
    } catch (e) {
      setSent((s) => ({ ...s, [uid]: undefined }));
      toast(errMsg(e), 'error');
    }
  };

  return (
    <>
      <div className="ly-list-head">Invite friends by DM</div>
      {sorted.length === 0 ? (
        <p className="muted">Friends and people you've messaged show up here. Add friends from the Friends page on the home screen.</p>
      ) : (
        <div className="ly-invite-friends">
          {sorted.map((uid) => (
            <div key={uid} className="ly-person">
              <Avatar profile={profiles[uid]} size={32} presence={presence[uid] || 'offline'} ring="var(--bg-2)" />
              <span className="ly-dm-text"><span className="ly-dm-name">{profiles[uid]?.name || '…'}</span></span>
              <button className="btn sm" disabled={!!sent[uid]} onClick={() => send(uid)}>
                {sent[uid] === 'busy' ? <span className="spinner ly-spinner-sm" /> : sent[uid] === 'sent' ? <><Icon name="check" size={13} /> Sent</> : <><Icon name="send" size={13} /> Invite</>}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Invites({ sid, me, serverName, memberUids, autoCreate, onAutoCreated }) {
  const { loading, value, error } = useDbValue(`servers/${sid}/invites`);
  const [expires, setExpires] = useState(EXPIRY[2][1]);
  const [maxUses, setMaxUses] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(null); // { iid, link }
  const [err, setErr] = useState('');
  const toast = useToast();
  const invites = useMemo(
    () => Object.entries(value || {}).map(([iid, v]) => ({ iid, ...v })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [value],
  );
  const creators = useProfiles(invites.map((i) => i.createdBy).filter(Boolean));

  const make = async () => {
    setBusy(true);
    setErr('');
    try {
      const iid = await createInvite(sid, me.uid, { expiresInMs: expires, maxUses });
      writeAudit(sid, me, {
        action: 'invite.create',
        target: iid,
        detail: [expires ? EXPIRY.find((x) => x[1] === expires)?.[0] : 'never expires', maxUses ? `${maxUses} uses` : 'no limit'].join(' · '),
      });
      const link = await inviteLink(sid, iid);
      setFresh({ iid, link });
      if (await copyText(link)) toast('Invite link copied', 'success');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!autoCreate) return;
    onAutoCreated();
    make();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async (iid) => {
    try {
      const link = await inviteLink(sid, iid);
      toast((await copyText(link)) ? 'Invite link copied' : 'Copy failed — select the link manually', 'success');
      setFresh({ iid, link });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="ly-form">
      <InviteByDm sid={sid} me={me} serverName={serverName} memberUids={memberUids} />
      <div className="ly-list-head">Invite link</div>
      <div className="ly-invite-make">
        <label className="field">
          Expire after
          <select className="input" value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            {EXPIRY.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field">
          Max uses
          <select className="input" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {USES.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
          </select>
        </label>
        <button className="btn primary" onClick={make} disabled={busy}>
          {busy ? <span className="spinner ly-spinner-sm" /> : <><Icon name="link" size={15} /> New invite</>}
        </button>
      </div>
      {err && <p className="error-text">{err}</p>}
      {fresh && (
        <div className="ly-fresh-link">
          <input className="input mono" readOnly value={fresh.link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
          <button className="btn" onClick={async () => toast((await copyText(fresh.link)) ? 'Copied' : 'Copy failed', 'success')}>
            <Icon name="copy" size={15} /> Copy
          </button>
        </div>
      )}
      <p className="muted ly-hint">
        <Icon name="key" size={12} /> Invite links contain the server's decryption key. Anyone with a valid link can join and read history. Revoking stops new joins, not existing members.
      </p>

      <div className="ly-list-head">Active invites</div>
      {loading && <div className="spinner ly-spinner-sm" />}
      {error && <p className="error-text">Couldn't load invites.</p>}
      {!loading && invites.length === 0 && <p className="muted">No invites yet.</p>}
      <div className="ly-rows">
        {invites.map((inv) => {
          const st = inviteState(inv);
          return (
            <div key={inv.iid} className={`ly-row ${st !== 'active' ? 'dim' : ''}`}>
              <div className="ly-row-main">
                <code className="ly-code">{inv.iid.slice(-8)}</code>
                <span className="muted">
                  by {creators[inv.createdBy]?.name || '…'} · {inv.uses || 0}
                  {inv.maxUses ? `/${inv.maxUses}` : ''} uses · {st === 'active' ? fmtExpiry(inv.expiresAt) : st}
                </span>
              </div>
              <div className="ly-row-actions">
                {st === 'active' && (
                  <button className="btn sm" onClick={() => copy(inv.iid)}>
                    <Icon name="copy" size={13} /> Copy link
                  </button>
                )}
                <ConfirmButton
                  confirmLabel="Revoke?"
                  onConfirm={() =>
                    revokeInvite(sid, inv.iid).then(
                      () => writeAudit(sid, me, { action: 'invite.revoke', target: inv.iid }),
                      (e) => toast(errMsg(e), 'error'),
                    )
                  }
                >
                  Revoke
                </ConfirmButton>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Members ----------

function Members({ sid, members, myRole, me, meMember, roles = {}, timeouts = {}, onMessage }) {
  const [filter, setFilter] = useState('');
  const profiles = useProfiles(members.map((m) => m.uid));
  const presence = usePresences(members.map((m) => m.uid));
  const toast = useToast();
  const f = filter.trim().toLowerCase();
  const rk = (m) => (m.role === 'owner' ? 1000 : m.role === 'admin' ? 900 : roles[m.roleId]?.position || 0);
  const list = members
    .filter((m) => !f || (profiles[m.uid]?.name || '').toLowerCase().includes(f))
    .sort((a, b) => rk(b) - rk(a) || (profiles[a.uid]?.name || '').localeCompare(profiles[b.uid]?.name || ''));

  const act = (fn, ok) => async () => {
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="ly-form">
      <div className="ly-search-box">
        <Icon name="search" size={15} />
        <input className="ly-search-input" placeholder={`Search ${members.length} members`} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="ly-rows">
        {list.map((m) => {
          const p = profiles[m.uid];
          const isMe = m.uid === me.uid;
          const mod = !isMe && outranks(meMember || { uid: me.uid, role: myRole }, m, roles);
          return (
            <div key={m.uid} className="ly-row">
              <div className="ly-row-main person">
                <Avatar profile={p} size={34} presence={presence[m.uid] || 'offline'} ring="var(--bg-2)" />
                <span className="ly-dm-text">
                  <span className="ly-dm-name">
                    {p?.name || '…'} {isMe && <span className="muted">(you)</span>}
                  </span>
                  <span className={`ly-role-tag ${m.role}`}>{m.role}</span>
                  {m.role === 'member' && <RoleBadge member={m} roles={roles} small />} <TimeoutMark until={timeouts[m.uid]} />
                </span>
              </div>
              <div className="ly-row-actions">
                {!isMe && (
                  <button className="btn ghost sm ly-icon-btn" title="Message" aria-label="Message" onClick={() => onMessage(m.uid)}>
                    <Icon name="message" size={15} />
                  </button>
                )}
                {myRole === 'owner' && !isMe && m.role !== 'owner' && (
                  <select
                    className="input ly-role-select"
                    value={m.role}
                    onChange={(e) => {
                      const v = e.target.value;
                      act(() => setMemberRole(sid, m.uid, v).then(() => writeAudit(sid, me, { action: 'member.role', target: m.uid, detail: v })), 'Role updated')();
                    }}
                    aria-label="Role"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
                {mod && (
                  <MemberRoleControls
                    sid={sid}
                    me={meMember || { uid: me.uid, role: myRole }}
                    member={m}
                    roles={roles}
                    timeoutUntil={timeouts[m.uid] || 0}
                    name={p?.name}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted ly-hint">
        Removing someone revokes their access to new data, but they may have kept the server key from before. Key rotation on kick is not supported yet.
      </p>
    </div>
  );
}

function Bans({ sid, me, canUnban }) {
  const { loading, value, error } = useDbValue(`servers/${sid}/bans`);
  const uids = Object.keys(value || {});
  const profiles = useProfiles(uids);
  const toast = useToast();
  return (
    <div className="ly-form">
      {loading && <div className="spinner ly-spinner-sm" />}
      {error && <p className="error-text">Couldn't load bans.</p>}
      {!loading && uids.length === 0 && <p className="muted">Nobody is banned. Nice.</p>}
      <div className="ly-rows">
        {uids.map((uid) => (
          <div key={uid} className="ly-row">
            <div className="ly-row-main person">
              <Avatar profile={profiles[uid]} size={32} ring="var(--bg-2)" />
              <span className="ly-dm-name">{profiles[uid]?.name || uid}</span>
            </div>
            {canUnban ? (
              <ConfirmButton className="btn sm" confirmLabel="Unban?" onConfirm={() =>
                  unbanMember(sid, uid).then(
                    () => {
                      writeAudit(sid, me, { action: 'unban', target: uid });
                      toast('Unbanned', 'success');
                    },
                    (e) => toast(errMsg(e), 'error'),
                  )
                }>
                Unban
              </ConfirmButton>
            ) : (
              <span className="muted small" title="Only members with the Ban permission can lift bans">Ban permission needed</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Shell ----------

export default function ServerSettingsModal({
  sid,
  meta,
  myRole,
  me,
  members,
  meMember,
  roles = {},
  timeouts = {},
  perms = {},
  initialTab = 'overview',
  onClose,
  onLeft,
  onMessage,
}) {
  const staff = myRole === 'owner' || myRole === 'admin';
  const meM = meMember || { uid: me.uid, role: myRole };
  const tabs = [
    ['overview', 'Overview', 'gear'],
    (staff || perms.manageInvites) && ['invites', 'Invites', 'link'],
    ['members', `Members (${members.length})`, 'users'],
    (staff || perms.manageRoles) && ['roles', 'Roles', 'shield'],
    (staff || perms.ban) && ['bans', 'Bans', 'ban'],
    (staff || perms.viewAudit) && ['audit', 'Audit log', 'key'],
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs.some((t) => t[0] === initialTab) ? initialTab : 'overview');
  const [autoInvite, setAutoInvite] = useState(initialTab === 'invites');
  // Perms can change live (role removed): never keep rendering a tab that is no longer offered.
  const shown = tabs.some((t) => t[0] === tab) ? tab : 'overview';

  return (
    <Modal title={meta.name ? `${meta.name}` : 'Server settings'} onClose={onClose} wide className="ly-settings">
      <div className="ly-tabs-line" role="tablist">
        {tabs.map(([k, label, icon]) => (
          <button key={k} role="tab" aria-selected={shown === k} className={`ly-tabline ${shown === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            <Icon name={icon} size={14} /> {label}
          </button>
        ))}
      </div>
      <div className="ly-settings-body">
        {shown === 'overview' && <Overview sid={sid} meta={meta} myRole={myRole} me={me} onLeft={onLeft} onDeleted={onLeft} />}
        {shown === 'invites' && <Invites sid={sid} me={me} serverName={meta.name} memberUids={members.map((m) => m.uid)} autoCreate={autoInvite} onAutoCreated={() => setAutoInvite(false)} />}
        {shown === 'members' && (
          <Members sid={sid} members={members} myRole={myRole} me={me} meMember={meM} roles={roles} timeouts={timeouts} onMessage={onMessage} />
        )}
        {shown === 'roles' && <RolesTab sid={sid} me={meM} members={members} roles={roles} />}
        {shown === 'bans' && <Bans sid={sid} me={me} canUnban={can(meM, roles, 'ban')} />}
        {shown === 'audit' && <AuditLogTab sid={sid} canView={staff || can(meM, roles, 'viewAudit')} />}
      </div>
    </Modal>
  );
}

// Group settings: Overview (rename, key status, leave / delete) and Members (add, remove).
// Props: { me, gid, initialTab = 'overview', onClose, onLeft(), onDeleted(), onMessage?(uid) }
import { useEffect, useMemo, useState } from 'react';
import {
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME,
  addMembers,
  deleteGroup,
  getGroupKey,
  leaveGroup,
  removeMember,
  renameGroup,
  requestRekey,
  rotateGroupKey,
  useGroup,
  useGroupMembers,
} from '../../lib/groups.js';
import { usePresences } from '../../lib/presence.js';
import { useProfiles } from '../../lib/profiles.js';
import UserPicker from '../common/UserPicker.jsx';
import { Avatar, ConfirmButton, Icon, Modal, useToast } from '../layout/ui.jsx';
import { MemberChips } from './CreateGroupModal.jsx';
import GroupAvatar from './GroupAvatar.jsx';
import './groups.css';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

/** 'checking' | 'ok' | 'missing' for my copy of the current epoch key. */
function useKeyStatus(gid, epoch) {
  const [st, setSt] = useState({ tag: null, status: 'checking' });
  const tag = `${gid}:${epoch}`;
  useEffect(() => {
    if (!gid || !epoch) return undefined;
    let alive = true;
    getGroupKey(gid, epoch).then(
      () => alive && setSt({ tag, status: 'ok' }),
      () => alive && setSt({ tag, status: 'missing' }),
    );
    return () => {
      alive = false;
    };
  }, [tag]); // eslint-disable-line react-hooks/exhaustive-deps
  return st.tag === tag ? st.status : 'checking';
}

// ---------- Overview ----------

function Overview({ me, group, memberCount, onLeft, onDeleted }) {
  const owner = group.ownerId === me.uid;
  const [name, setName] = useState(group.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const keyStatus = useKeyStatus(group.gid, group.epoch);
  const dirty = !!name.trim() && name.trim() !== group.name;

  useEffect(() => {
    if (group.name && !name) setName(group.name);
  }, [group.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await renameGroup(group.gid, name);
      toast('Group renamed', 'success');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn, okText) => {
    setError('');
    try {
      await fn();
      if (okText) toast(okText, 'success');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="ly-form">
      {owner ? (
        <form onSubmit={save} className="ly-form">
          <label className="field">
            Group name
            <input className="input" value={name} maxLength={MAX_GROUP_NAME} onChange={(e) => setName(e.target.value)} required />
          </label>
          <div className="ly-form-actions">
            <button className="btn primary" disabled={busy || !dirty}>
              {busy ? <span className="spinner ly-spinner-sm" /> : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <div className="grp-preview">
          <GroupAvatar gid={group.gid} name={group.name} failed={group.nameFailed} size={40} />
          <span className="grp-preview-name">{group.name || (group.nameFailed ? 'Encrypted group' : '…')}</span>
          <span className="grp-count">{memberCount}/{MAX_GROUP_MEMBERS}</span>
        </div>
      )}

      <div className="grp-keybox">
        <div className="grp-keybox-head">
          <Icon name="key" size={16} />
          <strong>Encryption</strong>
          <span className="badge-e2e">E2E</span>
        </div>
        <p className="muted grp-hint">
          Messages and the group name are encrypted with a group key that only members hold. The key changes
          (epoch {group.epoch}) whenever someone leaves or is removed, so former members can't read anything new.
          Membership and timestamps are visible to the server.
        </p>
        {keyStatus === 'missing' && (
          <div className="grp-callout warn">
            <span>Your copy of the current key is missing or can't be opened (for example after resetting your keys).</span>
            {owner ? (
              <button type="button" className="btn sm" onClick={() => run(() => rotateGroupKey(group.gid), 'New key created for everyone')}>
                Rotate key
              </button>
            ) : (
              <button type="button" className="btn sm" onClick={() => run(() => requestRekey(group.gid), 'Asked the owner for a new key')} disabled={group.needsRotate}>
                {group.needsRotate ? 'Requested' : 'Request new key'}
              </button>
            )}
          </div>
        )}
        {owner && group.needsRotate && keyStatus !== 'missing' && (
          <div className="grp-callout">
            <span>Someone left — a new key is being created.</span>
            <button type="button" className="btn sm" onClick={() => run(() => rotateGroupKey(group.gid), 'Key rotated')}>Rotate now</button>
          </div>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="ly-danger-zone">
        <h3>Danger zone</h3>
        {owner ? (
          <div className="ly-danger-row">
            <div>
              <strong>Delete group</strong>
              <p className="muted">Removes the group and all of its messages for everyone. This can't be undone.</p>
            </div>
            <ConfirmButton
              className="btn danger"
              confirmLabel="Delete forever?"
              onConfirm={() =>
                run(async () => {
                  await deleteGroup(group.gid);
                  onDeleted?.();
                }, 'Group deleted')
              }
            >
              <Icon name="trash" size={15} /> Delete
            </ConfirmButton>
          </div>
        ) : (
          <div className="ly-danger-row">
            <div>
              <strong>Leave group</strong>
              <p className="muted">You'll lose access right away. Only the owner can add you back.</p>
            </div>
            <ConfirmButton
              className="btn danger"
              confirmLabel="Really leave?"
              onConfirm={() =>
                run(async () => {
                  await leaveGroup(group.gid);
                  onLeft?.();
                }, 'Left group')
              }
            >
              <Icon name="door" size={15} /> Leave
            </ConfirmButton>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Members ----------

function Members({ me, group, members, loading, onMessage }) {
  const owner = group.ownerId === me.uid;
  const uids = useMemo(() => members.map((m) => m.uid), [members]);
  const profiles = useProfiles(uids);
  const presence = usePresences(uids);
  const [adding, setAdding] = useState([]);
  const [shareHistory, setShareHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const room = MAX_GROUP_MEMBERS - members.length - adding.length;

  const sorted = useMemo(
    () =>
      [...members].sort(
        (a, b) =>
          (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) ||
          (profiles[a.uid]?.name || '').localeCompare(profiles[b.uid]?.name || '', undefined, { sensitivity: 'base' }),
      ),
    [members, profiles],
  );

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const done = await addMembers(group.gid, adding, { shareHistory });
      setAdding([]);
      toast(done.length === 1 ? 'Added 1 person' : `Added ${done.length} people`, 'success');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const kick = async (uid) => {
    setError('');
    try {
      await removeMember(group.gid, uid);
      toast('Removed — the group key was rotated', 'success');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  return (
    <div className="ly-form">
      {owner && (
        <div className="grp-add">
          <div className="ly-list-head">Add people</div>
          <MemberChips uids={adding} onRemove={(uid) => setAdding((a) => a.filter((u) => u !== uid))} disabled={busy} />
          {room > 0 ? (
            <UserPicker
              me={me}
              exclude={[...uids, ...adding]}
              onPick={(uid) => setAdding((a) => (a.includes(uid) || a.length + members.length >= MAX_GROUP_MEMBERS ? a : [...a, uid]))}
              placeholder="Search people by name"
              autoFocus={false}
              disabled={busy}
            />
          ) : (
            <p className="muted grp-hint">This group is full ({MAX_GROUP_MEMBERS} members).</p>
          )}
          {adding.length > 0 && (
            <div className="grp-add-actions">
              <label className="grp-check">
                <input type="checkbox" checked={shareHistory} onChange={(e) => setShareHistory(e.target.checked)} disabled={busy} />
                <span>Let them read earlier messages</span>
              </label>
              <span className="ly-grow" />
              <button type="button" className="btn primary sm" onClick={add} disabled={busy}>
                {busy ? <span className="spinner ly-spinner-sm" /> : `Add ${adding.length}`}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="ly-list-head">Members — {members.length}/{MAX_GROUP_MEMBERS}</div>
      {loading ? (
        <div className="spinner ly-spinner-sm" />
      ) : (
        <div className="ly-rows">
          {sorted.map((m) => {
            const p = profiles[m.uid];
            const isMe = m.uid === me.uid;
            return (
              <div key={m.uid} className="ly-row">
                <div className="ly-row-main person">
                  <Avatar profile={p} size={32} presence={presence[m.uid] || 'offline'} ring="var(--bg-1)" />
                  <span className="ly-dm-text">
                    <span className="ly-dm-name">
                      {p?.name || '…'}
                      {m.role === 'owner' && <Icon name="crown" size={12} className="grp-owner-icon" title="Owner" />}
                      {isMe && <span className="grp-you">you</span>}
                    </span>
                    {p?.status && <span className="ly-dm-status">{p.status}</span>}
                  </span>
                </div>
                <div className="ly-row-actions">
                  {!isMe && onMessage && (
                    <button type="button" className="btn ghost sm ly-icon-btn" onClick={() => onMessage(m.uid)} title="Message" aria-label={`Message ${p?.name || ''}`}>
                      <Icon name="message" size={15} />
                    </button>
                  )}
                  {owner && !isMe && (
                    <ConfirmButton className="btn danger sm" confirmLabel="Remove & rotate key?" onConfirm={() => kick(m.uid)}>
                      Remove
                    </ConfirmButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {owner && (
        <p className="muted grp-hint">
          <Icon name="lock" size={12} /> Removing someone creates a new group key for everyone else. They keep anything they already saw.
        </p>
      )}
    </div>
  );
}

// ---------- Modal ----------

const TABS = [
  ['overview', 'gear', 'Overview'],
  ['members', 'users', 'Members'],
];

export default function GroupSettingsModal({ me, gid, initialTab = 'overview', onClose, onLeft, onDeleted, onMessage }) {
  const [tab, setTab] = useState(initialTab === 'members' ? 'members' : 'overview');
  const group = useGroup(gid);
  const { members, loading } = useGroupMembers(gid);

  let body;
  if (group.status === 'loading') body = <div className="grp-center"><div className="spinner" /></div>;
  else if (group.status !== 'ready') body = <p className="muted">This group isn't available any more.</p>;
  else if (tab === 'overview') body = <Overview me={me} group={group} memberCount={members.length} onLeft={onLeft} onDeleted={onDeleted} />;
  else body = <Members me={me} group={group} members={members} loading={loading} onMessage={onMessage} />;

  return (
    <Modal title={group.name || 'Group settings'} onClose={onClose} wide className="ly-settings grp-settings">
      <div className="ly-tabs-line" role="tablist">
        {TABS.map(([k, icon, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`ly-tabline ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            <Icon name={icon} size={15} /> {label}
          </button>
        ))}
      </div>
      <div className="ly-settings-body">{body}</div>
    </Modal>
  );
}

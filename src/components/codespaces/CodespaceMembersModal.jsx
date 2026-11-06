// Members + settings for one codespace.
// Props: { csid, cs (useCodespace result), me, initialTab?: 'members'|'settings', onClose, onLeft, onDeleted }
//  - Owner: add people (UserPicker) as editor/viewer, change roles, remove, re-send a key,
//    rename, delete.
//  - Others: see the member list, leave.
import { useEffect, useMemo, useState } from 'react';
import { useProfiles } from '../../lib/profiles.js';
import {
  CODESPACE_ROLES,
  MAX_CODESPACE_MEMBERS,
  MAX_CODESPACE_NAME,
  ROLE_LABEL,
  addMember,
  cleanCodespaceName,
  deleteCodespace,
  leaveCodespace,
  removeMember,
  renameCodespace,
  reshareKey,
  setMemberRole,
} from '../../lib/codespaces.js';
import UserPicker from '../common/UserPicker.jsx';
import { Avatar, ConfirmButton, Icon, Modal, useToast } from '../layout/ui.jsx';
import './codespaces.css';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

function MemberRow({ m, profile, me, isOwner, onRole, onRemove, onReshare, busy }) {
  const isMe = m.uid === me.uid;
  return (
    <li className="cs-member">
      <Avatar profile={profile || { name: '?' }} size={32} />
      <div className="cs-member-text">
        <span className="cs-member-name">
          {profile?.name || 'Unknown user'}
          {isMe && <span className="muted"> (you)</span>}
        </span>
        <span className={`cs-role-badge ${m.role}`}>
          {m.role === 'owner' && <Icon name="crown" size={11} />}
          {ROLE_LABEL[m.role] || m.role}
        </span>
      </div>
      {isOwner && m.role !== 'owner' && (
        <div className="cs-member-actions">
          <select
            className="cs-select"
            value={m.role}
            disabled={busy}
            aria-label={`Role for ${profile?.name || 'member'}`}
            onChange={(e) => onRole(m.uid, e.target.value)}
          >
            {CODESPACE_ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
          <button
            className="btn ghost sm cs-icon-btn"
            title="Re-send encryption key (if they reset their account keys)"
            aria-label="Re-send key"
            disabled={busy}
            onClick={() => onReshare(m.uid)}
          >
            <Icon name="key" size={15} />
          </button>
          <ConfirmButton className="btn ghost sm cs-icon-btn danger" confirmLabel="Remove?" onConfirm={() => onRemove(m.uid)} disabled={busy}>
            <Icon name="x" size={15} />
          </ConfirmButton>
        </div>
      )}
    </li>
  );
}

export default function CodespaceMembersModal({ csid, cs, me, initialTab = 'members', onClose, onLeft, onDeleted }) {
  const toast = useToast();
  const [tab, setTab] = useState(initialTab);
  const [addRole, setAddRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(cs.meta?.name || '');
  const [nameTouched, setNameTouched] = useState(false);
  const currentName = cs.meta?.name || '';
  useEffect(() => {
    if (!nameTouched) setName(currentName);
  }, [currentName, nameTouched]);

  const isOwner = cs.isOwner;
  const members = cs.members;
  const uids = useMemo(() => members.map((m) => m.uid), [members]);
  const profiles = useProfiles(uids);
  const full = members.length >= MAX_CODESPACE_MEMBERS;
  const title = cs.meta?.name || 'Codespace';

  const run = async (fn, okText) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (okText) toast(okText, 'success');
      return true;
    } catch (e) {
      setError(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onPick = (uid) => {
    if (!uid || busy) return;
    if (full) {
      setError(`A codespace can have at most ${MAX_CODESPACE_MEMBERS} members`);
      return;
    }
    run(() => addMember(csid, uid, addRole), `Added as ${ROLE_LABEL[addRole].toLowerCase()}`);
  };

  const cleanName = cleanCodespaceName(name);

  return (
    <Modal title={tab === 'members' ? `Members — ${title}` : `Settings — ${title}`} onClose={onClose} wide className="cs-modal">
      <div className="cs-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
          <Icon name="users" size={15} /> Members <span className="cs-count">{members.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <Icon name="gear" size={15} /> Settings
        </button>
      </div>

      {error && <div className="error-text cs-modal-error">{error}</div>}

      {tab === 'members' ? (
        <div className="cs-members">
          {isOwner && (
            <div className="cs-add">
              <div className="cs-add-head">
                <span className="cs-section-label">Invite people</span>
                <label className="cs-add-role">
                  as
                  <select className="cs-select" value={addRole} onChange={(e) => setAddRole(e.target.value)} disabled={busy}>
                    {CODESPACE_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </label>
              </div>
              {full ? (
                <p className="muted cs-note">This codespace is full ({MAX_CODESPACE_MEMBERS} members).</p>
              ) : (
                <UserPicker me={me} exclude={uids} onPick={onPick} placeholder="Search people by name…" friendsFirst />
              )}
              <p className="cs-note muted">
                Editors can change files and the linked repo. Viewers can read and follow along, but can’t edit.
              </p>
            </div>
          )}
          <ul className="cs-member-list">
            {members.map((m) => (
              <MemberRow
                key={m.uid}
                m={m}
                profile={profiles[m.uid]}
                me={me}
                isOwner={isOwner}
                busy={busy}
                onRole={(uid, role) => run(() => setMemberRole(csid, uid, role), 'Role updated')}
                onRemove={(uid) => run(() => removeMember(csid, uid), 'Removed from codespace')}
                onReshare={(uid) => run(() => reshareKey(csid, uid), 'Key re-sent')}
              />
            ))}
          </ul>
          {isOwner && (
            <p className="cs-note muted">
              <Icon name="shield" size={13} /> Removing someone revokes their access immediately, but the encryption key is not
              rotated: anything they already downloaded stays readable to them.
            </p>
          )}
        </div>
      ) : (
        <div className="cs-settings">
          {isOwner ? (
            <>
              <form
                className="cs-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (cleanName && cleanName !== cs.meta?.name) run(() => renameCodespace(csid, cleanName), 'Codespace renamed');
                }}
              >
                <label className="field">
                  Name
                  <input className="input" value={name} maxLength={MAX_CODESPACE_NAME} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} disabled={busy} />
                </label>
                <div className="ly-form-actions">
                  <button className="btn primary" disabled={busy || !cleanName || cleanName === cs.meta?.name}>Save</button>
                </div>
              </form>
              <div className="cs-danger">
                <div>
                  <b>Delete codespace</b>
                  <p className="muted">Permanently deletes every file and version for all {members.length} member{members.length === 1 ? '' : 's'}.</p>
                </div>
                <ConfirmButton
                  className="btn danger"
                  confirmLabel="Really delete?"
                  disabled={busy}
                  onConfirm={async () => {
                    if (await run(() => deleteCodespace(csid, me.uid), 'Codespace deleted')) onDeleted?.();
                  }}
                >
                  <Icon name="trash" size={15} /> Delete
                </ConfirmButton>
              </div>
            </>
          ) : (
            <div className="cs-danger">
              <div>
                <b>Leave codespace</b>
                <p className="muted">You’ll lose access until the owner adds you again.</p>
              </div>
              <ConfirmButton
                className="btn danger"
                confirmLabel="Really leave?"
                disabled={busy}
                onConfirm={async () => {
                  if (await run(() => leaveCodespace(csid, me.uid), 'Left codespace')) onLeft?.();
                }}
              >
                <Icon name="door" size={15} /> Leave
              </ConfirmButton>
            </div>
          )}
          {cs.meta?.template && (
            <p className="cs-note muted">Started from the “{cs.meta.template}” template.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

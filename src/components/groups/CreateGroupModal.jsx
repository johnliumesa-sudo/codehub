// New private group: name + members (UserPicker). One atomic write creates everything.
// Props: { me, onClose, onCreated(gid) }
import { useState } from 'react';
import { MAX_GROUP_MEMBERS, MAX_GROUP_NAME, createGroup } from '../../lib/groups.js';
import { useProfiles } from '../../lib/profiles.js';
import UserPicker from '../common/UserPicker.jsx';
import { Avatar, Icon, Modal } from '../layout/ui.jsx';
import GroupAvatar from './GroupAvatar.jsx';
import './groups.css';

const errMsg = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

export function MemberChips({ uids, onRemove, disabled }) {
  const profiles = useProfiles(uids);
  if (!uids.length) return null;
  return (
    <div className="grp-chips">
      {uids.map((uid) => {
        const p = profiles[uid];
        return (
          <span key={uid} className="grp-chip">
            <Avatar profile={p} size={20} />
            <span className="grp-chip-name">{p?.name || '…'}</span>
            <button type="button" className="grp-chip-x" onClick={() => onRemove(uid)} disabled={disabled} aria-label={`Remove ${p?.name || 'person'}`}>
              <Icon name="x" size={12} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export default function CreateGroupModal({ me, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const full = picked.length + 1 >= MAX_GROUP_MEMBERS;

  const pick = (uid) => {
    setError('');
    setPicked((p) => (p.includes(uid) || p.length + 1 >= MAX_GROUP_MEMBERS ? p : [...p, uid]));
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const gid = await createGroup(me, { name, memberUids: picked });
      onCreated(gid);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New group" onClose={busy ? undefined : onClose} className="grp-modal">
      <form onSubmit={submit} className="ly-form grp-form">
        <div className="grp-preview">
          <GroupAvatar gid={name || 'new'} name={name.trim() || null} size={40} />
          <span className="grp-preview-name">{name.trim() || 'Untitled group'}</span>
          <span className="grp-count" title="Members including you">{picked.length + 1}/{MAX_GROUP_MEMBERS}</span>
        </div>
        <label className="field">
          Group name
          <input
            className="input"
            value={name}
            maxLength={MAX_GROUP_NAME}
            onChange={(e) => setName(e.target.value)}
            placeholder="Weekend hackers"
            autoFocus
            required
          />
        </label>
        <div className="grp-field">
          <span className="grp-field-label">Members</span>
          <MemberChips uids={picked} onRemove={(uid) => setPicked((p) => p.filter((u) => u !== uid))} disabled={busy} />
          {full ? (
            <p className="muted grp-hint">Groups are limited to {MAX_GROUP_MEMBERS} members.</p>
          ) : (
            <UserPicker me={me} exclude={picked} onPick={pick} placeholder="Add people by name" autoFocus={false} disabled={busy} />
          )}
        </div>
        <p className="muted grp-hint">
          <Icon name="lock" size={12} /> The name and every message are encrypted with a key only members hold. Membership itself is visible to the server.
        </p>
        {error && <p className="error-text">{error}</p>}
        <div className="ly-form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || picked.length < 1}>
            {busy ? <span className="spinner ly-spinner-sm" /> : picked.length < 1 ? 'Add someone' : 'Create group'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

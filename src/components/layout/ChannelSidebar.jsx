import { useState } from 'react';
import { canManage, channelScope } from '../../lib/servers.js';
import { isUnread } from './hooks.js';
import { Icon, Menu, MenuItem } from './ui.jsx';

function ChannelRow({ ch, active, unread, canEdit, onSelect, onEdit }) {
  const label = ch.failed ? 'undecryptable' : ch.name;
  return (
    <div className={`ly-chan ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${ch.failed ? 'failed' : ''}`}>
      <button className="ly-chan-main" onClick={() => onSelect(ch)} title={ch.topic || label || ''}>
        <Icon name={ch.type === 'code' ? 'code' : 'hash'} size={17} className="ly-chan-icon" />
        {ch.pending ? <span className="ly-skel-line" /> : <span className="ly-chan-name">{label}</span>}
        {unread && <span className="ly-unread-dot" aria-label="unread" />}
      </button>
      {canEdit && !ch.pending && (
        <button className="ly-chan-edit" onClick={() => onEdit(ch)} aria-label={`Edit ${label}`} title="Edit channel">
          <Icon name="gear" size={15} />
        </button>
      )}
    </div>
  );
}

function Section({ title, onAdd, addLabel, children, collapsed, onToggle }) {
  return (
    <section className="ly-section">
      <div className="ly-section-head">
        <button className="ly-section-title" onClick={onToggle} aria-expanded={!collapsed}>
          <Icon name="chevron" size={12} stroke={2.4} className={collapsed ? 'rot' : ''} />
          {title}
        </button>
        {onAdd && (
          <button className="ly-section-add" onClick={onAdd} aria-label={addLabel} title={addLabel}>
            <Icon name="plus" size={15} />
          </button>
        )}
      </div>
      {!collapsed && children}
    </section>
  );
}

export default function ChannelSidebar({
  meta,
  myRole,
  channels,
  loading,
  error,
  tab,
  activeCid,
  reads,
  lastMsgs,
  myUid,
  sid,
  onSelect,
  onCreateChannel,
  onEditChannel,
  onOpenSettings,
  onInvite,
  onLeave,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const admin = canManage(myRole);
  const text = channels.filter((c) => c.type === 'text');
  const code = channels.filter((c) => c.type === 'code');
  const toggle = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  const row = (ch) => (
    <ChannelRow
      key={ch.cid}
      ch={ch}
      active={ch.cid === activeCid}
      unread={ch.cid !== activeCid && isUnread(lastMsgs[ch.cid], reads[channelScope(sid, ch.cid)], myUid)}
      canEdit={admin}
      onSelect={onSelect}
      onEdit={onEditChannel}
    />
  );

  const textSection = (
    <Section key="text" title="Text channels" collapsed={collapsed.text} onToggle={() => toggle('text')}
      onAdd={admin ? () => onCreateChannel('text') : null} addLabel="Create text channel">
      {text.map(row)}
      {!loading && text.length === 0 && <p className="ly-section-empty">No text channels yet</p>}
    </Section>
  );
  const codeSection = (
    <Section key="code" title={tab === 'collab' ? 'Workspaces' : 'Code workspaces'} collapsed={collapsed.code}
      onToggle={() => toggle('code')} onAdd={admin ? () => onCreateChannel('code') : null} addLabel="Create code workspace">
      {code.map(row)}
      {!loading && code.length === 0 && <p className="ly-section-empty">No workspaces yet</p>}
    </Section>
  );

  const serverName = meta.name || (meta.nameFailed ? 'Locked server' : '');

  return (
    <div className="ly-sidebar-inner">
      <header className="ly-side-head server">
        <button className="ly-server-title" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>
          <span className="ly-server-swatch" style={{ background: meta.color }} />
          <span className="ly-ellipsis">{serverName || <span className="ly-skel-line" />}</span>
          <Icon name={menuOpen ? 'x' : 'chevron'} size={16} />
        </button>
        <Menu open={menuOpen} onClose={() => setMenuOpen(false)} className="ly-server-menu">
          {admin && <MenuItem icon="users" onClick={onInvite}>Invite people</MenuItem>}
          <MenuItem icon="gear" onClick={onOpenSettings}>Server settings</MenuItem>
          {admin && <MenuItem icon="hash" onClick={() => onCreateChannel('text')}>Create text channel</MenuItem>}
          {admin && <MenuItem icon="code" onClick={() => onCreateChannel('code')}>Create code workspace</MenuItem>}
          {myRole !== 'owner' && <div className="ly-menu-sep" />}
          {myRole !== 'owner' && <MenuItem icon="door" danger onClick={onLeave}>Leave server</MenuItem>}
        </Menu>
      </header>
      <div className="ly-side-scroll">
        {meta.nameFailed && (
          <div className="ly-callout danger">
            <Icon name="lock" size={16} /> Can't decrypt this server. Your key may be missing — ask an admin for a new invite.
          </div>
        )}
        {error && <div className="ly-callout danger">Couldn't load channels: {String(error.message || error)}</div>}
        {loading && (
          <div className="ly-skel-group">
            {[70, 55, 80, 60].map((w, i) => <span key={i} className="ly-skel-line" style={{ width: `${w}%` }} />)}
          </div>
        )}
        {!loading && (tab === 'collab' ? [codeSection, textSection] : [textSection, codeSection])}
      </div>
    </div>
  );
}

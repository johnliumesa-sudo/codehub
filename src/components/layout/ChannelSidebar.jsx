import { useState } from 'react';
import { channelScope } from '../../lib/servers.js';
import { isMuted, useNotifPrefs } from '../../lib/notify.js';
import MuteMenu from '../safety/MuteMenu.jsx';
import { isUnread } from './hooks.js';
import { Icon, Menu, MenuItem } from './ui.jsx';
import VoiceChannelParticipants from '../calls/VoiceChannelParticipants.jsx';
import CallIcon from '../calls/CallIcon.jsx';

function ChannelRow({ sid, ch, active, unread, canEdit, onSelect, onEdit }) {
  const label = ch.failed ? 'undecryptable' : ch.name;
  return (
    <div className={`ly-chan ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${ch.failed ? 'failed' : ''}`}>
      <button className="ly-chan-main" onClick={() => onSelect(ch)} title={ch.topic || label || ''}>
        {ch.type === 'voice' ? <CallIcon name="speaker" size={17} className="ly-chan-icon" /> : <Icon name={ch.type === 'code' ? 'code' : 'hash'} size={17} className="ly-chan-icon" />}
        {ch.pending ? <span className="ly-skel-line" /> : <span className="ly-chan-name">{label}</span>}
        {unread && <span className="ly-unread-dot" aria-label="unread" />}
      </button>
      {canEdit && !ch.pending && (
        <button className="ly-chan-edit" onClick={() => onEdit(ch)} aria-label={`Edit ${label}`} title="Edit channel">
          <Icon name="gear" size={15} />
        </button>
      )}
      {ch.type === 'voice' && sid && !ch.pending && <VoiceChannelParticipants sid={sid} cid={ch.cid} />}
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
  perms,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  // Role-based gates (owner/admin hold every permission; custom roles per flag).
  const canChannels = !!perms?.manageChannels;
  const canInvite = !!perms?.manageInvites;
  const notifPrefs = useNotifPrefs(myUid);
  const text = channels.filter((c) => c.type === 'text');
  const code = channels.filter((c) => c.type === 'code');
  const voice = channels.filter((c) => c.type === 'voice');
  const toggle = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

  const row = (ch) => (
    <ChannelRow
      key={ch.cid}
      sid={sid}
      ch={ch}
      active={ch.cid === activeCid}
      unread={
        ch.cid !== activeCid &&
        isUnread(lastMsgs[ch.cid], reads[channelScope(sid, ch.cid)], myUid) &&
        !isMuted(notifPrefs, channelScope(sid, ch.cid), Date.now(), { sid })
      }
      canEdit={canChannels}
      onSelect={onSelect}
      onEdit={onEditChannel}
    />
  );

  const textSection = (
    <Section key="text" title="Text channels" collapsed={collapsed.text} onToggle={() => toggle('text')}
      onAdd={canChannels ? () => onCreateChannel('text') : null} addLabel="Create text channel">
      {text.map(row)}
      {!loading && text.length === 0 && <p className="ly-section-empty">No text channels yet</p>}
    </Section>
  );
  const codeSection = (
    <Section key="code" title={tab === 'collab' ? 'Workspaces' : 'Code workspaces'} collapsed={collapsed.code}
      onToggle={() => toggle('code')} onAdd={canChannels ? () => onCreateChannel('code') : null} addLabel="Create code workspace">
      {code.map(row)}
      {!loading && code.length === 0 && <p className="ly-section-empty">No workspaces yet</p>}
    </Section>
  );

  const voiceSection = (voice.length > 0 || canChannels) && (
    <Section key="voice" title="Voice channels" collapsed={collapsed.voice}
      onToggle={() => toggle('voice')} onAdd={canChannels ? () => onCreateChannel('voice') : null} addLabel="Create voice channel">
      {voice.map(row)}
      {!loading && voice.length === 0 && <p className="ly-section-empty">No voice channels yet</p>}
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
          {canInvite && <MenuItem icon="users" onClick={onInvite}>Invite people</MenuItem>}
          <MenuItem icon="gear" onClick={onOpenSettings}>Server settings</MenuItem>
          {canChannels && <MenuItem icon="hash" onClick={() => onCreateChannel('text')}>Create text channel</MenuItem>}
          {canChannels && <MenuItem icon="code" onClick={() => onCreateChannel('code')}>Create code workspace</MenuItem>}
          {canChannels && <MenuItem icon="users" onClick={() => onCreateChannel('voice')}>Create voice channel</MenuItem>}
          {myRole !== 'owner' && <div className="ly-menu-sep" />}
          {myRole !== 'owner' && <MenuItem icon="door" danger onClick={onLeave}>Leave server</MenuItem>}
        </Menu>
        <MuteMenu me={myUid} scope={`srv_${sid}`} label="server" align="right" />
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
        {!loading && (tab === 'collab' ? [codeSection, textSection, voiceSection] : [textSection, voiceSection, codeSection])}
      </div>
    </div>
  );
}

import { usePresence } from '../../lib/presence.js';
import { Avatar, Icon, PRESENCE_LABEL } from './ui.jsx';

function DmTitle({ peer }) {
  const presence = usePresence(peer?.uid);
  return (
    <div className="ly-head-title">
      <Avatar profile={peer} size={26} presence={presence} ring="var(--bg-2)" />
      <span className="ly-head-name">{peer?.name || '…'}</span>
      <span className="ly-head-topic">{peer?.status || PRESENCE_LABEL[presence]}</span>
    </div>
  );
}

export default function Header({
  mode, // 'home' | 'server'
  tab,
  onTab,
  channel,
  peer,
  serverName,
  rightPanel,
  rightOptions, // ['members', 'chat']
  onRightPanel,
  onMenu,
  showMenuButton,
}) {
  return (
    <header className="ly-header">
      {showMenuButton && (
        <button className="btn ghost sm ly-icon-btn ly-menu-btn" onClick={onMenu} aria-label="Open navigation">
          <Icon name="menu" size={20} />
        </button>
      )}

      {mode === 'home' ? (
        peer ? (
          <DmTitle peer={peer} />
        ) : (
          <div className="ly-head-title">
            <Icon name="users" size={18} className="ly-head-icon" />
            <span className="ly-head-name">Friends</span>
          </div>
        )
      ) : (
        <div className="ly-head-title">
          <Icon name={tab === 'collab' ? 'code' : 'hash'} size={19} className="ly-head-icon" />
          <span className="ly-head-name">{channel?.name || (channel?.failed ? 'undecryptable' : serverName || '')}</span>
          {channel?.topic && <span className="ly-head-topic" title={channel.topic}>{channel.topic}</span>}
        </div>
      )}

      <span className="ly-grow" />

      {mode === 'server' && (
        <div className="ly-seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => onTab('chat')}>
            <span aria-hidden>💬</span> <span className="ly-seg-label">Chat</span>
          </button>
          <button role="tab" aria-selected={tab === 'collab'} className={tab === 'collab' ? 'on' : ''} onClick={() => onTab('collab')}>
            <span aria-hidden>🧑‍💻</span> <span className="ly-seg-label">Collab</span>
          </button>
        </div>
      )}

      <span className="badge-e2e ly-head-e2e" title="Messages, names and code are end-to-end encrypted">
        <Icon name="lock" size={11} stroke={2.2} /> <span className="ly-seg-label">E2E</span>
      </span>

      {rightOptions?.includes('chat') && (
        <button
          className={`btn ghost sm ly-icon-btn ${rightPanel === 'chat' ? 'on' : ''}`}
          onClick={() => onRightPanel(rightPanel === 'chat' ? null : 'chat')}
          aria-pressed={rightPanel === 'chat'}
          title="Workspace chat"
          aria-label="Toggle workspace chat"
        >
          <Icon name="chat" size={19} />
        </button>
      )}
      {rightOptions?.includes('members') && (
        <button
          className={`btn ghost sm ly-icon-btn ${rightPanel === 'members' ? 'on' : ''}`}
          onClick={() => onRightPanel(rightPanel === 'members' ? null : 'members')}
          aria-pressed={rightPanel === 'members'}
          title="Member list"
          aria-label="Toggle member list"
        >
          <Icon name="users" size={19} />
        </button>
      )}
    </header>
  );
}

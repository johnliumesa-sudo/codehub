import { memo, useState } from 'react';
import { initials } from '../../lib/profiles.js';
import { channelScope } from '../../lib/servers.js';
import { isUnread, useChannelIds, useLastMessages, useServerMeta } from './hooks.js';
import { Icon } from './ui.jsx';
import { isMuted, useNotifPrefs } from '../../lib/notify.js';

function RailButton({ active, unread, label, color, onClick, children, className = '' }) {
  // Tooltip is position:fixed so the scrollable rail never clips it.
  const [tip, setTip] = useState(null);
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ top: r.top + r.height / 2, left: r.right + 12 });
  };
  return (
    <div className={`ly-rail-item ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${className}`}>
      <span className="ly-rail-pill" />
      <button
        className="ly-rail-btn"
        style={color ? { '--srv': color } : undefined}
        onClick={(e) => { setTip(null); onClick?.(e); }}
        onMouseEnter={show}
        onMouseLeave={() => setTip(null)}
        // Keyboard focus only: a mouse click also focuses the button, which left the tip stuck.
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && show(e)}
        onBlur={() => setTip(null)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
      >
        {children}
      </button>
      {tip && (
        <span className="ly-rail-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          {label}
        </span>
      )}
    </div>
  );
}

const ServerIcon = memo(function ServerIcon({ sid, nonce, active, onSelect, onStale, reads, myUid }) {
  const meta = useServerMeta(sid, nonce);
  const cids = useChannelIds(meta.status === 'ready' ? sid : null, nonce);
  const last = useLastMessages(meta.status === 'ready' ? `messages/${sid}` : null, cids, nonce);
  const notifPrefs = useNotifPrefs(myUid);
  const unread =
    !active &&
    !isMuted(notifPrefs, `srv_${sid}`) &&
    cids.some((cid) => isUnread(last[cid], reads[channelScope(sid, cid)], myUid) && !isMuted(notifPrefs, channelScope(sid, cid), Date.now(), { sid }));

  if (meta.status === 'denied' || meta.status === 'missing') {
    return (
      <RailButton label="Server unavailable — click to remove" className="stale" onClick={() => onStale(sid)}>
        <Icon name="x" size={18} />
      </RailButton>
    );
  }
  const name = meta.name || (meta.nameFailed ? 'Locked server' : '…');
  return (
    <RailButton active={active} unread={unread} label={name} color={meta.color} onClick={() => onSelect(sid)}>
      {meta.status === 'loading' || (!meta.name && !meta.nameFailed) ? (
        <span className="ly-rail-skeleton" />
      ) : meta.nameFailed ? (
        <Icon name="lock" size={18} />
      ) : (
        <span className="ly-rail-initials">{initials(name).slice(0, 3)}</span>
      )}
    </RailButton>
  );
});

export default function ServerRail({ servers, loading, activeSid, homeUnread, onHome, onSelect, onStale, onCreateJoin, reads, myUid, refreshTick = 0, codespacesActive = false, onCodespaces, arcadeActive = false, onArcade, shopActive = false, onShop }) {
  return (
    <nav className="ly-rail" aria-label="Servers">
      <RailButton active={!activeSid && !codespacesActive && !arcadeActive && !shopActive} unread={homeUnread} label="Direct messages" onClick={onHome} className="home">
        <Icon name="home" size={22} stroke={2.2} />
      </RailButton>
      {onCodespaces && (
        <RailButton active={codespacesActive} label="Codespaces" onClick={onCodespaces} className="home">
          <Icon name="code" size={22} stroke={2.2} />
        </RailButton>
      )}
      {onArcade && (
        <RailButton active={arcadeActive} label="Arcade (public games)" onClick={onArcade} className="home arcade">
          <Icon name="gamepad" size={22} stroke={2} />
        </RailButton>
      )}
      <div className="ly-rail-sep" />
      <div className="ly-rail-list">
        {loading && [0, 1].map((i) => <div key={i} className="ly-rail-item"><span className="ly-rail-btn ghost"><span className="ly-rail-skeleton" /></span></div>)}
        {servers.map((s) => (
          <ServerIcon key={s.sid} sid={s.sid} nonce={`${s.joinedAt}|${refreshTick}`} active={activeSid === s.sid} onSelect={onSelect} onStale={onStale} reads={reads} myUid={myUid} />
        ))}
        <RailButton label="Create or join a server" onClick={onCreateJoin} className="add">
          <Icon name="plus" size={22} />
        </RailButton>
        {onShop && (
          <RailButton label="Add-on shop" active={shopActive} onClick={onShop} className="shop">
            <span className="shop-rail-glyph" aria-hidden="true">🛍️</span>
          </RailButton>
        )}
      </div>
    </nav>
  );
}

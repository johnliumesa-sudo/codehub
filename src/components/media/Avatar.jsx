// <Avatar uid> and <ServerIcon sid>: image from the shared lib cache, initials fallback.
import { useState } from 'react';
import { useAvatar } from '../../lib/media/avatars.js';
import { useServerIcon } from '../../lib/media/icons.js';
import { AVATAR_COLORS, initials, useProfile } from '../../lib/profiles.js';
import { toSrc } from './util.js';

function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function Avatar({ uid, size = 32, name, color, presence, ring, className = '' }) {
  const profile = useProfile(uid);
  const src = toSrc(useAvatar(uid));
  const [bad, setBad] = useState(null);
  const label = name || profile?.name || '?';
  const bg = color || profile?.color || hashColor(String(uid || label));
  const showImg = src && bad !== src;
  return (
    <span className={`md-avatar ${className}`} style={{ width: size, height: size, '--ring': ring || 'var(--bg-1)' }}>
      {showImg ? (
        <img className="md-avatar-img" src={src} alt="" width={size} height={size} draggable={false} onError={() => setBad(src)} />
      ) : (
        <span className="md-avatar-fallback" style={{ width: size, height: size, background: bg, fontSize: Math.max(10, Math.round(size * 0.38)) }}>
          {initials(label)}
        </span>
      )}
      {presence && <span className={`ly-presence ${presence}`} title={presence} />}
    </span>
  );
}

export function ServerIcon({ sid, name = '?', size = 40, color, className = '' }) {
  const src = toSrc(useServerIcon(sid));
  const [bad, setBad] = useState(null);
  const showImg = src && bad !== src;
  return (
    <span className={`md-sicon ${className}`} style={{ width: size, height: size }}>
      {showImg ? (
        <img className="md-sicon-img" src={src} alt="" width={size} height={size} draggable={false} onError={() => setBad(src)} />
      ) : (
        <span className="md-sicon-fallback" style={{ width: size, height: size, background: color || hashColor(String(sid || name)), fontSize: Math.max(10, Math.round(size * 0.36)) }}>
          {initials(name)}
        </span>
      )}
    </span>
  );
}

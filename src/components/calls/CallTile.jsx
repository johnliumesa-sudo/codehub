// One participant tile: video or avatar, name, mute / hand / connection status, speaking ring and the
// reactions they send. The whole tile is a spotlight toggle (an overlay button, so the other controls
// stay separate focus stops).
import { useEffect, useRef } from 'react';
import { Avatar } from '../layout/ui.jsx';
import { STATUS_TEXT } from '../../lib/calls/health.js';
import { REACTION_LABELS } from '../../lib/calls/events.js';
import CallIcon from './CallIcon.jsx';

export function VideoEl({ stream, track, mirror, fit, videoRef }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.srcObject = stream || (track ? new MediaStream([track]) : null);
    el.play?.().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [stream, track]);
  const setRef = (el) => {
    ref.current = el;
    if (videoRef) videoRef.current = el;
  };
  return <video ref={setRef} className={`call-video ${mirror ? 'mirror' : ''} ${fit === 'contain' ? 'contain' : ''}`} autoPlay playsInline muted />;
}

function StatusChip({ status, rejoining }) {
  if (rejoining) return <span className="call-tile-state reconnecting">{STATUS_TEXT.reconnecting}</span>;
  if (!status) return null;
  if (status === 'connected') {
    return (
      <span className="call-tile-ok" title={STATUS_TEXT.connected}>
        <span className="call-sr">{STATUS_TEXT.connected}</span>
      </span>
    );
  }
  return <span className={`call-tile-state ${status}`} role={status === 'failed' ? 'alert' : undefined}>{STATUS_TEXT[status]}</span>;
}

/**
 * Props: uid, isMe, profile, slot ({mic, cam, screen}), speaking, stream (remote), localTrack (mine),
 * status (remote peer status), rejoining (mine), hand (raise order number or 0), reactions ([{id, e}]),
 * selected, onSelect(), size ('grid' | 'main' | 'strip'), videoRef (spotlight PiP).
 */
export default function CallTile({
  uid, isMe, profile, slot, speaking, stream, tracks, localTrack, status, rejoining, hand, reactions, selected, onSelect, size = 'grid', videoRef,
}) {
  const remoteVideo = !!stream?.getVideoTracks().some((t) => t.readyState === 'live');
  const hasVideo = isMe ? !!localTrack : !!(slot?.cam || slot?.screen) && remoteVideo;
  const name = isMe ? 'You' : profile?.name || 'Someone';
  const fit = slot?.screen || size === 'main' ? 'contain' : 'cover';
  return (
    <div className={`call-tile ${size} ${speaking ? 'speaking' : ''} ${slot?.screen ? 'screen' : ''} ${selected ? 'selected' : ''}`} data-uid={uid}>
      {hasVideo ? (
        isMe ? (
          <VideoEl track={localTrack} mirror={!slot?.screen} fit={fit} videoRef={videoRef} />
        ) : (
          <VideoEl key={tracks} stream={stream} fit={fit} videoRef={videoRef} />
        )
      ) : (
        <div className="call-tile-avatar">
          <Avatar profile={profile} size={size === 'strip' ? 40 : size === 'main' ? 96 : 72} ring={speaking ? 'var(--ok)' : undefined} />
        </div>
      )}
      <button
        type="button"
        className="call-tile-select"
        onClick={onSelect}
        aria-pressed={!!selected}
        aria-label={selected ? `Stop spotlighting ${name}` : `Spotlight ${name}`}
        title={selected ? 'Back to grid' : 'Spotlight'}
      />
      {hand > 0 && (
        <span className="call-tile-hand" title={`Hand raised${hand > 1 ? ` (#${hand})` : ''}`}>
          <span aria-hidden="true">✋</span>
          {hand > 1 && <span className="call-tile-hand-n">{hand}</span>}
          <span className="call-sr">Hand raised</span>
        </span>
      )}
      {reactions?.length > 0 && (
        <div className="call-floats" aria-hidden="true">
          {reactions.map((r, i) => (
            <span key={r.id} className="call-float" style={{ '--x': `${((r.id * 37) % 60) - 30}px`, '--i': i }} title={REACTION_LABELS[r.e]}>
              {r.e}
            </span>
          ))}
        </div>
      )}
      <div className="call-tile-label">
        {slot && !slot.mic && <CallIcon name="micOff" size={13} title="Muted" />}
        <span className="call-tile-name">{name}</span>
        {slot?.screen && <span className="call-live-tag">LIVE</span>}
        {isMe ? <StatusChip rejoining={rejoining} /> : <StatusChip status={status} />}
      </div>
    </div>
  );
}

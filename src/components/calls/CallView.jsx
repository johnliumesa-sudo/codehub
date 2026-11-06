// Full call view: tile grid (video or avatar), remote audio, controls bar and device picker.
// Renders nothing when there is no active call. Remote audio lives in <CallAudio>, which the
// integrator mounts once at app level so audio keeps playing while the view is closed.
import { useEffect, useRef, useState } from 'react';
import { useProfiles } from '../../lib/profiles.js';
import { callActions, useActiveCall } from '../../lib/calls/useCall.js';
import { listDevices, screenShareSupported, sinkSupported } from '../../lib/calls/media.js';
import { Avatar } from '../layout/ui.jsx';
import CallIcon from './CallIcon.jsx';
import './calls.css';

function VideoEl({ stream, track, mirror, fit }) {
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
  return <video ref={ref} className={`call-video ${mirror ? 'mirror' : ''} ${fit === 'contain' ? 'contain' : ''}`} autoPlay playsInline muted />;
}

function Tile({ uid, profile, slot, speaking, stream, localTrack, isMe, state }) {
  const hasVideo = isMe ? !!localTrack : !!(slot?.cam || slot?.screen) && !!stream?.getVideoTracks().length;
  return (
    <div className={`call-tile ${speaking ? 'speaking' : ''} ${slot?.screen ? 'screen' : ''}`}>
      {hasVideo ? (
        isMe ? <VideoEl track={localTrack} mirror={!slot?.screen} fit={slot?.screen ? 'contain' : 'cover'} /> : <VideoEl stream={stream} fit={slot?.screen ? 'contain' : 'cover'} />
      ) : (
        <div className="call-tile-avatar">
          <Avatar profile={profile} size={72} ring={speaking ? 'var(--ok)' : undefined} />
        </div>
      )}
      <div className="call-tile-label">
        {slot && !slot.mic && <CallIcon name="micOff" size={13} title="Muted" />}
        <span>{isMe ? 'You' : profile?.name || '…'}</span>
        {slot?.screen && <span className="call-live-tag">LIVE</span>}
        {!isMe && state && state !== 'connected' && <span className="call-tile-state">{state === 'failed' ? 'Connection failed' : 'Connecting…'}</span>}
      </div>
    </div>
  );
}

/** Hidden <audio> per remote peer. Mount once (app level) while a call is active. */
export function CallAudio() {
  const call = useActiveCall();
  if (!call || call.status !== 'live') return null;
  return (
    <div className="call-audio" aria-hidden="true">
      {call.peers.map((p) => (
        <PeerAudio key={p.uid} stream={p.stream} tracks={p.tracks} muted={call.deafened} sinkId={call.devices?.audioOut} />
      ))}
    </div>
  );
}

function PeerAudio({ stream, tracks, muted, sinkId }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.srcObject = stream;
    el.play?.().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [stream, tracks]);
  useEffect(() => {
    if (ref.current) ref.current.muted = !!muted;
  }, [muted]);
  useEffect(() => {
    if (sinkId && ref.current?.setSinkId) ref.current.setSinkId(sinkId).catch(() => {});
  }, [sinkId]);
  return <audio ref={ref} autoPlay />;
}

function DevicePicker({ devices, onClose }) {
  const [list, setList] = useState({ audioIn: [], videoIn: [], audioOut: [] });
  useEffect(() => {
    let live = true;
    const load = () => listDevices().then((l) => live && setList(l)).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, []);
  const row = (label, key, items) =>
    items.length > 0 && (
      <label className="call-dev-row">
        <span>{label}</span>
        <select value={devices?.[key] || ''} onChange={(e) => callActions.setDevices({ [key]: e.target.value })}>
          <option value="">Default</option>
          {items.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <div className="call-devices" role="dialog" aria-label="Audio and video devices">
      {row('Microphone', 'audioIn', list.audioIn)}
      {row('Camera', 'videoIn', list.videoIn)}
      {sinkSupported() && row('Speaker', 'audioOut', list.audioOut)}
      <button className="btn sm" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

export function CallControls({ call, onMinimize }) {
  const [devOpen, setDevOpen] = useState(false);
  const [err, setErr] = useState('');
  const run = (fn) => async () => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e?.message || 'Something went wrong');
    }
  };
  const live = call.status === 'live';
  return (
    <div className="call-controls">
      {err && <div className="call-error" role="alert">{err}</div>}
      {devOpen && <DevicePicker devices={call.devices} onClose={() => setDevOpen(false)} />}
      <div className="call-controls-row">
        <button className={`call-ctl ${call.mic ? '' : 'off'}`} onClick={run(callActions.toggleMic)} disabled={!live} aria-pressed={!call.mic} title={call.mic ? 'Mute' : 'Unmute'}>
          <CallIcon name={call.mic ? 'mic' : 'micOff'} />
        </button>
        <button className={`call-ctl ${call.deafened ? 'off' : ''}`} onClick={run(callActions.toggleDeafen)} disabled={!live} aria-pressed={call.deafened} title={call.deafened ? 'Undeafen' : 'Deafen'}>
          <CallIcon name={call.deafened ? 'headsetOff' : 'headset'} />
        </button>
        <button className={`call-ctl ${call.camOn ? 'on' : ''}`} onClick={run(callActions.toggleCam)} disabled={!live} aria-pressed={call.camOn} title={call.camOn ? 'Turn camera off' : 'Turn camera on'}>
          <CallIcon name={call.camOn ? 'video' : 'videoOff'} />
        </button>
        {screenShareSupported() && (
          <button className={`call-ctl ${call.screenOn ? 'on' : ''}`} onClick={run(callActions.toggleScreen)} disabled={!live} aria-pressed={call.screenOn} title={call.screenOn ? 'Stop sharing' : 'Share screen'}>
            <CallIcon name="screen" />
          </button>
        )}
        <button className="call-ctl" onClick={() => setDevOpen((v) => !v)} title="Devices" aria-expanded={devOpen}>
          <CallIcon name="gear" />
        </button>
        {onMinimize && (
          <button className="call-ctl" onClick={onMinimize} title="Minimize">
            <CallIcon name="expand" />
          </button>
        )}
        <button className="call-ctl hangup" onClick={run(callActions.leave)} title="Leave call">
          <CallIcon name="hangup" />
        </button>
      </div>
    </div>
  );
}

/** Props: `title` (string shown in the header), `onMinimize()` (return to chat; MiniCallBar takes over). */
export default function CallView({ title, onMinimize }) {
  const call = useActiveCall();
  const slots = Object.values(call?.slots || {}).filter((s) => s?.uid);
  const uids = slots.map((s) => s.uid);
  const profiles = useProfiles(call ? [call.me, ...uids] : []);
  if (!call) return null;
  if (call.status === 'ended' || call.status === 'error') {
    return (
      <div className="call-view ended">
        <p>{call.status === 'error' ? call.error || 'The call failed' : 'Call ended'}</p>
        <button className="btn" onClick={() => { callActions.dismiss(); onMinimize?.(); }}>
          Close
        </button>
      </div>
    );
  }
  const bySlot = new Map(slots.map((s) => [s.uid, s]));
  const peers = new Map(call.peers.map((p) => [p.uid, p]));
  const tiles = [call.me, ...uids.filter((u) => u !== call.me)];
  const n = tiles.length;
  return (
    <section className="call-view" aria-label="Call">
      <header className="call-head">
        <CallIcon name={call.kind === 'video' ? 'video' : 'phone'} size={16} />
        <strong>{title || 'Call'}</strong>
        <span className="call-dim">{call.status === 'joining' ? 'Joining…' : `${n} in call`}</span>
      </header>
      {call.error && call.status === 'live' && <div className="call-notice">{call.error}</div>}
      <div className={`call-grid n${Math.min(n, 6)}`}>
        {tiles.map((uid) => (
          <Tile
            key={uid}
            uid={uid}
            isMe={uid === call.me}
            profile={profiles[uid]}
            slot={bySlot.get(uid) || (uid === call.me ? { mic: call.mic, cam: call.camOn, screen: call.screenOn } : null)}
            speaking={call.speaking.has(uid)}
            stream={peers.get(uid)?.stream}
            state={peers.get(uid)?.state}
            localTrack={uid === call.me ? call.localVideo : null}
          />
        ))}
      </div>
      <CallControls call={call} onMinimize={onMinimize} />
    </section>
  );
}

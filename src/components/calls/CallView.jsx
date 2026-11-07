// Full call view: tile grid or spotlight + strip, participant list with raised hands, reactions,
// push-to-talk, device menu, fullscreen and picture-in-picture. Renders nothing when there is no active
// call. Remote audio lives in <CallAudio>, mounted once at app level so audio keeps playing while the
// view is closed.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProfiles } from '../../lib/profiles.js';
import { callActions, useActiveCall } from '../../lib/calls/useCall.js';
import { screenShareSupported } from '../../lib/calls/media.js';
import { REACTIONS, REACTION_LABELS } from '../../lib/calls/events.js';
import { STATUS_TEXT } from '../../lib/calls/health.js';
import { keyLabel } from '../../lib/calls/prefs.js';
import { Avatar } from '../layout/ui.jsx';
import CallIcon from './CallIcon.jsx';
import CallTile from './CallTile.jsx';
import DeviceForm from './DeviceForm.jsx';
import './calls.css';

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
    if (ref.current?.setSinkId) ref.current.setSinkId(sinkId || '').catch(() => {});
  }, [sinkId, stream]);
  return <audio ref={ref} autoPlay />;
}

/** A popover that closes on Escape or an outside click and returns focus to its opener. */
function usePopover(open, setOpen, anchorRef) {
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const box = boxRef.current;
    box?.querySelector('select,button,input')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    const onDown = (e) => {
      if (!box?.contains(e.target) && !anchorRef.current?.contains(e.target)) setOpen(false);
    };
    box?.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      box?.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, setOpen, anchorRef]);
  return boxRef;
}

function PttButton({ call }) {
  const hold = (down) => () => callActions.pttPress(down);
  const key = (down) => (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) callActions.pttPress(down);
    }
  };
  return (
    <button
      type="button"
      className={`call-ctl ptt ${call.pttHeld ? 'on' : ''}`}
      onPointerDown={hold(true)}
      onPointerUp={hold(false)}
      onPointerLeave={hold(false)}
      onPointerCancel={hold(false)}
      onKeyDown={key(true)}
      onKeyUp={key(false)}
      onBlur={hold(false)}
      onContextMenu={(e) => e.preventDefault()}
      disabled={call.status !== 'live' || !call.mic}
      aria-pressed={call.pttHeld}
      title={`Hold to talk (or hold ${keyLabel(call.devices?.pttKey)})`}
      aria-label="Hold to talk"
    >
      <CallIcon name="mic" />
      <span className="call-ctl-text">{call.pttHeld ? 'Talking' : 'Hold to talk'}</span>
    </button>
  );
}

function ReactionPicker({ disabled }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const anchor = useRef(null);
  const box = usePopover(open, setOpen, anchor);
  const send = (e) => {
    if (!callActions.react(e)) setNote('Slow down a little');
    else setNote('');
  };
  return (
    <>
      <button ref={anchor} type="button" className="call-ctl" onClick={() => setOpen((v) => !v)} disabled={disabled} aria-expanded={open} aria-haspopup="true" title="Send a reaction" aria-label="Send a reaction">
        <span aria-hidden="true" className="call-ctl-emoji">😊</span>
      </button>
      {open && (
        <div ref={box} className="call-pop call-reacts" role="group" aria-label="Reactions">
          {REACTIONS.map((e) => (
            <button key={e} type="button" className="call-react-btn" onClick={() => send(e)} title={REACTION_LABELS[e]} aria-label={REACTION_LABELS[e]}>
              {e}
            </button>
          ))}
          {note && <span className="call-dim call-react-note" role="status">{note}</span>}
        </div>
      )}
    </>
  );
}

function DeviceMenu({ call }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  const box = usePopover(open, setOpen, anchor);
  return (
    <>
      <button ref={anchor} type="button" className="call-ctl" onClick={() => setOpen((v) => !v)} title="Audio and video settings" aria-label="Audio and video settings" aria-expanded={open} aria-haspopup="dialog">
        <CallIcon name="gear" />
      </button>
      {open && (
        <div ref={box} className="call-pop call-devices" role="dialog" aria-label="Audio and video settings">
          <DeviceForm mode="call" call={call} />
          <button type="button" className="btn sm" onClick={() => { setOpen(false); anchor.current?.focus(); }}>
            Done
          </button>
        </div>
      )}
    </>
  );
}

export function CallControls({ call, onMinimize }) {
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
  const handUp = call.hands.some((h) => h.uid === call.me);
  return (
    <div className="call-controls">
      {err && <div className="call-error" role="alert">{err}</div>}
      <div className="call-controls-row">
        <button type="button" className={`call-ctl ${call.mic ? '' : 'off'}`} onClick={run(callActions.toggleMic)} disabled={!live} aria-pressed={!call.mic} title={call.mic ? 'Mute' : 'Unmute'} aria-label="Mute">
          <CallIcon name={call.mic ? 'mic' : 'micOff'} />
        </button>
        {call.ptt && <PttButton call={call} />}
        <button type="button" className={`call-ctl ${call.deafened ? 'off' : ''}`} onClick={run(callActions.toggleDeafen)} disabled={!live} aria-pressed={call.deafened} title={call.deafened ? 'Undeafen' : 'Deafen'} aria-label="Deafen">
          <CallIcon name={call.deafened ? 'headsetOff' : 'headset'} />
        </button>
        <button type="button" className={`call-ctl ${call.camOn ? 'on' : ''}`} onClick={run(callActions.toggleCam)} disabled={!live} aria-pressed={call.camOn} title={call.camPending ? 'Camera starting… (click to cancel)' : call.camOn ? 'Turn camera off' : 'Turn camera on'} aria-label="Camera">
          <CallIcon name={call.camOn || call.camPending ? 'video' : 'videoOff'} />
        </button>
        {screenShareSupported() && (
          <button type="button" className={`call-ctl ${call.screenOn ? 'on' : ''}`} onClick={run(callActions.toggleScreen)} disabled={!live} aria-pressed={call.screenOn} title={call.screenOn ? 'Stop sharing' : 'Share screen'} aria-label="Share screen">
            <CallIcon name="screen" />
          </button>
        )}
        <button type="button" className={`call-ctl ${handUp ? 'on' : ''}`} onClick={() => callActions.raiseHand()} disabled={!live} aria-pressed={handUp} title={handUp ? 'Lower hand' : 'Raise hand'} aria-label="Raise hand">
          <span aria-hidden="true" className="call-ctl-emoji">✋</span>
        </button>
        <ReactionPicker disabled={!live} />
        <DeviceMenu call={call} />
        {onMinimize && (
          <button type="button" className="call-ctl" onClick={onMinimize} title="Back to chat (the call continues)" aria-label="Minimize call">
            <CallIcon name="minimize" />
          </button>
        )}
        <button type="button" className="call-ctl hangup" onClick={run(callActions.leave)} title="Leave call" aria-label="Leave call">
          <CallIcon name="hangup" />
        </button>
      </div>
    </div>
  );
}

function CallPeople({ call, uids, profiles, bySlot, peers, onClose }) {
  const handOrder = new Map(call.hands.map((h, i) => [h.uid, i + 1]));
  const raised = call.hands.filter((h) => uids.includes(h.uid));
  const rest = uids.filter((u) => !handOrder.has(u));
  const row = (uid) => {
    const isMe = uid === call.me;
    const slot = bySlot.get(uid);
    const status = isMe ? (call.rejoining ? 'reconnecting' : 'connected') : peers.get(uid)?.status || 'connecting';
    return (
      <li key={uid} className={`call-person ${call.speaking.has(uid) ? 'speaking' : ''}`} data-uid={uid}>
        <Avatar profile={profiles[uid]} size={28} ring={call.speaking.has(uid) ? 'var(--ok)' : undefined} />
        <span className="call-person-name">{isMe ? `${profiles[uid]?.name || 'You'} (you)` : profiles[uid]?.name || 'Someone'}</span>
        {handOrder.has(uid) && <span className="call-person-hand" title="Hand raised">✋ {handOrder.get(uid)}</span>}
        {slot && !slot.mic && <CallIcon name="micOff" size={13} title="Muted" />}
        {status !== 'connected' && <span className={`call-person-state ${status}`}>{status === 'failed' ? 'Couldn’t connect' : STATUS_TEXT[status]}</span>}
      </li>
    );
  };
  return (
    <aside className="call-people" aria-label="People in this call">
      <div className="call-people-head">
        <h3>People · {uids.length}</h3>
        <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close people list">
          ✕
        </button>
      </div>
      {raised.length > 0 && (
        <>
          <h4>Raised hands</h4>
          <ol className="call-people-list raised">{raised.map((h) => row(h.uid))}</ol>
          {rest.length > 0 && <h4>Everyone else</h4>}
        </>
      )}
      <ul className="call-people-list">{rest.map(row)}</ul>
    </aside>
  );
}

/** Announcements for screen readers: raised hands and people joining or leaving. */
function useAnnouncements(call, uids, profiles) {
  const [text, setText] = useState('');
  const prevHands = useRef(null);
  const prevUids = useRef(null);
  const handKey = call ? call.hands.map((h) => h.uid).join(',') : '';
  const uidKey = uids.join(',');
  useEffect(() => {
    if (!call) return;
    const name = (u) => (u === call.me ? 'You' : profiles[u]?.name || 'Someone');
    const hands = new Set(call.hands.map((h) => h.uid));
    const now = new Set(uids);
    const msgs = [];
    if (prevHands.current) for (const u of hands) if (!prevHands.current.has(u)) msgs.push(`${name(u)} raised a hand`);
    if (prevUids.current) {
      for (const u of now) if (!prevUids.current.has(u)) msgs.push(`${name(u)} joined`);
      for (const u of prevUids.current) if (!now.has(u)) msgs.push(`${name(u)} left`);
    }
    prevHands.current = hands;
    prevUids.current = now;
    if (msgs.length) setText(msgs.join('. '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handKey, uidKey]);
  return text;
}

/** Props: `title` (string shown in the header), `onMinimize()` (return to chat; MiniCallBar takes over). */
export default function CallView({ title, onMinimize }) {
  const call = useActiveCall();
  const viewRef = useRef(null);
  const pipVideo = useRef(null);
  const [spot, setSpot] = useState(null); // { uid, auto }
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [fs, setFs] = useState(false);
  const [pip, setPip] = useState(false);
  const slots = Object.values(call?.slots || {}).filter((s) => s?.uid);
  const uids = call ? [call.me, ...slots.map((s) => s.uid).filter((u) => u !== call.me)] : [];
  const profiles = useProfiles(call ? uids : []);
  const announcement = useAnnouncements(call, uids, profiles);

  // Remote screen shares take the spotlight when they start; an automatic spotlight ends with the share.
  const screens = slots.filter((s) => s.screen && s.uid !== call?.me).map((s) => s.uid).sort().join(',');
  const prevScreens = useRef('');
  useEffect(() => {
    const before = new Set(prevScreens.current ? prevScreens.current.split(',') : []);
    const now = screens ? screens.split(',') : [];
    prevScreens.current = screens;
    const started = now.filter((u) => !before.has(u));
    if (started.length) setSpot({ uid: started[started.length - 1], auto: true });
    else setSpot((s) => (s?.auto && !now.includes(s.uid) ? null : s));
  }, [screens]);

  useEffect(() => {
    const on = () => setFs(!!viewRef.current && document.fullscreenElement === viewRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const reactionsBy = useMemo(() => {
    const m = new Map();
    for (const r of call?.reactions || []) m.set(r.uid, [...(m.get(r.uid) || []), r]);
    return m;
  }, [call?.reactions]);

  if (!call) return null;
  if (call.status === 'ended' || call.status === 'error') {
    return (
      <div className="call-view ended">
        <p role={call.status === 'error' ? 'alert' : 'status'}>{call.status === 'error' ? call.error || 'The call failed' : 'Call ended'}</p>
        <button type="button" className="btn" onClick={() => { callActions.dismiss(); onMinimize?.(); }}>
          Close
        </button>
      </div>
    );
  }
  const bySlot = new Map(slots.map((s) => [s.uid, s]));
  const peers = new Map(call.peers.map((p) => [p.uid, p]));
  const handOrder = new Map(call.hands.map((h, i) => [h.uid, i + 1]));
  const n = uids.length;
  const spotUid = spot && uids.includes(spot.uid) ? spot.uid : null;

  const tile = (uid, size) => (
    <CallTile
      key={uid}
      uid={uid}
      isMe={uid === call.me}
      profile={profiles[uid]}
      slot={bySlot.get(uid) || (uid === call.me ? { mic: call.mic, cam: call.camOn, screen: call.screenOn } : null)}
      speaking={call.speaking.has(uid)}
      stream={peers.get(uid)?.stream}
      tracks={peers.get(uid)?.tracks}
      status={uid === call.me ? null : peers.get(uid)?.status || 'connecting'}
      rejoining={uid === call.me && call.rejoining}
      localTrack={uid === call.me ? call.localVideo : null}
      hand={handOrder.get(uid) || 0}
      reactions={reactionsBy.get(uid)}
      selected={spotUid === uid}
      onSelect={() => setSpot(spotUid === uid ? null : { uid, auto: false })}
      size={size}
      videoRef={size === 'main' ? pipVideo : undefined}
    />
  );

  const spotSlot = spotUid ? bySlot.get(spotUid) : null;
  const spotHasVideo = !!spotUid && (spotUid === call.me ? !!call.localVideo : !!(spotSlot?.cam || spotSlot?.screen));
  const canPip = typeof document !== 'undefined' && !!document.pictureInPictureEnabled && spotHasVideo;
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPip(false);
      } else if (pipVideo.current) {
        const v = pipVideo.current;
        v.addEventListener('leavepictureinpicture', () => setPip(false), { once: true });
        await v.requestPictureInPicture();
        setPip(true);
      }
    } catch {
      setPip(false);
    }
  };
  const fsOk = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else viewRef.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <section ref={viewRef} className={`call-view ${spotUid ? 'spotlight' : ''} ${fs ? 'fullscreen' : ''}`} aria-label="Call">
      <header className="call-head">
        <CallIcon name={call.kind === 'video' ? 'video' : 'phone'} size={16} />
        <strong className="call-title">{title || 'Call'}</strong>
        <span className="call-dim">{call.status === 'joining' ? 'Joining…' : call.rejoining ? 'Reconnecting…' : `${n} in call`}</span>
        {call.ptt && call.status === 'live' && (
          <span className={`call-ptt-tag ${call.transmitting ? 'on' : ''}`}>
            {call.transmitting ? 'Talking' : `Push-to-talk: hold ${keyLabel(call.devices?.pttKey)}`}
          </span>
        )}
        <span className="call-head-tools">
          <button type="button" className={`btn ghost sm ${peopleOpen ? 'active' : ''}`} onClick={() => setPeopleOpen((v) => !v)} aria-expanded={peopleOpen} title="People">
            <CallIcon name="people" size={16} />
            <span className="call-sr">People</span>
            <span>{n}</span>
            {call.hands.length > 0 && <span className="call-head-hands">✋{call.hands.length}<span className="call-sr"> raised</span></span>}
          </button>
          {fsOk && (
            <button type="button" className="btn ghost sm" onClick={toggleFs} aria-pressed={fs} aria-label={fs ? 'Exit full screen' : 'Full screen'} title={fs ? 'Exit full screen' : 'Full screen'}>
              <CallIcon name={fs ? 'shrink' : 'expand'} size={16} />
            </button>
          )}
        </span>
      </header>
      {call.error && call.status === 'live' && <div className="call-notice" role="status">{call.error}</div>}
      <div className="call-body">
        <div className="call-stage">
          {spotUid ? (
            <>
              <div className="call-spot-main">
                {tile(spotUid, 'main')}
                <div className="call-spot-tools">
                  {canPip && (
                    <button type="button" className="btn sm" onClick={togglePip} aria-pressed={pip}>
                      {pip ? 'Close picture-in-picture' : 'Picture-in-picture'}
                    </button>
                  )}
                  <button type="button" className="btn sm" onClick={() => setSpot(null)}>
                    Back to grid
                  </button>
                </div>
              </div>
              {n > 1 && (
                <div className="call-strip" role="group" aria-label="Other participants">
                  {uids.filter((u) => u !== spotUid).map((u) => tile(u, 'strip'))}
                </div>
              )}
            </>
          ) : (
            <div className={`call-grid n${Math.min(n, 6)}`}>{uids.map((u) => tile(u, 'grid'))}</div>
          )}
        </div>
        {peopleOpen && <CallPeople call={call} uids={uids} profiles={profiles} bySlot={bySlot} peers={peers} onClose={() => setPeopleOpen(false)} />}
      </div>
      <CallControls call={call} onMinimize={onMinimize} />
      <div className="call-sr" aria-live="polite">
        {announcement}
      </div>
    </section>
  );
}

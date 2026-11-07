// Voice message player (round 3, messaging): play/pause, scrub over the waveform, elapsed / total time
// and playback speed. The encrypted audio is fetched and decrypted only on the first play (never on
// scroll), then cached as an object URL like images. Only one voice message plays at a time.
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAudio } from '../../lib/media/attachments.js';
import { cleanAudioAtt, decodeWave, formatDuration } from '../../lib/media/audio.js';

const SPEEDS = [1, 1.5, 2];
let playingEl = null; // the <audio> currently playing anywhere in the app

/**
 * Generic player. Either `src` (a ready object URL, e.g. a local preview) or `load()` resolving one.
 * `dur` (seconds) and `wave` (hex bars) come from the message body, so nothing is downloaded to draw it.
 */
export function VoicePlayer({ src: givenSrc = null, load, dur = 0, wave = '', label = 'Voice message', compact = false }) {
  const audio = useRef(null);
  const [src, setSrc] = useState(givenSrc);
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [mediaDur, setMediaDur] = useState(0);
  const pendingSeek = useRef(null);
  const wantPlay = useRef(false);
  const bars = decodeWave(wave);
  const total = Number.isFinite(mediaDur) && mediaDur > 0 ? mediaDur : Number(dur) || 0;

  useEffect(() => setSrc(givenSrc), [givenSrc]);

  useEffect(() => () => {
    const el = audio.current;
    if (el && playingEl === el) playingEl = null;
    el?.pause?.();
  }, []);

  const ensureSrc = useCallback(async () => {
    if (src) return src;
    if (typeof load !== 'function') return null;
    setState('loading');
    setError('');
    try {
      const url = await load();
      setSrc(url);
      setState('ready');
      return url;
    } catch (e) {
      setState('error');
      setError(e?.message || 'Could not load the voice message');
      return null;
    }
  }, [src, load]);

  // Once a freshly loaded source is attached, apply a pending seek and start playing if asked.
  useEffect(() => {
    const el = audio.current;
    if (!el || !src) return;
    el.playbackRate = speed;
    if (pendingSeek.current != null) {
      try {
        el.currentTime = pendingSeek.current;
      } catch {
        /* not seekable yet */
      }
      pendingSeek.current = null;
    }
    if (wantPlay.current) {
      wantPlay.current = false;
      play(el);
    }
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  function play(el) {
    if (playingEl && playingEl !== el) playingEl.pause();
    playingEl = el;
    el.playbackRate = speed;
    el.play().catch((e) => {
      if (e?.name === 'NotSupportedError') {
        setState('error');
        setError('This browser can’t play this recording format.');
      }
    });
  }

  const toggle = async () => {
    const el = audio.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    if (!src) {
      wantPlay.current = true;
      await ensureSrc();
      return;
    }
    if (total && el.currentTime >= total - 0.05) el.currentTime = 0;
    play(el);
  };

  const seek = async (t) => {
    const v = Math.max(0, Math.min(total || 0, t));
    setCur(v);
    const el = audio.current;
    if (!src) {
      pendingSeek.current = v;
      await ensureSrc();
      return;
    }
    if (el) {
      try {
        el.currentTime = v;
      } catch {
        /* ignore */
      }
    }
  };

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  const pct = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
  const busy = state === 'loading';
  return (
    <div className={`md-voice${compact ? ' compact' : ''}${playing ? ' playing' : ''}`} role="group" aria-label={label}>
      <button
        type="button"
        className="md-voice-play"
        onClick={toggle}
        disabled={busy || state === 'error'}
        aria-label={playing ? `Pause ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`}
        title={playing ? 'Pause' : 'Play'}
      >
        {busy ? <span className="spinner md-voice-spin" aria-hidden="true" /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="md-voice-track">
        <div className="md-voice-bars" aria-hidden="true">
          {(bars.length ? bars : new Array(32).fill(0.15)).map((h, i, arr) => (
            <span
              key={i}
              className={(i + 0.5) / arr.length * 100 <= pct ? 'on' : ''}
              style={{ height: `${Math.max(12, Math.round(h * 100))}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          className="md-voice-range"
          min={0}
          max={Math.max(0.1, total)}
          step={0.1}
          value={Math.min(cur, Math.max(0.1, total))}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek"
          aria-valuetext={`${formatDuration(cur)} of ${formatDuration(total)}`}
          disabled={state === 'error'}
        />
      </div>
      <span className="md-voice-time" aria-live="off">
        {playing || cur > 0 ? formatDuration(cur) : formatDuration(total)}
      </span>
      <button type="button" className="md-voice-speed" onClick={cycleSpeed} aria-label={`Playback speed ${speed}×`} title="Playback speed">
        {speed}×
      </button>
      {state === 'error' && <span className="md-error md-voice-err" role="alert">{error}</span>}
      <audio
        ref={audio}
        src={src || undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCur(total);
        }}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onDurationChange={(e) => setMediaDur(e.currentTarget.duration)}
        onError={() => {
          if (!src) return;
          setState('error');
          setError('This browser can’t play this recording format.');
        }}
        hidden
      />
    </div>
  );
}

/** A voice message attachment of a message (validated body entry). */
export function AudioAttachment({ scope, att }) {
  const clean = cleanAudioAtt(att);
  const load = useCallback(() => loadAudio(scope, clean), [scope, clean?.attId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!clean) return null;
  return <VoicePlayer load={load} dur={clean.dur} wave={clean.wave || ''} />;
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="4.5" height="16" rx="1.2" />
      <rect x="13.5" y="4" width="4.5" height="16" rx="1.2" />
    </svg>
  );
}

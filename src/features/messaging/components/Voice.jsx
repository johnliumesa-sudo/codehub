// Voice messages: the composer's microphone button and the recorder card (shown above the composer as
// a local-only notice while recording and reviewing). Recording uses MediaRecorder (WebM/Ogg Opus, or
// MP4/AAC on Safari) up to 60 s at 32 kbit/s; the clip is encrypted and chunked like an image
// (lib/media/attachments.js uploadAudio) and sent as a message whose only attachment is the clip.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useChatCtx } from '../../../lib/ext/chatContext.js';
import { uploadAudio } from '../../../lib/media/attachments.js';
import {
  AUDIO_BITRATE, AUDIO_MAX_SECONDS, encodeWave, formatDuration, peaksFromSamples, pickRecorderType, recordingProblem, rmsLevel,
} from '../../../lib/media/audio.js';
import { VoicePlayer } from '../../../components/media/AudioAttachment.jsx';

// ---------- one recorder at a time ----------
let active = 0;
const activeListeners = new Set();
function setActive(delta) {
  active = Math.max(0, active + delta);
  activeListeners.forEach((fn) => fn());
}
const useRecorderActive = () => useSyncExternalStore(
  (fn) => {
    activeListeners.add(fn);
    return () => activeListeners.delete(fn);
  },
  () => active > 0,
  () => active > 0,
);

export function recordingSupported() {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder === 'function'
    && !!navigator.mediaDevices?.getUserMedia
    && !!pickRecorderType((t) => window.MediaRecorder.isTypeSupported?.(t));
}

/** composerButtons render entry: opens the recorder card. */
export function VoiceButton({ ctx }) {
  const busy = useRecorderActive();
  if (!recordingSupported()) return null;
  const open = () => {
    let dismiss = null;
    dismiss = ctx.ephemeral({
      id: 'messaging.voice',
      title: 'Voice message',
      render: () => <VoiceRecorder onClose={() => dismiss?.()} />,
    });
  };
  return (
    <button
      type="button"
      className="composer-btn ext-composer-btn mx-voice-btn"
      title={busy ? 'Recording…' : 'Record a voice message'}
      aria-label="Record a voice message"
      disabled={!ctx.canSend || busy}
      onClick={open}
    >
      <MicIcon />
    </button>
  );
}

function micError(e) {
  const n = e?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone access is blocked. Allow it for this site in your browser settings, then try again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone was found.';
  if (n === 'NotReadableError') return 'The microphone is in use by another app.';
  return e?.message || 'Could not start recording.';
}

/** The recorder card. Lives inside ChatView (ephemeral notice), so it reads the live ChatContext. */
export function VoiceRecorder({ onClose }) {
  const ctx = useChatCtx();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [phase, setPhase] = useState('starting'); // starting | recording | review | sending | error
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState([]);
  const [clip, setClip] = useState(null); // { blob, url, mime, dur, wave }
  const [progress, setProgress] = useState(0);
  const r = useRef({ alive: true });
  const stopBtn = useRef(null);
  const sendBtn = useRef(null);

  const release = () => {
    const s = r.current;
    clearInterval(s.timer);
    s.timer = null;
    s.stream?.getTracks().forEach((t) => t.stop());
    s.stream = null;
  };

  const start = async () => {
    const s = r.current;
    setError('');
    setPhase('starting');
    setElapsed(0);
    setLive([]);
    const pick = pickRecorderType((t) => window.MediaRecorder?.isTypeSupported?.(t));
    if (!pick || !navigator.mediaDevices?.getUserMedia) {
      setPhase('error');
      setError('Voice recording isn’t supported in this browser.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (s.alive) {
        setPhase('error');
        setError(micError(e));
      }
      return;
    }
    if (!s.alive) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    s.stream = stream;
    s.mime = pick.mime;
    s.chunks = [];
    s.levels = [];
    s.cancelled = false;
    s.sendAfter = false;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        s.ac = s.ac && s.ac.state !== 'closed' ? s.ac : new AC();
        const src = s.ac.createMediaStreamSource(stream);
        s.analyser = s.ac.createAnalyser();
        s.analyser.fftSize = 1024;
        src.connect(s.analyser);
        s.buf = new Uint8Array(s.analyser.fftSize);
      }
    } catch {
      s.analyser = null;
    }
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: pick.type, audioBitsPerSecond: AUDIO_BITRATE });
    } catch {
      rec = new MediaRecorder(stream);
    }
    s.recorder = rec;
    rec.ondataavailable = (e) => {
      if (e.data?.size) s.chunks.push(e.data);
    };
    rec.onstop = () => finish();
    rec.start(250);
    s.t0 = performance.now();
    setPhase('recording');
    s.timer = setInterval(() => {
      const sec = (performance.now() - s.t0) / 1000;
      if (s.analyser) {
        s.analyser.getByteTimeDomainData(s.buf);
        s.levels.push(rmsLevel(s.buf));
        setLive(s.levels.slice(-40));
      }
      setElapsed(sec);
      if (sec >= AUDIO_MAX_SECONDS) stop(false);
    }, 100);
  };

  const stop = (sendAfter) => {
    const s = r.current;
    if (!s.recorder || s.recorder.state === 'inactive') return;
    s.sendAfter = !!sendAfter;
    s.dur = Math.min(AUDIO_MAX_SECONDS, (performance.now() - s.t0) / 1000);
    clearInterval(s.timer);
    s.timer = null;
    try {
      s.recorder.requestData?.();
    } catch {
      /* ignore */
    }
    s.recorder.stop();
  };

  const finish = async () => {
    const s = r.current;
    release();
    if (s.cancelled || !s.alive) return;
    const mime = (s.recorder?.mimeType || s.mime || '').split(';')[0] || s.mime;
    const blob = new Blob(s.chunks, { type: mime });
    let dur = s.dur || 0;
    let peaks = s.levels;
    try {
      if (s.ac) {
        const decoded = await s.ac.decodeAudioData((await blob.arrayBuffer()).slice(0));
        if (Number.isFinite(decoded.duration) && decoded.duration > 0) dur = Math.min(AUDIO_MAX_SECONDS, decoded.duration);
        peaks = peaksFromSamples(decoded.getChannelData(0), 240);
      }
    } catch {
      /* keep the live levels */
    }
    if (!s.alive) return;
    const problem = recordingProblem({ size: blob.size, dur, mime });
    if (problem) {
      setPhase('error');
      setError(problem);
      return;
    }
    const next = { blob, url: URL.createObjectURL(blob), mime, dur, wave: encodeWave(peaks) };
    s.url = next.url;
    setClip(next);
    if (s.sendAfter) send(next);
    else setPhase('review');
  };

  const send = async (c = clip) => {
    if (!c) return;
    const cur = ctxRef.current;
    setPhase('sending');
    setError('');
    setProgress(0);
    try {
      const att = await uploadAudio(cur.conv, c.blob, { mime: c.mime, dur: c.dur, wave: c.wave, onProgress: (p) => r.current.alive && setProgress(p) });
      const ok = await ctxRef.current.send({ text: '', attachments: [att] });
      if (!r.current.alive) return;
      if (ok) onClose?.();
      else {
        setPhase('review');
        setError('The voice message wasn’t sent.');
      }
    } catch (e) {
      if (!r.current.alive) return;
      setPhase('review');
      setError(e?.message || 'Upload failed');
    }
  };

  const cancel = () => {
    const s = r.current;
    s.cancelled = true;
    if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
    release();
    onClose?.();
  };

  const again = () => {
    if (r.current.url) URL.revokeObjectURL(r.current.url);
    r.current.url = null;
    setClip(null);
    start();
  };

  useEffect(() => {
    const s = r.current;
    s.alive = true;
    setActive(1);
    start();
    return () => {
      s.alive = false;
      s.cancelled = true;
      try {
        if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
      } catch {
        /* ignore */
      }
      release();
      s.ac?.close?.().catch?.(() => {});
      if (s.url) URL.revokeObjectURL(s.url);
      setActive(-1);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase === 'recording') stopBtn.current?.focus();
    if (phase === 'review') sendBtn.current?.focus();
  }, [phase]);

  const left = Math.max(0, AUDIO_MAX_SECONDS - elapsed);
  return (
    <div className="mx-rec" data-phase={phase}>
      {phase === 'starting' && <p className="mx-rec-status" role="status">Waiting for the microphone…</p>}
      {phase === 'recording' && (
        <div className="mx-rec-row">
          <span className="mx-rec-dot" aria-hidden="true" />
          <span className="mx-rec-time" role="timer" aria-label={`Recording, ${formatDuration(elapsed)} of ${formatDuration(AUDIO_MAX_SECONDS)}`}>
            {formatDuration(elapsed)} / {formatDuration(AUDIO_MAX_SECONDS)}
          </span>
          <span className="mx-rec-live" aria-hidden="true">
            {Array.from({ length: 40 }, (_, i) => {
              const v = live[live.length - 40 + i] ?? 0;
              return <span key={i} style={{ height: `${Math.max(8, Math.round(v * 100))}%` }} />;
            })}
          </span>
          {left <= 10 && <span className="mx-rec-left" role="status">{Math.ceil(left)} s left</span>}
        </div>
      )}
      {(phase === 'review' || phase === 'sending') && clip && (
        <VoicePlayer src={clip.url} dur={clip.dur} wave={clip.wave} label="Recorded voice message" compact />
      )}
      {phase === 'sending' && (
        <div className="mx-rec-progress" role="progressbar" aria-label="Uploading voice message" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {error && <p className="mx-rec-error" role="alert">{error}</p>}
      <div className="mx-rec-actions">
        {phase === 'recording' && (
          <>
            <button type="button" className="btn ghost sm" onClick={cancel}>Cancel</button>
            <button type="button" className="btn sm" ref={stopBtn} onClick={() => stop(false)}>Stop</button>
            <button type="button" className="btn primary sm" onClick={() => stop(true)}>Send</button>
          </>
        )}
        {phase === 'review' && (
          <>
            <button type="button" className="btn ghost sm" onClick={cancel}>Discard</button>
            <button type="button" className="btn ghost sm" onClick={again}>Record again</button>
            <button type="button" className="btn primary sm" ref={sendBtn} onClick={() => send()} disabled={!ctx?.canSend}>Send</button>
          </>
        )}
        {phase === 'sending' && <span className="muted mx-rec-status">Encrypting and uploading…</span>}
        {(phase === 'starting' || phase === 'error') && (
          <>
            <button type="button" className="btn ghost sm" onClick={cancel}>{phase === 'error' ? 'Close' : 'Cancel'}</button>
            {phase === 'error' && <button type="button" className="btn sm" onClick={again}>Try again</button>}
          </>
        )}
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

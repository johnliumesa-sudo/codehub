// Media helpers: local capture, screen share, devices, level metering, speaking detection, ringtone and
// test sound (WebAudio). Preferences live in ./prefs.js.
import { audioConstraints, loadPrefs } from './prefs.js';

export const mediaSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
export const screenShareSupported = () => !!navigator.mediaDevices?.getDisplayMedia;
export const sinkSupported = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const videoConstraint = (id) => ({ width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, ...(id ? { deviceId: { exact: id } } : {}) });

/**
 * Microphone stream with the echo cancellation / noise suppression / auto gain switches from `prefs`
 * (default: the saved prefs). Falls back to the default device when the saved one is gone.
 */
export async function getMic(deviceId, prefs = loadPrefs()) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(prefs, deviceId) });
  } catch (e) {
    if (deviceId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(prefs, '') });
      } catch (e2) {
        throw friendlyMediaError(e2, 'microphone');
      }
    }
    throw friendlyMediaError(e, 'microphone');
  }
}

/** Camera video track, or throws a friendly error. */
export async function getCameraTrack(deviceId) {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint(deviceId) });
    return s.getVideoTracks()[0];
  } catch (e) {
    if (deviceId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraint() });
        return s.getVideoTracks()[0];
      } catch (e2) {
        throw friendlyMediaError(e2, 'camera');
      }
    }
    throw friendlyMediaError(e, 'camera');
  }
}

export async function getScreenTrack() {
  if (!screenShareSupported()) throw new Error('Screen sharing is not supported in this browser');
  const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
  const t = s.getVideoTracks()[0];
  if (t && 'contentHint' in t) t.contentHint = 'detail';
  return t;
}

export function friendlyMediaError(e, what) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return new Error(`Permission to use your ${what} was denied`);
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return new Error(`No ${what} found`);
  if (n === 'NotReadableError') return new Error(`Your ${what} is in use by another app`);
  return new Error(e?.message || `Could not start your ${what}`);
}

/** `{ audioIn, videoIn, audioOut }` lists of `{ deviceId, label }`. */
export async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { audioIn: [], videoIn: [], audioOut: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind, fallback) =>
    all.filter((d) => d.kind === kind && d.deviceId).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return { audioIn: pick('audioinput', 'Microphone'), videoIn: pick('videoinput', 'Camera'), audioOut: pick('audiooutput', 'Speaker') };
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// ---------- Shared AudioContext ----------

let ctx = null;
export function audioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx || ctx.state === 'closed') ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// ---------- Speaking detection ----------

/** Speaking threshold: RMS level, linear 0..1 of full scale (about -29 dBFS). */
export const SPEAK_THRESHOLD = 0.035;
/** The ring stays on this long after the last level above the threshold. */
export const SPEAK_HOLD_MS = 350;

/**
 * Turns level samples into speaking on/off: on while a sample above `threshold` was seen within the
 * last `holdMs`. Returns `(level, now) => void`; calls `onChange(speaking)` on transitions.
 */
export function speakingGate(onChange, { threshold = SPEAK_THRESHOLD, holdMs = SPEAK_HOLD_MS } = {}) {
  let speaking = false;
  let lastLoud = -Infinity;
  return (level, now) => {
    if (level > threshold) lastLoud = now;
    const next = now - lastLoud < holdMs;
    if (next !== speaking) {
      speaking = next;
      onChange(next);
    }
  };
}

/**
 * Watch a stream's audio level with Web Audio (my own microphone; the last resort for remote peers);
 * calls `onChange(speaking)` on transitions. Returns a stop fn. Polls an AnalyserNode at ~7 Hz (cheap; no
 * requestAnimationFrame so it works in background tabs). Each poll sees only the last ~11 ms, so sounds
 * much shorter than the poll interval can be missed.
 */
export function watchSpeaking(stream, onChange, { threshold = SPEAK_THRESHOLD, holdMs = SPEAK_HOLD_MS } = {}) {
  const ac = audioContext();
  if (!ac || !stream?.getAudioTracks().length) return () => {};
  let src;
  try {
    src = ac.createMediaStreamSource(stream);
  } catch {
    return () => {};
  }
  const an = ac.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const gate = speakingGate(onChange, { threshold, holdMs });
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    gate(Math.sqrt(sum / buf.length), performance.now());
  }, 140);
  return () => {
    clearInterval(timer);
    try {
      src.disconnect();
      an.disconnect();
    } catch {
      // already disconnected
    }
  };
}

const SSRC_POLL_MS = 40; // about every other 20 ms packet: a sound of ~40 ms or more is never skipped
const STATS_POLL_MS = 140;
const SSRC_STALE_MS = 500;

/**
 * Level (linear 0..1) of the newest audio `receiver` played, from getSynchronizationSources(): the RTP
 * audio-level header (RFC 6464) of the latest packet, i.e. that packet's RMS relative to full scale, the
 * same scale as watchSpeaking's analyser. A source entry lingers for 10 s after its last packet, so the
 * level counts only while new audio keeps arriving (`mem` remembers what was seen and when). Returns 0
 * before any audio, null when packets carry no level (the header extension wasn't negotiated).
 */
export function ssrcLevel(receiver, mem, now) {
  let latest = null;
  for (const s of receiver.getSynchronizationSources() || []) {
    if (!latest || s.timestamp > latest.timestamp) latest = s;
  }
  if (!latest) return 0;
  if (typeof latest.audioLevel !== 'number') return null;
  const key = `${latest.source}/${latest.timestamp}/${latest.rtpTimestamp}`;
  if (key !== mem.ssrcKey) {
    mem.ssrcKey = key;
    mem.ssrcAt = now;
  }
  return now - mem.ssrcAt < SSRC_STALE_MS ? latest.audioLevel : 0;
}

/**
 * Level from a receiver's stats report (inbound-rtp audio): the RMS over the time since the previous
 * report from totalAudioEnergy / totalSamplesDuration (the stats spec's recipe, so nothing between two
 * polls is missed), else the current audioLevel. Returns 0 before any audio, null when the report has
 * no level at all.
 */
export function statsLevel(report, mem) {
  let r = null;
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'audio') r = s;
  });
  if (!r) return 0;
  const e = r.totalAudioEnergy;
  const d = r.totalSamplesDuration;
  const energy = typeof e === 'number' && typeof d === 'number';
  if (energy) {
    const prev = mem.energy;
    mem.energy = { e, d };
    if (prev && d > prev.d) return Math.sqrt(Math.max(0, e - prev.e) / (d - prev.d));
    if (prev && d === prev.d) return 0; // no new audio since the last poll
  }
  if (typeof r.audioLevel === 'number') return r.audioLevel;
  return energy ? 0 : null;
}

/**
 * Speaking detection for a REMOTE peer from the levels the browser itself measures for the audio
 * `receiver` (RTCRtpReceiver) plays, best first:
 *   1. getSynchronizationSources() audioLevel (ssrcLevel), read every 40 ms: a cheap synchronous read
 *      of state the browser keeps anyway, often enough that short sounds are not skipped;
 *   2. getStats() inbound-rtp (statsLevel), every 140 ms;
 *   3. Web Audio analysis of the track (watchSpeaking).
 * 1 and 2 need no AudioContext (it may be suspended, and a remote track feeds it only while an element
 * plays it). Same threshold and hold as watchSpeaking. Reads local state only: nothing is sent.
 * Calls `onChange(speaking)` on transitions; returns a stop fn.
 */
export function watchRemoteSpeaking(receiver, onChange, { threshold = SPEAK_THRESHOLD, holdMs = SPEAK_HOLD_MS, now = () => performance.now() } = {}) {
  if (!receiver) return () => {};
  let speaking = false;
  const emit = (on) => {
    if (on === speaking) return;
    speaking = on;
    onChange(on);
  };
  const gate = speakingGate(emit, { threshold, holdMs });
  const mem = {};
  let mode = typeof receiver.getSynchronizationSources === 'function' ? 'ssrc' : typeof receiver.getStats === 'function' ? 'stats' : 'analyser';
  let stopped = false;
  let timer = null;
  let stopAnalyser = null;
  let misses = 0; // consecutive SSRC reads without a level
  let pending = false;
  let lastStats = -Infinity;

  const useAnalyser = () => {
    mode = 'analyser';
    clearInterval(timer);
    emit(false);
    const { track } = receiver;
    if (track && typeof MediaStream === 'function') stopAnalyser = watchSpeaking(new MediaStream([track]), emit, { threshold, holdMs });
  };
  const pollStats = (t) => {
    if (pending || t - lastStats < STATS_POLL_MS) return;
    pending = true;
    lastStats = t;
    new Promise((resolve) => resolve(receiver.getStats())).then((report) => {
      pending = false;
      if (stopped || mode !== 'stats') return;
      const level = statsLevel(report, mem);
      if (level === null) useAnalyser();
      else gate(level, now());
    }, () => {
      pending = false;
      if (!stopped && mode === 'stats') useAnalyser();
    });
  };
  const poll = () => {
    if (stopped) return;
    const t = now();
    if (mode === 'ssrc') {
      let level = null;
      try {
        level = ssrcLevel(receiver, mem, t);
      } catch {
        // receiver going away: counts as a miss
      }
      if (level !== null) {
        misses = 0;
        gate(level, t);
        return;
      }
      if (++misses < 5) return;
      if (typeof receiver.getStats !== 'function') {
        useAnalyser();
        return;
      }
      mode = 'stats';
    }
    if (mode === 'stats') pollStats(t);
  };

  if (mode === 'analyser') useAnalyser();
  else timer = setInterval(poll, SSRC_POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    stopAnalyser?.();
  };
}

/**
 * Live input level of a stream for meters: calls `onLevel(level)` (0..1, perceptual scale) about 10
 * times a second. Returns a stop fn. Local analysis only.
 */
export function watchLevel(stream, onLevel, { intervalMs = 100 } = {}) {
  const ac = audioContext();
  if (!ac || !stream?.getAudioTracks().length) return () => {};
  let src;
  try {
    src = ac.createMediaStreamSource(stream);
  } catch {
    return () => {};
  }
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // -60 dBFS .. 0 dBFS mapped to 0..1
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    onLevel(Math.max(0, Math.min(1, (db + 60) / 60)));
  }, intervalMs);
  return () => {
    clearInterval(timer);
    try {
      src.disconnect();
      an.disconnect();
    } catch {
      // already disconnected
    }
  };
}

/**
 * Play a short test chime on the chosen speaker (`sinkId`, '' = default). Resolves when it has played;
 * rejects when the output device can't be used.
 */
export async function playTestSound(sinkId = '') {
  const ac = audioContext();
  if (!ac) throw new Error('Audio is not supported in this browser');
  const dest = ac.createMediaStreamDestination();
  const gain = ac.createGain();
  gain.gain.value = 0;
  gain.connect(dest);
  const el = new Audio();
  el.srcObject = dest.stream;
  if (sinkId && typeof el.setSinkId === 'function') await el.setSinkId(sinkId);
  await el.play().catch(() => {});
  const t = ac.currentTime + 0.05;
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(gain);
    const at = t + i * 0.22;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.12, at + 0.02);
    gain.gain.linearRampToValueAtTime(0, at + 0.2);
    o.start(at);
    o.stop(at + 0.21);
  });
  await new Promise((r) => setTimeout(r, 800));
  el.pause();
  el.srcObject = null;
  try {
    gain.disconnect();
  } catch {
    // already gone
  }
}

/** Two-tone ring every 2 s until stopped. Returns a stop fn. */
export function startRingtone({ outgoing = false } = {}) {
  const ac = audioContext();
  if (!ac) return () => {};
  const gain = ac.createGain();
  gain.gain.value = 0;
  gain.connect(ac.destination);
  const beep = (freq, at, dur) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    o.connect(gain);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(outgoing ? 0.05 : 0.09, at + 0.02);
    gain.gain.setValueAtTime(outgoing ? 0.05 : 0.09, at + dur - 0.03);
    gain.gain.linearRampToValueAtTime(0, at + dur);
    o.start(at);
    o.stop(at + dur);
  };
  const ring = () => {
    const t = ac.currentTime + 0.02;
    if (outgoing) beep(440, t, 0.9);
    else {
      beep(880, t, 0.18);
      beep(660, t + 0.22, 0.18);
      beep(880, t + 0.6, 0.18);
      beep(660, t + 0.82, 0.18);
    }
  };
  ring();
  const timer = setInterval(ring, outgoing ? 3000 : 2000);
  return () => {
    clearInterval(timer);
    try {
      gain.disconnect();
    } catch {
      // already gone
    }
  };
}

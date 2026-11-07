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

/**
 * Watch a stream's audio level; calls `onChange(speaking)` on transitions. Returns a stop fn.
 * Polls an AnalyserNode at ~7 Hz (cheap; no requestAnimationFrame so it works in background tabs).
 */
export function watchSpeaking(stream, onChange, { threshold = 0.035, holdMs = 350 } = {}) {
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
  let speaking = false;
  let lastLoud = 0;
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (rms > threshold) lastLoud = now;
    const next = now - lastLoud < holdMs;
    if (next !== speaking) {
      speaking = next;
      onChange(next);
    }
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

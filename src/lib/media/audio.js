// Voice messages (round 3, messaging): pure helpers shared by the recorder, the attachment pipeline
// (attachments.js uploadAudio / loadAudio) and the player. No DOM or Firebase imports, so unit tests
// can load it directly.
//
// A voice message is one entry of body.attachments:
//   { attId, kind: 'audio', mime: 'audio/webm'|'audio/ogg'|'audio/mp4', size <= 512 KB, dur: seconds (<= 60),
//     wave: 48 hex digits (0-f), one per bar }
// It is encrypted and chunked exactly like an image (att/{scope}/{attId}); the encrypted meta holds
// { kind: 'audio', mime, dur, name }.

export const AUDIO_MIMES = Object.freeze(['audio/webm', 'audio/ogg', 'audio/mp4']);
export const AUDIO_MAX_BYTES = 512 * 1024;
export const AUDIO_MAX_SECONDS = 60;
export const AUDIO_MIN_SECONDS = 0.5;
export const AUDIO_BITRATE = 32000; // ~240 KB per minute of Opus, well under the cap
export const WAVE_BARS = 48;

// MediaRecorder types to try, best first. Safari records MP4/AAC; Chrome and Firefox WebM/Ogg Opus.
export const RECORDER_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WAVE_RE = /^[0-9a-f]{1,64}$/;

/** "audio/webm;codecs=opus" -> "audio/webm" (lower case, parameters dropped). */
export function baseMime(type) {
  return String(type || '').split(';')[0].trim().toLowerCase();
}

/** The recorder type to use, or null when nothing we can store is supported. */
export function pickRecorderType(isSupported) {
  for (const t of RECORDER_TYPES) {
    let ok = false;
    try {
      ok = !!isSupported(t);
    } catch {
      ok = false;
    }
    if (ok && AUDIO_MIMES.includes(baseMime(t))) return { type: t, mime: baseMime(t) };
  }
  return null;
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * Resample levels (any length, 0..1 or raw peaks) into `bars` buckets (max per bucket), normalise to
 * the loudest bucket and quantise to one hex digit each. Silence gives all zeros.
 */
export function encodeWave(levels, bars = WAVE_BARS) {
  const src = Array.from(levels || [], (v) => (Number.isFinite(+v) ? Math.abs(+v) : 0));
  const n = Math.max(1, Math.min(64, bars | 0));
  const out = new Array(n).fill(0);
  if (src.length) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i * src.length) / n);
      const b = Math.max(a + 1, Math.floor(((i + 1) * src.length) / n));
      let m = 0;
      for (let j = a; j < b && j < src.length; j++) m = Math.max(m, src[j]);
      out[i] = m;
    }
  }
  const peak = Math.max(...out);
  return out.map((v) => Math.round(clamp01(peak > 0 ? v / peak : 0) * 15).toString(16)).join('');
}

/** Hex wave string -> bar heights 0..1 ([] when malformed). */
export function decodeWave(wave) {
  if (typeof wave !== 'string' || !WAVE_RE.test(wave)) return [];
  return Array.from(wave, (c) => parseInt(c, 16) / 15);
}

/** Peak absolute sample per bucket of decoded PCM data (Float32Array or array). */
export function peaksFromSamples(samples, buckets = 240) {
  const len = samples?.length || 0;
  const n = Math.max(1, buckets | 0);
  const out = new Array(n).fill(0);
  if (!len) return out;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * len) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
    let m = 0;
    // Stride through long buckets: the peak of every 4th sample is plenty for a 48-bar waveform.
    const step = b - a > 4096 ? 4 : 1;
    for (let j = a; j < b; j += step) {
      const v = Math.abs(samples[j]);
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

/** Root-mean-square level of 8-bit time-domain analyser data (128 = silence), 0..1. */
export function rmsLevel(bytes) {
  const len = bytes?.length || 0;
  if (!len) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return clamp01(Math.sqrt(sum / len) * 2.2);
}

/** Validated voice-message attachment entry, or null. Untrusted input (any member writes bodies). */
export function cleanAudioAtt(a) {
  if (!a || typeof a !== 'object' || a.kind !== 'audio') return null;
  if (typeof a.attId !== 'string' || !ID_RE.test(a.attId)) return null;
  if (!AUDIO_MIMES.includes(a.mime)) return null;
  const size = Number(a.size);
  if (!Number.isFinite(size) || size <= 0 || size > AUDIO_MAX_BYTES) return null;
  const dur = Number(a.dur);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  const out = {
    attId: a.attId,
    kind: 'audio',
    mime: a.mime,
    size: Math.round(size),
    dur: Math.round(Math.min(AUDIO_MAX_SECONDS + 1, dur) * 10) / 10,
  };
  if (typeof a.wave === 'string' && WAVE_RE.test(a.wave)) out.wave = a.wave;
  return out;
}

/** 75.4 -> "1:15". */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Problem with a finished recording, or null when it can be sent. */
export function recordingProblem({ size, dur, mime }) {
  if (!AUDIO_MIMES.includes(mime)) return 'This browser recorded a format that can’t be sent.';
  if (!(dur >= AUDIO_MIN_SECONDS)) return 'That recording is too short.';
  if (!(size > 0)) return 'The recording is empty. Check your microphone.';
  if (size > AUDIO_MAX_BYTES) return `That recording is too large to send (${Math.ceil(size / 1024)} KB, max ${AUDIO_MAX_BYTES / 1024} KB). Try a shorter one.`;
  return null;
}

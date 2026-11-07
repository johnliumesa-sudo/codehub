// Voice & video preferences, kept only in this browser (localStorage `codehub.callDevices`, the key the
// first calls release used for device ids). Pure apart from guarded localStorage access, so it can be
// unit-tested in Node. `subscribe` lets the settings tab and the in-call menu stay in sync.

export const PREFS_KEY = 'codehub.callDevices';
export const DEFAULT_PTT_KEY = 'Backquote';

export const DEFAULT_PREFS = Object.freeze({
  audioIn: '', // deviceId ('' = system default)
  videoIn: '',
  audioOut: '',
  ec: true, // echo cancellation
  ns: true, // noise suppression
  agc: true, // automatic gain control
  ptt: false, // push-to-talk
  pttKey: DEFAULT_PTT_KEY, // KeyboardEvent.code
});

const KEY_CODE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
// Keys that would break normal use if they were held to talk.
export const RESERVED_KEYS = Object.freeze(['Escape', 'Tab', 'Enter', 'NumpadEnter', 'Backspace', 'CapsLock', 'MetaLeft', 'MetaRight', 'ContextMenu']);

const str = (v, max = 256) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Coerce anything (old saved data, a patch) into a complete, valid prefs object. */
export function normalizePrefs(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const bool = (k) => (typeof v[k] === 'boolean' ? v[k] : DEFAULT_PREFS[k]);
  const key = typeof v.pttKey === 'string' && KEY_CODE.test(v.pttKey) && !RESERVED_KEYS.includes(v.pttKey) ? v.pttKey : DEFAULT_PTT_KEY;
  return { audioIn: str(v.audioIn), videoIn: str(v.videoIn), audioOut: str(v.audioOut), ec: bool('ec'), ns: bool('ns'), agc: bool('agc'), ptt: bool('ptt'), pttKey: key };
}

/** getUserMedia audio constraints for the saved device and processing switches. */
export function audioConstraints(prefs, deviceId = prefs?.audioIn) {
  const p = normalizePrefs(prefs);
  return {
    echoCancellation: p.ec,
    noiseSuppression: p.ns,
    autoGainControl: p.agc,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/** Human label for a KeyboardEvent.code. */
export function keyLabel(code) {
  if (!code) return '';
  if (code === 'Backquote') return '` (backquote)';
  if (code === 'Space') return 'Space';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Numpad ${code.slice(6)}`;
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export const isValidPttKey = (code) => typeof code === 'string' && KEY_CODE.test(code) && !RESERVED_KEYS.includes(code);

let cache = null;
const listeners = new Set();

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // storage blocked
  }
}

export function loadPrefs() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(storage()?.getItem(PREFS_KEY) || 'null');
  } catch {
    raw = null;
  }
  cache = normalizePrefs(raw);
  return cache;
}

/** Merge `patch` into the saved prefs; returns the new prefs. Prefs last for the session if storage is blocked. */
export function savePrefs(patch) {
  cache = normalizePrefs({ ...loadPrefs(), ...(patch || {}) });
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify(cache));
  } catch {
    // storage blocked or full
  }
  for (const fn of [...listeners]) fn(cache);
  return cache;
}

export function subscribePrefs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only: forget the in-memory copy. */
export function _resetPrefsCache() {
  cache = null;
}

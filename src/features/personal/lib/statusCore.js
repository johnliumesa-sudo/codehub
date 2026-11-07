// Custom status, Do Not Disturb, invisible: pure helpers (no Firebase imports; unit-tested in node).
//
// Data (see docs/features/personal.md):
//   udata/{me}/status/mode       'online' | 'idle' | 'dnd' | 'invisible'   private, synced across my devices
//   upub/{uid}/status/now        { mode?: 'dnd', emoji?, text?, until?, ts? } public (signed-in users read)
//   presence/{uid}.state         'online' | 'idle' | 'offline'               written by src/lib/presence.js
// Invisible never appears in public data: presence says 'offline' and upub carries no mode.

export const STATUS_MODES = Object.freeze(['online', 'idle', 'dnd', 'invisible']);
export const MODE_LABEL = Object.freeze({ online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible', offline: 'Offline' });
export const MODE_HINT = Object.freeze({
  online: 'Goes idle by itself after 10 minutes without input.',
  idle: 'Show as away until you change it.',
  dnd: 'Mutes desktop notifications and sounds. The bell still counts.',
  invisible: 'Appear offline to everyone. You can still use Codehub.',
});

export const STATUS_TEXT_MAX = 80;
export const STATUS_EMOJI_MAX = 32; // UTF-16 units: one emoji grapheme (flags, families, skin tones)

export const CLEAR_AFTER = Object.freeze([
  { id: '30m', label: '30 minutes', ms: 30 * 60_000 },
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '4h', label: '4 hours', ms: 4 * 3_600_000 },
  { id: 'today', label: 'Today' },
  { id: 'never', label: "Don't clear" },
]);

/** Normalize a stored mode; anything unknown is 'online'. */
export function normalizeMode(v) {
  return STATUS_MODES.includes(v) ? v : 'online';
}

/** When a status set now with "clear after" `id` expires (ms epoch), or 0 for never. */
export function clearAfterUntil(id, now = Date.now()) {
  const opt = CLEAR_AFTER.find((o) => o.id === id);
  if (!opt || opt.id === 'never') return 0;
  if (opt.id === 'today') {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0); // next local midnight
    return d.getTime();
  }
  return now + opt.ms;
}

// Control characters, bidi overrides and zero-width joiners outside emoji are stripped from text.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function graphemes(s) {
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
    }
  } catch {
    /* fall through */
  }
  return Array.from(s);
}

/** Status text: one line, trimmed, at most STATUS_TEXT_MAX characters (never splits an emoji). */
export function cleanStatusText(v) {
  if (typeof v !== 'string') return '';
  const one = v.replace(/[\r\n\t]+/g, ' ').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  const parts = graphemes(one);
  return parts.length > STATUS_TEXT_MAX ? parts.slice(0, STATUS_TEXT_MAX).join('').trim() : one;
}

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\ufe0f?\u20e3/u;

/** The first grapheme of `v` if it is an emoji, else ''. */
export function cleanEmoji(v) {
  if (typeof v !== 'string') return '';
  const first = graphemes(v.trim())[0] || '';
  if (!first || first.length > STATUS_EMOJI_MAX || !EMOJI_RE.test(first)) return '';
  return first;
}

/**
 * A public status record as stored at upub/{uid}/status/now -> the custom status to show, or null.
 * Untrusted input: wrong types are dropped, text is re-cleaned, an expired `until` hides it.
 */
export function readCustomStatus(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const until = typeof raw.until === 'number' && Number.isFinite(raw.until) && raw.until > 0 ? raw.until : 0;
  if (until && until <= now) return null;
  const emoji = cleanEmoji(raw.emoji);
  const text = cleanStatusText(raw.text);
  if (!emoji && !text) return null;
  return { emoji, text, until };
}

/** True if the public record says Do Not Disturb. */
export const isDndRecord = (raw) => !!raw && typeof raw === 'object' && raw.mode === 'dnd';

/**
 * What others see: presence state ('online' | 'idle' | 'offline') combined with the public record.
 * Offline wins (closed tab or invisible); DND shows while the person is around (even if idle).
 */
export function effectivePresence(state, publicRaw) {
  const s = state === 'online' || state === 'idle' ? state : 'offline';
  if (s === 'offline') return 'offline';
  return isDndRecord(publicRaw) ? 'dnd' : s;
}

/** The presence state this tab should write for my chosen mode and my activity ('online' | 'idle'). */
export function presenceToWrite(mode, autoState) {
  if (mode === 'invisible') return 'offline';
  if (mode === 'idle') return 'idle';
  return autoState === 'idle' ? 'idle' : 'online';
}

/** Short "clears in …" text for the status dialog. */
export function describeUntil(until, now = Date.now()) {
  if (!until) return '';
  const left = until - now;
  if (left <= 0) return 'Expired';
  if (left < 3_600_000) return `Clears in ${Math.max(1, Math.ceil(left / 60_000))} min`;
  if (left < 86_400_000) return `Clears in ${Math.round(left / 3_600_000)} h`;
  return `Clears ${new Date(until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** Suggested status presets for the dialog. */
export const STATUS_PRESETS = Object.freeze([
  { emoji: '💻', text: 'Coding', clear: '4h' },
  { emoji: '📅', text: 'In a meeting', clear: '1h' },
  { emoji: '🍔', text: 'Lunch break', clear: '1h' },
  { emoji: '🤒', text: 'Out sick', clear: 'today' },
  { emoji: '🌴', text: 'On vacation', clear: 'never' },
]);

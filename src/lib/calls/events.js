// In-call events over each peer's RTCDataChannel (raise hand, reactions). Pure: no browser or Firebase
// imports. Everything received is untrusted: parseCallEvent validates size, shape and values, and the
// session rate-limits per sender before applying anything.

export const REACTIONS = Object.freeze(['👍', '❤️', '😂', '🎉', '👏', '😮', '😢', '🔥']);
export const REACTION_LABELS = Object.freeze({
  '👍': 'Thumbs up', '❤️': 'Heart', '😂': 'Laughing', '🎉': 'Party', '👏': 'Applause', '😮': 'Surprised', '😢': 'Sad', '🔥': 'Fire',
});
export const REACTION_MS = 3_000; // a reaction floats over the sender's tile this long
export const MAX_EVENT_BYTES = 200;
export const MAX_SKEW_MS = 10 * 60_000; // hand timestamps further than this from my server clock are replaced

const finiteAt = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);

function cleanHand(h) {
  if (!h || typeof h !== 'object' || typeof h.up !== 'boolean') return null;
  return { up: h.up, at: finiteAt(h.at) };
}

/** Serialize an outgoing event (the session only sends what this module can parse back). */
export function encodeEvent(ev) {
  return JSON.stringify(ev);
}

/**
 * Parse one received data channel message. Returns `null` for anything unexpected, else
 * `{ t: 'hand', up, at }`, `{ t: 'react', e }` or `{ t: 'state', hand: { up, at } }`.
 */
export function parseCallEvent(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_EVENT_BYTES) return null;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.t === 'hand') {
    const h = cleanHand(v);
    return h && { t: 'hand', ...h };
  }
  if (v.t === 'react') return REACTIONS.includes(v.e) ? { t: 'react', e: v.e } : null;
  if (v.t === 'state') {
    const h = cleanHand(v.hand);
    return h && { t: 'state', hand: h };
  }
  return null;
}

/** A raise time from another clock: kept when plausible, else replaced by my own (server-corrected) now. */
export function fixRaiseTime(at, serverNow) {
  return typeof at === 'number' && Math.abs(at - serverNow) <= MAX_SKEW_MS ? at : serverNow;
}

/** Token bucket per key: `capacity` events, refilled one per `refillMs`. `take(key, now)` -> allowed. */
export function createRateLimiter({ capacity, refillMs }) {
  const buckets = new Map();
  return {
    take(key, now) {
      const b = buckets.get(key) || { tokens: capacity, at: now };
      const refill = Math.floor((now - b.at) / refillMs);
      if (refill > 0) {
        b.tokens = Math.min(capacity, b.tokens + refill);
        b.at += refill * refillMs;
      }
      if (b.tokens >= capacity) b.at = now;
      const ok = b.tokens > 0;
      if (ok) b.tokens -= 1;
      buckets.set(key, b);
      return ok;
    },
    forget(key) {
      buckets.delete(key);
    },
  };
}

/** Raised hands as `[{ uid, at }]`, earliest first (ties by uid so every client shows the same order). */
export function orderHands(hands) {
  return [...hands.entries()].map(([uid, at]) => ({ uid, at })).sort((a, b) => a.at - b.at || (a.uid < b.uid ? -1 : 1));
}

// Reaction keys (no Firebase imports, so unit tests can load this). messages.js re-exports all of it.

// RTDB keys can't hold some characters, so reactions are keyed by the emoji's code points
// in lowercase hex joined with '-' (e.g. "1f44d", "2764-fe0f"). Plaintext by design.

export function emojiKey(native) {
  return Array.from(native, (ch) => ch.codePointAt(0).toString(16)).join('-');
}

export function emojiFromKey(key) {
  const emote = emoteFromKey(key);
  if (emote) return `:${emote}:`;
  try {
    return String.fromCodePoint(...key.split('-').map((h) => parseInt(h, 16)));
  } catch {
    return '?';
  }
}

// Custom server emotes react as `e_{name}` (hex emoji keys never contain '_', so the two can't collide).
const EMOTE_REACTION = /^:([a-z0-9_]{2,32}):$/;
const EMOTE_KEY = /^e_([a-z0-9_]{2,32})$/;

/** Reaction key for a native emoji or a `:name:` server emote. */
export function reactionKey(value) {
  const m = EMOTE_REACTION.exec(String(value || ''));
  return m ? `e_${m[1]}` : emojiKey(value);
}

/** Emote name for an `e_{name}` reaction key, else null. */
export function emoteFromKey(key) {
  return EMOTE_KEY.exec(String(key || ''))?.[1] || null;
}

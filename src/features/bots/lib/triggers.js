// Keyword triggers: which installed bot (if any) answers a message. Pure, unit-tested.
// A trigger's word or phrase matches case-insensitively as whole words (a phrase that starts or ends
// with punctuation, like "!ping" or "c++", only needs the word side to be bounded). Text inside code
// blocks and inline code never triggers. At most one trigger answers a message: the first match in
// install order, then trigger order, that is not cooling down.

const WORD = '\\p{L}\\p{N}_';
const cache = new Map(); // match -> RegExp

function escapeRe(s) {
  // Only syntax characters: other identity escapes (like "\-") are errors in a `u` regex.
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** RegExp for a trigger phrase (cached). */
export function triggerRegex(match) {
  const key = String(match ?? '');
  let re = cache.get(key);
  if (re) return re;
  const phrase = key.trim().replace(/\s+/g, ' ');
  if (!phrase) return null;
  const body = phrase.split(' ').map(escapeRe).join('\\s+');
  const pre = new RegExp(`^[${WORD}]`, 'u').test(phrase) ? `(?:^|[^${WORD}])` : '';
  const post = new RegExp(`[${WORD}]$`, 'u').test(phrase) ? `(?=$|[^${WORD}])` : '';
  re = new RegExp(`${pre}${body}${post}`, 'iu');
  if (cache.size > 2000) cache.clear();
  cache.set(key, re);
  return re;
}

/** Message text without fenced code blocks and inline code. */
export function stripCode(text) {
  return String(text ?? '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** True if `text` contains the trigger phrase. */
export function matchesTrigger(text, match) {
  const re = triggerRegex(match);
  return !!re && re.test(stripCode(text));
}

/**
 * The trigger that answers `text`, or null.
 * bots: installed bots [{ id, def: { triggers } }] in install order.
 * isCooling(botId, trigger) -> true to skip a trigger that answered too recently.
 */
export function findTrigger(text, bots, isCooling = () => false) {
  const plain = stripCode(text);
  if (!plain.trim() || !Array.isArray(bots)) return null;
  for (const bot of bots) {
    for (const trigger of bot?.def?.triggers || []) {
      const re = triggerRegex(trigger.match);
      if (!re || !re.test(plain)) continue;
      if (isCooling(bot.id, trigger)) continue;
      return { bot, trigger };
    }
  }
  return null;
}

/**
 * Channel-wide cooldown from the loaded messages: true if this bot answered this trigger less than
 * `cooldown` seconds before `now` (any member's client may have sent that reply).
 */
export function answeredRecently(messages, botId, trigger, now = Date.now()) {
  const since = now - trigger.cooldown * 1000;
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m?.ts === 'number' && m.ts < since) break; // messages are in time order
    const b = m?.body?.bot;
    if (b && b.id === botId && b.trig === trigger.id && b.via === 'trigger') return true;
  }
  return false;
}

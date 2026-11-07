// Pure helpers for games (no Firebase): titles, cover letters, publish refusal messages.
// Imported by src/lib/games.js and the unit tests.

export const TITLE_MAX = 80;
export const DESC_MAX = 500;
export const PUBLISH_COOLDOWN_MS = 60_000;

export const isDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e));

/** Cut to at most `max` UTF-16 units without splitting a character (emoji stay whole). */
export function clipChars(text, max) {
  let out = '';
  for (const ch of String(text || '')) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const decodeEntity = (whole, body) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[body.toLowerCase()];
  if (named) return named;
  const n = /^#x([0-9a-f]{1,6})$/i.exec(body) ? parseInt(body.slice(2), 16) : /^#(\d{1,7})$/.exec(body) ? Number(body.slice(1)) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
};

/** First user-perceived character (an emoji or a CJK/Arabic letter stays whole), upper-cased. */
export function coverLetter(title) {
  const t = String(title || '').trim();
  if (!t) return '?';
  let first = '';
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)[Symbol.iterator]().next().value?.segment || '';
  } catch {
    first = '';
  }
  return (first || Array.from(t)[0] || '?').toLocaleUpperCase();
}

export function titleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  if (!m) return '';
  const text = m[1].replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity).replace(/\s+/g, ' ').trim();
  return clipChars(text, TITLE_MAX);
}

/**
 * The rules refuse a publish for two reasons the client can't tell apart (publishLog is write-only):
 * the once-a-minute limit, or rules on the server that don't match this app version. Say which is
 * likely, without claiming certainty.
 */
export function publishRefusal(err, { lastAt = 0, now = Date.now() } = {}) {
  if (!isDenied(err)) return err;
  const recent = lastAt && now - lastAt < PUBLISH_COOLDOWN_MS;
  const e = new Error(
    recent
      ? 'Publishing was refused: you can publish or update at most once a minute. Wait a moment and try again.'
      : 'Publishing was refused by the database rules. If you published or updated a game in the last minute (maybe in another tab), wait a moment and try again. If it keeps failing, the rules on the server are probably out of date: ask the app owner to deploy the current database rules.',
  );
  e.code = 'PERMISSION_DENIED';
  return e;
}


// Reminder times (pure). `parseWhen` reads a time expression at the start of `/remind` arguments and
// returns the due time plus the rest of the text; `presets` are the "Remind me" menu choices.
//
// Understood (case-insensitive, "in" and "at" optional):
//   20m · 20 min · 1h30m · 2 hours · 3d · 1w · 45s       relative
//   tomorrow · tomorrow 14:30 · tomorrow at 2pm          tomorrow (09:00 by default)
//   today 17:00 · 17:00 · 5pm · 5:30 pm                  today, or tomorrow when that time has passed
//   monday · fri 10:00                                   the next such weekday (09:00 by default)
//   2026-12-24 · 2026-12-24 18:00                         a date (09:00 by default)

export const MAX_AHEAD_MS = 366 * 24 * 3600 * 1000;
export const DEFAULT_HOUR = 9;

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const UNIT_WORD = /^(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function unitKey(word) {
  const w = word.toLowerCase();
  if (!UNIT_WORD.test(w)) return null;
  if (w.startsWith('w')) return 'w';
  if (w.startsWith('d')) return 'd';
  if (w.startsWith('h')) return 'h';
  if (w.startsWith('s')) return 's';
  return 'm';
}

// "14:30", "2pm", "2:30 pm", "14h30"? (no). Requires ':' or am/pm so plain numbers stay text.
const TIME_RE = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)/i;

function readTime(src) {
  const m = TIME_RE.exec(src);
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  } else if (h > 23) return null;
  return { h, min, len: m[0].length };
}

const at = (base, h, min) => {
  const d = new Date(base.getTime());
  d.setHours(h, min, 0, 0);
  return d;
};
const addDays = (d, n) => {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
};

function result(due, rest, now) {
  const t = due instanceof Date ? due.getTime() : due;
  if (!Number.isFinite(t) || t <= now.getTime() || t - now.getTime() > MAX_AHEAD_MS) return null;
  return { due: t, rest: rest.trim() };
}

/** Parse a time expression at the start of `input`. Resolves { due (ms), rest } or null. */
export function parseWhen(input, now = new Date()) {
  let src = String(input || '').trim();
  if (!src) return null;
  src = src.replace(/^in\s+/i, '');

  // Relative: one or more "<n><unit>" groups ("1h30m", "1 h 30 m", "2 hours").
  let ms = 0;
  let consumed = 0;
  const rel = /^(\d{1,4})\s*([a-z]+)\s*/i;
  let rest = src;
  for (;;) {
    const m = rel.exec(rest);
    if (!m) break;
    const u = unitKey(m[2]);
    if (!u) break;
    ms += Number(m[1]) * UNIT_MS[u];
    rest = rest.slice(m[0].length);
    consumed++;
  }
  if (consumed) {
    if (ms <= 0) return null;
    return result(now.getTime() + ms, rest, now);
  }

  const lower = src.toLowerCase();

  // tomorrow [time]
  let m = /^tomorrow\b\s*/i.exec(src);
  if (m) {
    const after = src.slice(m[0].length);
    const t = readTime(after);
    const day = addDays(now, 1);
    return t ? result(at(day, t.h, t.min), after.slice(t.len), now) : result(at(day, DEFAULT_HOUR, 0), after, now);
  }

  // today <time>
  m = /^today\b\s*/i.exec(src);
  if (m) {
    const after = src.slice(m[0].length);
    const t = readTime(after);
    if (!t) return null;
    return result(at(now, t.h, t.min), after.slice(t.len), now);
  }

  // weekday [time]
  const dm = /^([a-z]+)\b\s*/i.exec(lower);
  if (dm) {
    const idx = DAYS.findIndex((d) => d === dm[1] || (dm[1].length >= 3 && d.startsWith(dm[1])));
    if (idx >= 0) {
      const after = src.slice(dm[0].length);
      const t = readTime(after);
      let ahead = (idx - now.getDay() + 7) % 7;
      const hh = t ? t.h : DEFAULT_HOUR;
      const mm = t ? t.min : 0;
      if (ahead === 0 && at(now, hh, mm).getTime() <= now.getTime()) ahead = 7;
      return result(at(addDays(now, ahead), hh, mm), t ? after.slice(t.len) : after, now);
    }
  }

  // YYYY-MM-DD [time]
  m = /^(\d{4})-(\d{2})-(\d{2})\b\s*/.exec(src);
  if (m) {
    const after = src.slice(m[0].length);
    const t = readTime(after);
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), t ? t.h : DEFAULT_HOUR, t ? t.min : 0, 0, 0);
    if (d.getMonth() !== Number(m[2]) - 1) return null; // 2026-02-31
    return result(d, t ? after.slice(t.len) : after, now);
  }

  // <time>: today, or tomorrow once it has passed
  const t = readTime(src);
  if (t) {
    let d = at(now, t.h, t.min);
    if (d.getTime() <= now.getTime()) d = at(addDays(now, 1), t.h, t.min);
    return result(d, src.slice(t.len), now);
  }
  return null;
}

/** The "Remind me" choices: [{ id, label, due }]. */
export function presets(now = new Date()) {
  const t = now.getTime();
  return [
    { id: '20m', label: 'In 20 minutes', due: t + 20 * 60_000 },
    { id: '1h', label: 'In 1 hour', due: t + 3_600_000 },
    { id: '3h', label: 'In 3 hours', due: t + 3 * 3_600_000 },
    { id: 'tomorrow', label: 'Tomorrow at 9:00', due: at(addDays(now, 1), DEFAULT_HOUR, 0).getTime() },
  ];
}

/** Snooze choices relative to now. */
export function snoozeChoices(now = new Date()) {
  const t = now.getTime();
  return [
    { id: '10m', label: '10 minutes', due: t + 10 * 60_000 },
    { id: '1h', label: '1 hour', due: t + 3_600_000 },
    { id: '3h', label: '3 hours', due: t + 3 * 3_600_000 },
    { id: 'tomorrow', label: 'Tomorrow at 9:00', due: at(addDays(now, 1), DEFAULT_HOUR, 0).getTime() },
  ];
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today at 3:45 PM" / "tomorrow at 9:00 AM" / "Mon, Nov 10 at 9:00 AM" (locale time format). */
export function formatDue(ts, now = new Date(), locale) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, now)) return `today at ${time}`;
  if (sameDay(d, addDays(now, 1))) return `tomorrow at ${time}`;
  if (sameDay(d, addDays(now, -1))) return `yesterday at ${time}`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString(locale, opts)} at ${time}`;
}

/** Value for <input type="datetime-local"> (local time, minutes). */
export function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parse a datetime-local value (local time) -> ms, or NaN. */
export function fromLocalInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(v || ''));
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}

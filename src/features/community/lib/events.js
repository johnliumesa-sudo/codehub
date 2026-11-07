// Server events with RSVP: pure helpers (no Firebase), shared by the UI and the unit tests.
//
// Storage (see docs/features/community.md):
//   sitems/{sid}/events/{id}         { by, iv, ct }  ct = sealForServer(sid, `event:{sid}/{id}`, body)
//   sitems/{sid}/rsvp/{rid}~{uid}    { by: uid, s: 'going'|'maybe'|'not', ts }   (plaintext, like poll votes)
//   udata/{me}/rsvp/{sid}~{rid}      'going'|'maybe'|'not'   my own index, drives reminders
// body = { title, desc, start, end, loc, color, cancelled?, rid?, orig? }
//   loc   = null | { kind: 'voice', cid } | { kind: 'text', text }
//   rid   = the id RSVPs are keyed by. Defaults to the event id; a moderator's edit replaces the
//           record (the rules only let authors update), and the copy keeps the original rid.
//   orig  = the original author's uid on such a moderator copy.

export const EVENT_LIMITS = Object.freeze({
  title: 100,
  desc: 2000,
  locText: 100,
  maxDurationMs: 7 * 24 * 3600 * 1000,
  maxAheadMs: 2 * 366 * 24 * 3600 * 1000,
  perServer: 200, // UI cap on stored events per server (the rules cannot count)
});
export const DEFAULT_DURATION_MS = 2 * 3600 * 1000;
export const REMINDER_LEAD_MS = 15 * 60 * 1000;
export const JOIN_EARLY_MS = 10 * 60 * 1000;
export const EVENT_COLORS = Object.freeze(['#5b8cff', '#a66bff', '#ff6b9a', '#ff8f4d', '#f5c542', '#3ccf91', '#2bc4d9', '#8892a6']);
export const RSVP_STATES = Object.freeze(['going', 'maybe', 'not']);
export const RSVP_LABELS = Object.freeze({ going: 'Going', maybe: 'Maybe', not: "Can't go" });

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const eventAad = (sid, id) => `event:${sid}/${id}`;
export const rsvpKey = (rid, uid) => `${rid}~${uid}`;
export const rsvpIndexKey = (sid, rid) => `${sid}~${rid}`;
export const isEventId = (id) => typeof id === 'string' && ID_RE.test(id);

/** "{rid}~{uid}" -> { rid, uid } or null. */
export function parseRsvpKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.lastIndexOf('~');
  if (i <= 0 || i === key.length - 1) return null;
  const rid = key.slice(0, i);
  const uid = key.slice(i + 1);
  return isEventId(rid) && /^[A-Za-z0-9_-]{1,128}$/.test(uid) ? { rid, uid } : null;
}

const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const multiLine = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const isTime = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 8.64e15;

function cleanLoc(loc) {
  if (!loc || typeof loc !== 'object') return null;
  if (loc.kind === 'voice' && isEventId(loc.cid)) return { kind: 'voice', cid: loc.cid };
  if (loc.kind === 'text') {
    const text = oneLine(loc.text, EVENT_LIMITS.locText);
    return text ? { kind: 'text', text } : null;
  }
  return null;
}

/**
 * Validate an event the user is saving. Throws an Error with a user-facing message. `now` bounds the
 * start for new events (opts.isNew): not more than a day in the past, not more than two years ahead.
 */
export function cleanEvent(input, { now = Date.now(), isNew = true } = {}) {
  const title = oneLine(input?.title, EVENT_LIMITS.title);
  if (!title) throw new Error('Give the event a title');
  const desc = multiLine(input?.desc, EVENT_LIMITS.desc);
  const start = input?.start;
  if (!isTime(start)) throw new Error('Pick a start date and time');
  if (isNew && start < now - 24 * 3600 * 1000) throw new Error('The start time is in the past');
  if (start > now + EVENT_LIMITS.maxAheadMs) throw new Error('Events can be planned up to two years ahead');
  let end = input?.end || 0;
  if (end) {
    if (!isTime(end)) throw new Error('The end time is not valid');
    if (end <= start) throw new Error('The event has to end after it starts');
    if (end - start > EVENT_LIMITS.maxDurationMs) throw new Error('Events can last at most 7 days');
  } else end = 0;
  const color = HEX_RE.test(input?.color || '') ? input.color.toLowerCase() : EVENT_COLORS[0];
  const out = { title, desc, start, end, loc: cleanLoc(input?.loc), color };
  if (input?.cancelled === true) out.cancelled = true;
  if (isEventId(input?.rid)) out.rid = input.rid;
  if (typeof input?.orig === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.orig)) out.orig = input.orig;
  return out;
}

/** A decrypted event body from another member (untrusted) -> clean body or null. */
export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.title !== 'string' || typeof raw.start !== 'number') return null;
  try {
    return cleanEvent(raw, { isNew: false, now: raw.start || Date.now() });
  } catch {
    return null;
  }
}

export const eventEnd = (ev) => (ev.end && ev.end > ev.start ? ev.end : ev.start + DEFAULT_DURATION_MS);
export const isLive = (ev, now = Date.now()) => !ev.cancelled && now >= ev.start && now < eventEnd(ev);
export const isPast = (ev, now = Date.now()) => now >= eventEnd(ev);
/** "Join voice" shows from 10 minutes before the start until the end. */
export const canJoinVoice = (ev, now = Date.now()) => !ev.cancelled && ev.loc?.kind === 'voice' && now >= ev.start - JOIN_EARLY_MS && now < eventEnd(ev);

/** The RSVP id of an event: its own id unless it is a moderator's copy of an event that is gone. */
export function resolveRid(ev, liveIds) {
  if (!ev.rid || ev.rid === ev.id) return ev.id;
  return liveIds && liveIds.has(ev.rid) ? ev.id : ev.rid;
}

/**
 * Events (decrypted, with id/by) -> { upcoming, past }. Upcoming (and ongoing) sort by start,
 * soonest first; past by start, newest first. Cancelled events stay where their time puts them.
 */
export function splitEvents(events, now = Date.now()) {
  const upcoming = [];
  const past = [];
  for (const ev of events) (isPast(ev, now) ? past : upcoming).push(ev);
  upcoming.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  past.sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
  return { upcoming, past };
}

/** The next event that is not cancelled (ongoing ones count), or null. */
export function nextEvent(events, now = Date.now()) {
  return splitEvents(events.filter((e) => !e.cancelled), now).upcoming[0] || null;
}

/**
 * RSVP items [{ id: key, by, s, ts }] -> Map rid -> Map uid -> { s, ts }. The key must name the
 * same uid as `by` (the rules make every key end with its author's uid); one answer per member
 * and event, the newest wins.
 */
export function collectRsvps(items) {
  const out = new Map();
  for (const it of items || []) {
    const k = parseRsvpKey(it?.id);
    if (!k || it.by !== k.uid || !RSVP_STATES.includes(it.s)) continue;
    const ts = typeof it.ts === 'number' ? it.ts : 0;
    let m = out.get(k.rid);
    if (!m) out.set(k.rid, (m = new Map()));
    const prev = m.get(it.by);
    if (!prev || ts >= prev.ts) m.set(it.by, { s: it.s, ts });
  }
  return out;
}

/** Map uid -> {s} -> { going: [uid], maybe: [uid], not: [uid] } (uids ordered by answer time). */
export function tallyRsvps(map) {
  const out = { going: [], maybe: [], not: [] };
  if (!map) return out;
  [...map.entries()].sort((a, b) => a[1].ts - b[1].ts).forEach(([uid, v]) => out[v.s]?.push(uid));
  return out;
}

/**
 * Reminders to show now: events I'm going to whose start is within the lead time and still ahead
 * (a reminder missed while the tab was closed still fires while the event hasn't started).
 * going: Set of `${sid}/${rid}`; fired: Set of reminderId. Returns [{ ev, sid, id }].
 */
export const reminderId = (sid, ev) => `${sid}/${ev.id}/${ev.start}`;
export function dueReminders(list, going, fired, now = Date.now()) {
  return list.filter(({ sid, ev, rid }) => !ev.cancelled && going.has(`${sid}/${rid}`) && !fired.has(reminderId(sid, ev))
    && now >= ev.start - REMINDER_LEAD_MS && now < ev.start);
}
/** Milliseconds until the next reminder becomes due (or null). */
export function nextReminderIn(list, going, fired, now = Date.now()) {
  let best = null;
  for (const { sid, ev, rid } of list) {
    if (ev.cancelled || !going.has(`${sid}/${rid}`) || fired.has(reminderId(sid, ev))) continue;
    const at = ev.start - REMINDER_LEAD_MS;
    if (at > now && (best === null || at - now < best)) best = at - now;
  }
  return best;
}

// ---------- formatting ----------

const pad = (n) => String(n).padStart(2, '0');
/** ms -> value for <input type="datetime-local"> (local time). */
export function toLocalInput(ms) {
  if (!isTime(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** <input type="datetime-local"> value -> ms (local time) or 0. */
export function fromLocalInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(v || ''));
  if (!m) return 0;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

/** "in 5 min", "in 2 h", "in 3 days", "now", "2 h ago". */
export function relTime(ms, now = Date.now()) {
  const d = ms - now;
  const a = Math.abs(d);
  const unit = a < 60_000 ? null : a < 3600_000 ? `${Math.round(a / 60_000)} min` : a < 48 * 3600_000 ? `${Math.round(a / 3600_000)} h` : `${Math.round(a / 86400_000)} days`;
  if (!unit) return 'now';
  return d > 0 ? `in ${unit}` : `${unit} ago`;
}

/** Human date range, e.g. "Fri, Nov 7, 6:00 PM – 8:00 PM". */
export function fmtRange(ev, locale) {
  const dOpts = { weekday: 'short', month: 'short', day: 'numeric' };
  const tOpts = { hour: 'numeric', minute: '2-digit' };
  const s = new Date(ev.start);
  const start = `${s.toLocaleDateString(locale, dOpts)}, ${s.toLocaleTimeString(locale, tOpts)}`;
  if (!ev.end) return start;
  const e = new Date(ev.end);
  const sameDay = s.toDateString() === e.toDateString();
  return `${start} – ${sameDay ? e.toLocaleTimeString(locale, tOpts) : `${e.toLocaleDateString(locale, dOpts)}, ${e.toLocaleTimeString(locale, tOpts)}`}`;
}

const icsEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** An iCalendar file for one event (downloaded locally; never uploaded). */
export function toIcs(ev, { where = '' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Codehub//Events//EN', 'BEGIN:VEVENT',
    `UID:${ev.id}@codehub`, `DTSTAMP:${icsTime(Date.now())}`, `DTSTART:${icsTime(ev.start)}`, `DTEND:${icsTime(eventEnd(ev))}`,
    `SUMMARY:${icsEsc(ev.title)}`,
  ];
  if (ev.desc) lines.push(`DESCRIPTION:${icsEsc(ev.desc)}`);
  if (where) lines.push(`LOCATION:${icsEsc(where)}`);
  if (ev.cancelled) lines.push('STATUS:CANCELLED');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

// Reminders (pure model). Storage, encryption and the scheduler live in reminders.js.
//
//   udata/{uid}/reminders/{id} = { iv, ct, fired?: ms, done?: ms }
//     ct  = sealForMe(`reminder:{uid}/{id}`, payload)
//     payload = { due, note, conv: { kind, sid?, cid?, dmId?, gid? }, mid?, title, excerpt, author, createdAt }
//   `fired` (set once by a transaction, so only one tab or device fires it) and `done` are plaintext
//   timestamps; everything the user typed or saw is inside the sealed payload.
import { convKey, convRef } from './links.js';

export const MAX_REMINDERS = 200;
export const MAX_NOTE = 500;
export const MAX_EXCERPT = 200;
export const reminderAad = (uid, id) => `reminder:${uid}/${id}`;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Sealed payload for a new reminder (validated; throws on bad input). */
export function buildPayload({ due, note, conv, mid, title, excerpt, author }, now = Date.now()) {
  if (!Number.isFinite(due) || due <= 0) throw new Error('Pick a time for the reminder');
  const ref = convRef(conv);
  if (!ref || !convKey(ref)) throw new Error('Reminders need a conversation');
  const out = {
    due: Math.round(due),
    note: s(note, MAX_NOTE).trim(),
    conv: ref,
    title: s(title, 120),
    excerpt: s(excerpt, MAX_EXCERPT),
    author: s(author, 80),
    createdAt: now,
  };
  if (typeof mid === 'string' && ID_RE.test(mid)) out.mid = mid;
  return out;
}

/** Decrypted payload -> normalised reminder fields, or null when malformed. */
export function cleanPayload(p) {
  if (!p || typeof p !== 'object') return null;
  const conv = convRef(p.conv);
  if (!Number.isFinite(p.due) || !conv || !convKey(conv)) return null;
  const out = {
    due: p.due,
    note: s(p.note, MAX_NOTE),
    conv,
    title: s(p.title, 120),
    excerpt: s(p.excerpt, MAX_EXCERPT),
    author: s(p.author, 80),
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
  };
  if (typeof p.mid === 'string' && ID_RE.test(p.mid)) out.mid = p.mid;
  return out;
}

/** 'done' | 'due' (fired or past due, not done) | 'upcoming'. */
export function stateOf(r, now = Date.now()) {
  if (r.done) return 'done';
  if (r.fired || r.due <= now) return 'due';
  return 'upcoming';
}

/** Reminders split for the panel: due (oldest first), upcoming (soonest first), done (newest first). */
export function sections(list, now = Date.now()) {
  const due = [];
  const upcoming = [];
  const done = [];
  for (const r of list || []) {
    const st = stateOf(r, now);
    (st === 'done' ? done : st === 'due' ? due : upcoming).push(r);
  }
  due.sort((a, b) => a.due - b.due);
  upcoming.sort((a, b) => a.due - b.due);
  done.sort((a, b) => (b.done || 0) - (a.done || 0));
  return { due, upcoming, done };
}

/** Reminders that should fire now: past due, never fired, not done. */
export function dueToFire(list, now = Date.now()) {
  return (list || []).filter((r) => !r.done && !r.fired && r.due <= now).sort((a, b) => a.due - b.due);
}

/** The next due time after now among reminders that haven't fired, or null. */
export function nextDue(list, now = Date.now()) {
  let next = null;
  for (const r of list || []) {
    if (r.done || r.fired || r.due <= now) continue;
    if (next === null || r.due < next) next = r.due;
  }
  return next;
}

/** Short one-line description: the note, else the message excerpt, else the conversation. */
export function reminderSummary(r) {
  if (r.note) return r.note;
  if (r.excerpt) return `${r.author ? `${r.author}: ` : ''}${r.excerpt}`;
  return r.title ? `Check ${r.title}` : 'Reminder';
}

/** One-line excerpt of a decrypted message body for a reminder (never more than MAX_EXCERPT chars). */
export function excerptOf(body) {
  if (!body || typeof body !== 'object') return '';
  const t = (typeof body.text === 'string' ? body.text : '')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\s+/g, ' ')
    .trim();
  let out = t;
  if (!out && body.code && typeof body.code === 'object') out = `[code${typeof body.code.filename === 'string' && body.code.filename ? `: ${body.code.filename}` : ''}]`;
  if (!out && Array.isArray(body.attachments) && body.attachments.length) out = body.attachments.some((a) => a?.kind === 'audio') ? '[voice message]' : '[image]';
  if (!out && body.poll && typeof body.poll.q === 'string') out = `[poll] ${body.poll.q}`;
  if (!out && body.gif) out = '[GIF]';
  return out.length > MAX_EXCERPT ? `${out.slice(0, MAX_EXCERPT - 1)}…` : out;
}

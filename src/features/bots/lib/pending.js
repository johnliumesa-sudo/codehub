// Keyword-trigger replies waiting for their original message. The send hook runs before the
// member's message is written, so it queues the reply here; the composer host (BotsHost) takes it
// once that message shows up in the conversation, so the reply always lands after it. Entries
// expire after PENDING_TTL (the original was refused or never sent). Pure, unit-tested.

export const PENDING_TTL = 20_000;
let pending = []; // [{ scope, uid, text, known: Set<mid>, at, draft }]
const consumed = new Set(); // mids that already released a reply (bounded)
const listeners = new Set();

/** Called whenever a reply is queued (the host then checks the loaded messages again). */
export function onPending(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Queue a reply: { scope, uid, text (trimmed original), known (mids loaded at send time), at, draft }. */
export function queueReply(item, now = Date.now()) {
  pending = [...pending.filter((p) => now - p.at < PENDING_TTL), item];
  for (const fn of [...listeners]) fn();
}

/**
 * Replies of `scope` whose original message now appears in `messages`: a message by `uid` that was
 * not loaded when the hook ran, is not a bot message and has the same text. Each message releases
 * at most one reply, ever. Returned replies leave the queue, in queue order.
 */
export function takeReady(scope, uid, messages, now = Date.now()) {
  pending = pending.filter((p) => now - p.at < PENDING_TTL);
  const used = consumed;
  const ready = [];
  for (const p of pending) {
    if (p.scope !== scope || p.uid !== uid) continue;
    const m = (messages || []).find((x) => x && x.uid === uid && !used.has(x.mid) && !p.known.has(x.mid) && x.body && !x.body.bot
      && typeof x.body.text === 'string' && x.body.text.trim() === p.text);
    if (!m) continue;
    used.add(m.mid);
    ready.push(p);
  }
  if (ready.length) pending = pending.filter((p) => !ready.includes(p));
  if (consumed.size > 500) [...consumed].slice(0, consumed.size - 500).forEach((mid) => consumed.delete(mid));
  return ready;
}

/** Number of queued replies (tests). */
export const pendingCount = () => pending.length;

/** Forget every queued reply (tests). */
export function clearPending() {
  pending = [];
  consumed.clear();
}

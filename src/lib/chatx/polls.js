// Polls. The poll definition lives inside the encrypted message body (`body.poll = { q, options[] }`).
// Votes are plaintext by necessity (RTDB rules must enforce one vote per user): votes/{ch/{sid}/{cid} | dm/{dmId} | grp/{gid}}/{mid}/{uid}
// = option index. Option text stays encrypted; only "user X picked option #n" is visible to the server.
import { onValue, ref, remove, set } from 'firebase/database';
import { db } from '../firebase.js';
import { typingPath } from '../messages.js';

export const MAX_POLL_OPTIONS = 10;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_Q = 200;
export const MAX_POLL_OPTION = 80;

// Split by conversation kind (ch/{sid}/{cid} | dm/{dmId} | grp/{gid}) so rules can check membership.
export const votesPath = (conv, mid) => `votes/${typingPath(conv)}/${mid}`;

/** Normalises a poll draft. Returns { poll } or { error }. */
export function buildPoll(q, options) {
  const question = String(q || '').trim();
  if (!question) return { error: 'Ask a question.' };
  if (question.length > MAX_POLL_Q) return { error: `Question is too long (max ${MAX_POLL_Q}).` };
  const opts = (options || []).map((o) => String(o || '').trim()).filter(Boolean);
  if (opts.length < MIN_POLL_OPTIONS) return { error: `Add at least ${MIN_POLL_OPTIONS} options.` };
  if (opts.length > MAX_POLL_OPTIONS) return { error: `At most ${MAX_POLL_OPTIONS} options.` };
  if (opts.some((o) => o.length > MAX_POLL_OPTION)) return { error: `Options max ${MAX_POLL_OPTION} characters.` };
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return { error: 'Options must be different.' };
  return { poll: { q: question, options: opts } };
}

/** Untrusted-input guard for a decrypted body.poll; returns a clean poll or null. */
export function sanitizePoll(p) {
  if (!p || typeof p !== 'object' || typeof p.q !== 'string' || !Array.isArray(p.options)) return null;
  const options = p.options.slice(0, MAX_POLL_OPTIONS).filter((o) => typeof o === 'string').map((o) => o.slice(0, MAX_POLL_OPTION));
  if (options.length < MIN_POLL_OPTIONS) return null;
  return { q: p.q.slice(0, MAX_POLL_Q), options };
}

/** votes: { uid: index } -> { counts[], total, mine } */
export function tally(votes, optionCount, myUid) {
  const counts = new Array(optionCount).fill(0);
  let total = 0;
  for (const v of Object.values(votes || {})) {
    if (Number.isInteger(v) && v >= 0 && v < optionCount) {
      counts[v]++;
      total++;
    }
  }
  // The rules only see an index 0-9 (the options are encrypted); ignore a vote past this poll's options.
  const v = votes?.[myUid];
  const mine = Number.isInteger(v) && v >= 0 && v < optionCount ? v : null;
  return { counts, total, mine };
}

export function subscribeVotes(conv, mid, cb) {
  return onValue(
    ref(db, votesPath(conv, mid)),
    (snap) => cb(snap.val() || {}),
    () => cb({}),
  );
}

/** Vote for an option, or retract when `index` is null / equals the current vote. */
export function castVote(conv, mid, uid, index) {
  const r = ref(db, `${votesPath(conv, mid)}/${uid}`);
  return index === null ? remove(r) : set(r, index);
}

// Forwarding: re-encrypts a message into another conversation's key as a brand-new message with
// `fwd: { from }` attribution (display name of the original author; never trusted for identity).
// Text, code and GIFs are copied. Image attachments are not: they are encrypted under the source
// conversation's key, so a forward would need a fresh upload.
import { get, ref } from 'firebase/database';
import { db } from '../firebase.js';
import { sendMessage } from '../messages.js';

const isPermissionDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e || ''));

export function forwardBody(body, fromName) {
  const out = { text: body?.text || '', fwd: { from: String(fromName || 'Unknown').slice(0, 64) } };
  if (body?.code?.content) out.code = { lang: body.code.lang, content: body.code.content, filename: body.code.filename };
  if (body?.gif?.url) out.gif = body.gif;
  return out;
}

async function slowmodeOf(target) {
  if (target.kind !== 'channel') return 0;
  try {
    const v = (await get(ref(db, `servers/${target.sid}/channels/${target.cid}/slowmode`))).val();
    return typeof v === 'number' && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Sends the forward and waits for the server to accept it. Resolves { mid }.
 * In a slowmode channel the write carries the lastPost stamp the rules require; if that is refused
 * (posted too recently), it is retried once without it, which succeeds only for exempt moderators.
 */
export async function forwardMessage(target, me, body, fromName) {
  const b = forwardBody(body, fromName);
  if (!b.text && !b.code && !b.gif) throw new Error('Nothing to forward.');
  const seconds = await slowmodeOf(target);
  const first = await sendMessage(target, me, b, { slow: { seconds } });
  try {
    await first.done;
    return { mid: first.mid };
  } catch (e) {
    if (!seconds || !isPermissionDenied(e)) throw e;
  }
  const retry = await sendMessage(target, me, b, { slow: { seconds, bypass: true } });
  try {
    await retry.done;
  } catch (e) {
    throw isPermissionDenied(e) ? new Error('Slowmode is on in that channel. Try again in a moment.') : e;
  }
  return { mid: retry.mid };
}

/** Validates a decrypted body.fwd; returns { from } or null. */
export function sanitizeFwd(f) {
  return f && typeof f === 'object' && typeof f.from === 'string' ? { from: f.from.slice(0, 64) } : null;
}

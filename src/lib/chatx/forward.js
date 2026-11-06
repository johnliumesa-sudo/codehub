// Forwarding: re-encrypts a message into another conversation's key as a brand-new message with
// `fwd: { from }` attribution (display name of the original author; never trusted for identity).
import { sendMessage } from '../messages.js';

export function forwardBody(body, fromName) {
  const out = { text: body?.text || '', fwd: { from: String(fromName || 'Unknown').slice(0, 64) } };
  if (body?.code?.content) out.code = { lang: body.code.lang, content: body.code.content, filename: body.code.filename };
  return out;
}

/** Sends the forward. Needs messages.js cleanBody to keep `fwd` (see integration steps). */
export async function forwardMessage(targetConv, me, body, fromName) {
  const b = forwardBody(body, fromName);
  if (!b.text && !b.code) throw new Error('Nothing to forward.');
  return sendMessage(targetConv, me, b);
}

/** Validates a decrypted body.fwd; returns { from } or null. */
export function sanitizeFwd(f) {
  return f && typeof f === 'object' && typeof f.from === 'string' ? { from: f.from.slice(0, 64) } : null;
}

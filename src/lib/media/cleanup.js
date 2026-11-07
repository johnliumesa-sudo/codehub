// Best-effort removal of encrypted image attachments (att/{scope}/{attId}) belonging to messages that are
// about to disappear: a deleted channel, server or group, or a deleted account's own messages.
// Attachment ids only exist inside the encrypted message bodies, so the messages are decrypted here
// first. Each attachment is removed on its own; the rules allow the uploader and, in servers and
// groups, moderators / the group owner. Anything refused or already gone is skipped.
import { get, ref } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptMessage, getConvKey, messagesPath } from '../messages.js';
import { deleteAttachments } from './attachments.js';

/** Attachments referenced by raw message records ({ mid: record }); only `onlyUid`'s messages if given. */
export async function attachmentsIn(conv, records, { onlyUid } = {}) {
  const rows = Object.entries(records || {}).filter(
    ([, r]) => r && r.iv && r.ct && !r.deleted && (!onlyUid || r.uid === onlyUid),
  );
  if (!rows.length) return [];
  // Group messages open with their own epoch's key inside decryptMessage; others share one key.
  const key = conv.kind === 'group' ? null : await getConvKey(conv).catch(() => null);
  if (conv.kind !== 'group' && !key) return [];
  const found = [];
  for (const [mid, r] of rows) {
    try {
      const body = await decryptMessage(key, conv, mid, r);
      if (Array.isArray(body?.attachments)) found.push(...body.attachments);
    } catch {
      /* undecryptable: nothing we can find */
    }
  }
  return found;
}

/** Delete the attachments of the given raw messages. Never throws; resolves the number found. */
export async function purgeAttachments(conv, records, opts) {
  try {
    const atts = await attachmentsIn(conv, records, opts);
    for (let i = 0; i < atts.length; i += 20) await deleteAttachments(conv, atts.slice(i, i + 20)).catch(() => {});
    return atts.length;
  } catch {
    return 0;
  }
}

/** Load a whole conversation and delete its attachments (or only `onlyUid`'s). Never throws. */
export async function purgeConversationAttachments(conv, opts) {
  try {
    const snap = await get(ref(db, messagesPath(conv)));
    return await purgeAttachments(conv, snap.val(), opts);
  } catch {
    return 0;
  }
}

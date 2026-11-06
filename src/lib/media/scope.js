// Conversation scope -> key resolution shared by attachments (and anything else keyed per
// conversation). `conv` is the ChatView descriptor from src/lib/messages.js:
//   { kind: 'channel', sid, cid } | { kind: 'dm', dmId, peerUid } | { kind: 'group', gid, epoch }
// Scope strings: ch_{sid}_{cid} | dm_{dmId} | grp_{gid}. Push ids may contain '_', so a channel
// scope string cannot be split back into sid/cid; always pass the descriptor.
import { get, ref } from 'firebase/database';
import { db } from '../firebase.js';
import { currentUid, getDmKey, getServerKey } from '../keystore.js';
import { getGroupKey } from '../groups.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(v, what) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error(`Invalid ${what}`);
  return v;
}

/** Scope string for a conversation descriptor. */
export function scopeOf(conv) {
  if (!conv) throw new Error('No conversation');
  if (conv.kind === 'channel') return `ch_${checkId(conv.sid, 'server')}_${checkId(conv.cid, 'channel')}`;
  if (conv.kind === 'dm') return `dm_${checkId(conv.dmId, 'DM')}`;
  if (conv.kind === 'group') return `grp_${checkId(conv.gid, 'group')}`;
  throw new Error('Unknown conversation kind');
}

/** Peer of a DM (from the descriptor, or derived from the dmId `uidA_uidB`). */
export function dmPeer(conv) {
  if (conv.peerUid) return conv.peerUid;
  const me = currentUid();
  const [a, b] = String(conv.dmId).split('_');
  return a === me ? b : a;
}

/** The group's current epoch as stored in the database (rules compare against it). */
export async function currentGroupEpoch(gid) {
  const s = await get(ref(db, `groups/${gid}/meta/epoch`));
  const ep = s.val();
  if (!Number.isInteger(ep) || ep < 1) throw new Error('Group key is not ready');
  return ep;
}

/**
 * Key for a conversation. For groups pass the epoch stored next to the ciphertext; omit it when
 * encrypting to use the group's current epoch. Resolves { key, epoch } (epoch null for non-groups).
 */
export async function keyForScope(conv, epoch) {
  if (conv.kind === 'channel') return { key: await getServerKey(conv.sid), epoch: null };
  if (conv.kind === 'dm') return { key: await getDmKey(conv.dmId, dmPeer(conv)), epoch: null };
  if (conv.kind === 'group') {
    const ep = epoch == null ? await currentGroupEpoch(conv.gid) : Number(epoch);
    return { key: await getGroupKey(conv.gid, ep), epoch: ep };
  }
  throw new Error('Unknown conversation kind');
}

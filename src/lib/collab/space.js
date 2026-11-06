// A collab "space" describes where a collaborative workspace lives in the database and how its
// ciphertext is bound to that location (AAD strings). Two kinds exist:
//
//   channelSpace(sid, cid)  a server code channel   -> collab/{sid}/{cid}, server room key
//   codespaceSpace(csid)    a standalone codespace  -> csCollab/{csid},    codespace key
//
// channelSpace reproduces the pre-existing AAD strings and deterministic-fid material byte for
// byte (cfile/cupd/csnap/caw/crepo/cfid), so data written before spaces existed keeps decrypting.
// Codespaces use their own prefixes (csfile/csupd/cssnap/csaw/csrepo/csfid) so a ciphertext can
// never be replayed from one container kind into the other.
//
// Space objects are plain, immutable descriptors. Compare spaces by `id` (+ `kind`), never by
// object identity: React hooks key their effects on `spaceKey(space)`.
import { getServerKey } from '../keystore.js';
// Cyclic at module level (codespaces.js -> workspace.js -> provider.js -> space.js) but safe:
// getCodespaceKey is only called lazily from space.getKey(), never during module evaluation.
import { getCodespaceKey } from '../codespaces.js';

/** Space for a server's code channel. Strings are identical to the original codec.js AAD table. */
export function channelSpace(sid, cid) {
  if (!sid || !cid) throw new Error('channelSpace needs sid and cid');
  return Object.freeze({
    kind: 'channel',
    id: `${sid}/${cid}`,
    sid,
    cid,
    base: `collab/${sid}/${cid}`,
    aad: Object.freeze({
      file: (fid) => `cfile:${sid}/${cid}/${fid}`,
      update: (fid) => `cupd:${sid}/${cid}/${fid}`,
      snapshot: (fid) => `csnap:${sid}/${cid}/${fid}`,
      awareness: (fid, uid) => `caw:${sid}/${cid}/${fid}/${uid}`,
      repo: () => `crepo:${sid}/${cid}`,
      checkpoint: (fid, cpid) => `cchk:${sid}/${cid}/${fid}/${cpid}`,
    }),
    // Identical to the original importFid material: `cfid:${sid}/${cid}:${keyB64}:${path}`.
    fidMaterial: (keyB64, path) => `cfid:${sid}/${cid}:${keyB64}:${path}`,
    getKey: () => getServerKey(sid),
  });
}

/** Space for a standalone codespace. */
export function codespaceSpace(csid) {
  if (!csid) throw new Error('codespaceSpace needs csid');
  return Object.freeze({
    kind: 'codespace',
    id: csid,
    csid,
    base: `csCollab/${csid}`,
    aad: Object.freeze({
      file: (fid) => `csfile:${csid}/${fid}`,
      update: (fid) => `csupd:${csid}/${fid}`,
      snapshot: (fid) => `cssnap:${csid}/${fid}`,
      awareness: (fid, uid) => `csaw:${csid}/${fid}/${uid}`,
      repo: () => `csrepo:${csid}`,
      checkpoint: (fid, cpid) => `cschk:${csid}/${fid}/${cpid}`,
    }),
    fidMaterial: (keyB64, path) => `csfid:${csid}:${keyB64}:${path}`,
    getKey: () => getCodespaceKey(csid),
  });
}

/** True for objects produced by channelSpace / codespaceSpace. */
export function isSpace(v) {
  return !!v && typeof v === 'object' && (v.kind === 'channel' || v.kind === 'codespace') && typeof v.base === 'string' && !!v.aad;
}

/**
 * Backward compatibility for legacy call sites that pass `{ sid, cid }` instead of `{ space }`.
 * Returns the given space, or builds channelSpace(sid, cid).
 */
export function resolveSpace({ space, sid, cid } = {}) {
  if (isSpace(space)) return space;
  if (sid && cid) return channelSpace(sid, cid);
  throw new Error('A collab space (or sid + cid) is required');
}

/**
 * Positional variant for hooks that used to take (sid, cid, ...rest): accepts either
 * (space, ...rest) or (sid, cid, ...rest). Returns [space, ...rest].
 */
export function spaceArgs(first, ...rest) {
  if (isSpace(first)) return [first, ...rest];
  const [cid, ...more] = rest;
  return [channelSpace(first, cid), ...more];
}

/** Stable string identity for React effect deps / cache keys. */
export const spaceKey = (space) => (space ? `${space.kind}:${space.id}` : '');

/**
 * localStorage key for "last open file" in this space. For channels this is exactly the original
 * `codehub.collab.active.${sid}.${cid}` so users keep their last-open file across the refactor.
 */
export function spaceStorageKey(space) {
  if (space.kind === 'channel') return `codehub.collab.active.${space.sid}.${space.cid}`;
  return `codehub.collab.active.cs.${space.csid}`;
}

/** Read/unread scope id (0.6): `{sid}_{cid}` for channels, `cs_{csid}` for codespaces. */
export function spaceScope(space) {
  return space.kind === 'channel' ? `${space.sid}_${space.cid}` : `cs_${space.csid}`;
}

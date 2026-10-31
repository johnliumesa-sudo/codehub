// Binary framing + encryption for collab payloads (Yjs updates, snapshots, awareness).
//
// Plaintext frame (before AES-GCM):  [flag:u8][body...]
//   flag 0 = body is raw bytes, flag 1 = body is deflate-raw compressed (CompressionStream).
// The frame is then encrypted with crypto.encryptBytes(key, frame, aad) -> { iv, ct }.
// Compression happens BEFORE encryption, so the server only ever sees ciphertext.
import { decryptBytes, encryptBytes } from '../crypto.js';

// Per-kind ciphertext caps (base64url chars), kept just under database.rules.json:
//   updates/{fid}/{pushId}.ct  <= 1,400,000   snapshots/{fid}.ct <= 2,800,000
//   awareness/{fid}/{uid}.ct   <= 16,384
export const LIMITS = {
  update: 1_390_000,
  snapshot: 2_790_000,
  awareness: 16_000,
};
export const MAX_CT_CHARS = LIMITS.update;
// Largest local insert we accept in one transaction: even incompressible text then stays well
// under the update cap after framing, AES-GCM and base64 (x4/3).
export const MAX_INSERT_BYTES = 900_000;

export const AAD = {
  file: (sid, cid, fid) => `cfile:${sid}/${cid}/${fid}`,
  update: (sid, cid, fid) => `cupd:${sid}/${cid}/${fid}`,
  snapshot: (sid, cid, fid) => `csnap:${sid}/${cid}/${fid}`,
  awareness: (sid, cid, fid, uid) => `caw:${sid}/${cid}/${fid}/${uid}`,
  repo: (sid, cid) => `crepo:${sid}/${cid}`,
};

export class PayloadTooLargeError extends Error {
  constructor(size, limit = MAX_CT_CHARS) {
    super(`Payload too large to sync (${Math.round(size / 1024)} KB encrypted, limit ${Math.round(limit / 1024)} KB)`);
    this.name = 'PayloadTooLargeError';
  }
}

const canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function frame(bytes) {
  // Tiny payloads (cursor moves, single keystrokes) aren't worth compressing.
  if (canCompress && bytes.length > 96) {
    try {
      const z = await pipe(bytes, new CompressionStream('deflate-raw'));
      if (z.length < bytes.length) {
        const out = new Uint8Array(z.length + 1);
        out[0] = 1;
        out.set(z, 1);
        return out;
      }
    } catch {
      /* fall through to raw */
    }
  }
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0;
  out.set(bytes, 1);
  return out;
}

async function unframe(bytes) {
  if (bytes.length === 0) throw new Error('Empty collab payload');
  const flag = bytes[0];
  const body = bytes.subarray(1);
  if (flag === 0) return body;
  if (flag === 1) {
    if (!canCompress) throw new Error('This browser cannot decompress collab data');
    return pipe(body, new DecompressionStream('deflate-raw'));
  }
  throw new Error('Unknown collab payload format');
}

/**
 * Encrypt bytes into an { iv, ct } box. `limit` is the rules cap for this payload kind
 * (LIMITS.update | LIMITS.snapshot | LIMITS.awareness). Throws PayloadTooLargeError when over it.
 */
export async function sealBytes(key, bytes, aad, limit = LIMITS.update) {
  const box = await encryptBytes(key, await frame(bytes), aad);
  if (box.ct.length > limit) throw new PayloadTooLargeError(box.ct.length, limit);
  return box;
}

/** Decrypt an { iv, ct } box produced by sealBytes. */
export async function openBytes(key, box, aad) {
  return unframe(await decryptBytes(key, { iv: box.iv, ct: box.ct }, aad));
}

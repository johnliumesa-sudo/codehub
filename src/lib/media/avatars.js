// Profile pictures: avatars/{uid} = { data (base64 ≤ 65536 chars), mime, ts }. Plaintext by design
// (any signed-in user reads; only the owner writes). One shared listener per uid.
import { ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from '../firebase.js';
import { createSharedStore, useShared } from './cache.js';
import { dataUrl, processImage } from './image.js';

export const AVATAR_MAX_DIM = 256;
export const AVATAR_MAX_BYTES = 48 * 1024; // base64 of 48 KB = 65536 chars (rules cap)
const AVATAR_MIMES = ['image/webp', 'image/jpeg', 'image/png'];

const avatarStore = createSharedStore(
  (uid) => `avatars/${uid}`,
  (raw) => {
    if (!raw || !AVATAR_MIMES.includes(raw.mime)) return null;
    const src = dataUrl(raw.mime, raw.data);
    return src ? { src, ts: raw.ts || 0 } : null;
  },
);

/** Compresses `file` to ≤256 px / ≤48 KB and stores it as my avatar. */
export async function setAvatar(uid, file) {
  if (!uid) throw new Error('Not signed in');
  const img = await processImage(file, { maxDim: AVATAR_MAX_DIM, maxBytes: AVATAR_MAX_BYTES, allowAnimated: false });
  if (!AVATAR_MIMES.includes(img.mime) || img.base64.length > 65536) throw new Error('Could not compress that image small enough');
  await set(ref(db, `avatars/${uid}`), { data: img.base64, mime: img.mime, ts: serverTimestamp() });
  return { src: dataUrl(img.mime, img.base64) };
}

export function clearAvatar(uid) {
  if (!uid) return Promise.reject(new Error('Not signed in'));
  return remove(ref(db, `avatars/${uid}`));
}

/** { src } for a user's picture, or null (loading or none) so callers render initials. */
export function useAvatar(uid) {
  return useShared(avatarStore, uid || null);
}

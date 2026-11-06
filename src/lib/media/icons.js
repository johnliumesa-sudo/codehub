// Server icons: servers/{sid}/icon = { iv, ct } with ct = AES-GCM(server key, JSON { mime, data },
// AAD `server-icon:{sid}`), ct ≤ 90000 chars. Owner/admin write; members read.
import { ref, remove, set } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptJSON, encryptJSON } from '../crypto.js';
import { getServerKey } from '../keystore.js';
import { createSharedStore, useShared } from './cache.js';
import { dataUrl, processImage } from './image.js';

export const serverIconAad = (sid) => `server-icon:${sid}`;
export const ICON_MAX_DIM = 256;
export const ICON_MAX_BYTES = 48 * 1024; // keeps ct (base64url of base64 JSON) under 90000 chars
const MAX_CT = 90000;

const iconStore = createSharedStore(
  (sid) => `servers/${sid}/icon`,
  async (raw, sid) => {
    if (!raw?.iv || !raw?.ct) return null;
    const key = await getServerKey(sid);
    const body = await decryptJSON(key, raw, serverIconAad(sid));
    const src = dataUrl(body?.mime, body?.data);
    return src ? { src } : null;
  },
);

export async function setServerIcon(sid, file) {
  if (!sid) throw new Error('No server');
  const img = await processImage(file, { maxDim: ICON_MAX_DIM, maxBytes: ICON_MAX_BYTES, allowAnimated: false });
  const key = await getServerKey(sid);
  const box = await encryptJSON(key, { mime: img.mime, data: img.base64 }, serverIconAad(sid));
  if (box.ct.length > MAX_CT) throw new Error('Could not compress that image small enough');
  await set(ref(db, `servers/${sid}/icon`), box);
  return { src: dataUrl(img.mime, img.base64) };
}

export function clearServerIcon(sid) {
  return remove(ref(db, `servers/${sid}/icon`));
}

/** { src } for a server's icon, or null (loading, none, or undecryptable) -> initials fallback. */
export function useServerIcon(sid) {
  return useShared(iconStore, sid || null);
}

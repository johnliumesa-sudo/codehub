// Custom server emotes: emotes/{sid}/{eid} = { iv, ct, by, ts }, ct = AES-GCM(server key,
// JSON { name, mime, data }, AAD `emote:{sid}/{eid}`), ct ≤ 90000. Needs manageEmotes to write.
// Static or animated GIF/WebP, ≤128 px. Byte cap is 48 KB so the ciphertext fits the 90000 rule.
import { push, ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptJSON, encryptJSON } from '../crypto.js';
import { currentUid, getServerKey } from '../keystore.js';
import { createSharedStore, useShared } from './cache.js';
import { dataUrl, processImage } from './image.js';

export const emoteAad = (sid, eid) => `emote:${sid}/${eid}`;
export const EMOTE_NAME_RE = /^[a-z0-9_]{2,32}$/;
export const MAX_EMOTES = 50;
export const EMOTE_MAX_DIM = 128;
export const EMOTE_MAX_BYTES = 48 * 1024;
const MAX_CT = 90000;
/** Matches `:name:` tokens in text (group 1 = name). */
export const EMOTE_TOKEN_RE = /:([a-z0-9_]{2,32}):/g;

export const cleanEmoteName = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);

const decCache = new Map(); // `${sid}/${eid}|${iv}` -> Promise<{name,src}|null>

function decryptEmote(sid, eid, raw) {
  const k = `${sid}/${eid}|${raw.iv}`;
  let p = decCache.get(k);
  if (!p) {
    p = getServerKey(sid)
      .then((key) => decryptJSON(key, raw, emoteAad(sid, eid)))
      .then((b) => {
        const src = dataUrl(b?.mime, b?.data);
        return src && EMOTE_NAME_RE.test(b.name) ? { name: b.name, src } : null;
      })
      .catch(() => null);
    decCache.set(k, p);
  }
  return p;
}

const emoteStore = createSharedStore(
  (sid) => `emotes/${sid}`,
  async (raw, sid) => {
    const ids = Object.keys(raw || {});
    const out = await Promise.all(
      ids.map(async (eid) => {
        const r = raw[eid];
        if (!r?.iv || !r?.ct) return null;
        const e = await decryptEmote(sid, eid, r);
        return e ? { eid, name: e.name, src: e.src, by: r.by, ts: r.ts || 0 } : null;
      }),
    );
    // First-added wins when two emotes share a name.
    const seen = new Set();
    return out
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts)
      .filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
);

/** Emotes of a server, sorted by name: [{ eid, name, src, by, ts }] ([] while loading). */
export function useEmotes(sid) {
  return useShared(emoteStore, sid || null) || EMPTY;
}
const EMPTY = Object.freeze([]);

/** Promise of the current emote list (waits for the first load). */
export async function getEmotes(sid) {
  return (await emoteStore.read(sid)) || [];
}

/** name -> src lookup for rendering `:name:`. */
export function emoteMap(list) {
  const m = new Map();
  for (const e of list || []) m.set(e.name, e.src);
  return m;
}

/** Splits text into strings and { emote: name, src } parts for known emotes. */
export function splitEmotes(text, map) {
  const s = String(text ?? '');
  if (!map || map.size === 0 || !s.includes(':')) return [s];
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(EMOTE_TOKEN_RE)) {
    const src = map.get(m[1]);
    if (!src) continue;
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push({ emote: m[1], src });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

export async function addEmote(sid, name, file) {
  const uid = currentUid();
  if (!uid) throw new Error('Vault is locked');
  const clean = String(name || '').trim().toLowerCase();
  if (!EMOTE_NAME_RE.test(clean)) throw new Error('Emote names are 2–32 characters: a–z, 0–9 and _');
  const existing = await getEmotes(sid);
  if (existing.length >= MAX_EMOTES) throw new Error(`A server can have at most ${MAX_EMOTES} emotes`);
  if (existing.some((e) => e.name === clean)) throw new Error(`:${clean}: already exists`);
  const img = await processImage(file, { maxDim: EMOTE_MAX_DIM, maxBytes: EMOTE_MAX_BYTES, allowAnimated: true });
  const eid = push(ref(db, `emotes/${sid}`)).key;
  const key = await getServerKey(sid);
  const box = await encryptJSON(key, { name: clean, mime: img.mime, data: img.base64 }, emoteAad(sid, eid));
  if (box.ct.length > MAX_CT) throw new Error('That emote is too large after encryption; try a smaller image');
  await set(ref(db, `emotes/${sid}/${eid}`), { iv: box.iv, ct: box.ct, by: uid, ts: serverTimestamp() });
  return { eid, name: clean, src: dataUrl(img.mime, img.base64) };
}

export function deleteEmote(sid, eid) {
  return remove(ref(db, `emotes/${sid}/${eid}`));
}

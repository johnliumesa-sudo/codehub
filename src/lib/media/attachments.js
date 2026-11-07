// Encrypted image attachments (RTDB only; Spark plan).
//   att/{scope}/{attId}/meta = { by, ts, n, size, iv, ct, epoch?, sid?, cid?, gid? }
//       ct = AES-GCM(conv key, JSON { mime, w, h, name }, AAD `att-meta:{scope}/{attId}`)
//       sid/cid (channel) or gid+epoch (group) let the rules check membership, since push ids
//       may contain '_' and rules cannot split the scope string.
//   att/{scope}/{attId}/c/{i} = { iv, ct }   i ∈ 0..7, ct ≤ 100000, AAD `att:{scope}/{attId}/{i}`
// Messages reference attachments as body.attachments = [{ attId, w, h, mime, size }] (≤ 4).
// Voice messages (round 3) are attachments too: { attId, kind: 'audio', mime, size, dur, wave } (at most
// one per message, ≤ 512 KB, see audio.js); the encrypted meta holds { kind: 'audio', mime, dur, name }.
// Chunks are fetched lazily (IntersectionObserver; voice messages on first play) and kept as object
// URLs in a ≤ 50 MB LRU.
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, push, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptBytes, decryptJSON, encryptBytes, encryptJSON } from '../crypto.js';
import { currentUid } from '../keystore.js';
import { blobCache } from './cache.js';
import { STORED_MIMES, assertDims, processImage } from './image.js';
import { keyForScope, scopeOf } from './scope.js';
import { AUDIO_MAX_BYTES, AUDIO_MIMES, cleanAudioAtt } from './audio.js';

export const MAX_ATTACHMENTS = 4;
export const ATT_MAX_DIM = 1600;
export const ATT_MAX_BYTES = 500 * 1024;
export const ATT_CHUNK_BYTES = 74_000; // base64url(74000 + 16 tag) ≈ 98688 ≤ 100000
export const ATT_MAX_CHUNKS = 8;

export const attMetaAad = (scope, attId) => `att-meta:${scope}/${attId}`;
export const attChunkAad = (scope, attId, i) => `att:${scope}/${attId}/${i}`;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validates and normalises body.attachments from a decrypted message (drops anything malformed).
 * Images keep { attId, mime, w, h, size }; a voice message (at most one) keeps cleanAudioAtt's shape.
 */
export function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  let audio = 0;
  const out = [];
  for (const a of list) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (a?.kind === 'audio') {
      const clean = audio === 0 ? cleanAudioAtt(a) : null;
      if (clean) {
        audio++;
        out.push(clean);
      }
      continue;
    }
    if (!a || a.kind !== undefined || !ID_RE.test(a.attId) || !STORED_MIMES.includes(a.mime)) continue;
    out.push({
      attId: a.attId,
      mime: a.mime,
      w: Math.max(1, Math.min(ATT_MAX_DIM, Number(a.w) | 0)),
      h: Math.max(1, Math.min(ATT_MAX_DIM, Number(a.h) | 0)),
      size: Math.max(0, Number(a.size) | 0),
    });
  }
  return out;
}

/**
 * Compresses, encrypts and uploads up to 4 images into the conversation.
 * @param conv  conversation descriptor ({ kind:'channel', sid, cid } | { kind:'dm', dmId, peerUid } | { kind:'group', gid })
 * @param {File[]} files
 * @param {{ onProgress?: (fraction: number) => void }} opts
 * @returns {Promise<Array<{ attId, w, h, mime, size }>>}
 */
export async function uploadAttachments(conv, files, { onProgress } = {}) {
  const uid = currentUid();
  if (!uid) throw new Error('Vault is locked');
  const list = Array.from(files || []);
  if (list.length === 0) return [];
  if (list.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} images per message`);
  const scope = scopeOf(conv);
  const { key, epoch } = await keyForScope(conv);

  const images = [];
  for (const f of list) {
    images.push({ name: String(f.name || 'image').slice(0, 120), img: await processImage(f, { maxDim: ATT_MAX_DIM, maxBytes: ATT_MAX_BYTES, allowAnimated: true }) });
  }

  const plans = await Promise.all(
    images.map(async ({ name, img }) => {
      const bytes = new Uint8Array(await img.blob.arrayBuffer());
      const n = Math.ceil(bytes.length / ATT_CHUNK_BYTES);
      if (n < 1 || n > ATT_MAX_CHUNKS) throw new Error('Image too large');
      return { name, img, bytes, n, attId: push(ref(db, `att/${scope}`)).key };
    }),
  );
  const totalChunks = plans.reduce((s, p) => s + p.n, 0);
  let done = 0;
  const tick = () => onProgress?.(Math.min(1, done / totalChunks));
  tick();

  const uploaded = [];
  try {
    for (const p of plans) {
      const base = `att/${scope}/${p.attId}`;
      const box = await encryptJSON(key, { mime: p.img.mime, w: p.img.w, h: p.img.h, name: p.name }, attMetaAad(scope, p.attId));
      const meta = { by: uid, ts: serverTimestamp(), n: p.n, size: p.bytes.length, iv: box.iv, ct: box.ct };
      if (epoch != null) meta.epoch = epoch;
      if (conv.kind === 'channel') {
        meta.sid = conv.sid;
        meta.cid = conv.cid;
      } else if (conv.kind === 'group') meta.gid = conv.gid;
      await writeMetaLogged(uid, scope, p.attId, meta);
      uploaded.push(p);
      await Promise.all(
        Array.from({ length: p.n }, async (_, i) => {
          const slice = p.bytes.subarray(i * ATT_CHUNK_BYTES, (i + 1) * ATT_CHUNK_BYTES);
          const c = await encryptBytes(key, slice, attChunkAad(scope, p.attId, i));
          await set(ref(db, `${base}/c/${i}`), { iv: c.iv, ct: c.ct });
          done++;
          tick();
        }),
      );
    }
  } catch (e) {
    await deleteAttachments(conv, uploaded).catch(() => {});
    throw e;
  }
  return plans.map((p) => ({ attId: p.attId, w: p.img.w, h: p.img.h, mime: p.img.mime, size: p.bytes.length }));
}

/**
 * Encrypts and uploads one voice recording into the conversation, exactly like an image (same meta,
 * chunk size, membership rules and upload rate limit). Resolves the body.attachments entry
 * { attId, kind: 'audio', mime, size, dur, wave }.
 * @param {Blob} blob   the recording (≤ 512 KB)
 * @param {{ mime: string, dur: number, wave?: string, onProgress?: (fraction: number) => void }} info
 */
export async function uploadAudio(conv, blob, { mime, dur, wave, onProgress } = {}) {
  const uid = currentUid();
  if (!uid) throw new Error('Vault is locked');
  if (!AUDIO_MIMES.includes(mime)) throw new Error('Unsupported audio format');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length) throw new Error('The recording is empty');
  if (bytes.length > AUDIO_MAX_BYTES) throw new Error('Voice messages can be at most 512 KB');
  const entry = cleanAudioAtt({ attId: 'pending', kind: 'audio', mime, size: bytes.length, dur, wave });
  if (!entry) throw new Error('Invalid recording');
  const n = Math.ceil(bytes.length / ATT_CHUNK_BYTES);
  if (n < 1 || n > ATT_MAX_CHUNKS) throw new Error('Recording too large');
  const scope = scopeOf(conv);
  const { key, epoch } = await keyForScope(conv);
  const attId = push(ref(db, `att/${scope}`)).key;
  const base = `att/${scope}/${attId}`;
  const box = await encryptJSON(key, { kind: 'audio', mime, dur: entry.dur, name: 'voice-message' }, attMetaAad(scope, attId));
  const meta = { by: uid, ts: serverTimestamp(), n, size: bytes.length, iv: box.iv, ct: box.ct };
  if (epoch != null) meta.epoch = epoch;
  if (conv.kind === 'channel') {
    meta.sid = conv.sid;
    meta.cid = conv.cid;
  } else if (conv.kind === 'group') meta.gid = conv.gid;
  let done = 0;
  onProgress?.(0);
  await writeMetaLogged(uid, scope, attId, meta, 'Upload limit reached (24 attachments per 10 minutes). Try again shortly.');
  try {
    await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const slice = bytes.subarray(i * ATT_CHUNK_BYTES, (i + 1) * ATT_CHUNK_BYTES);
        const c = await encryptBytes(key, slice, attChunkAad(scope, attId, i));
        await set(ref(db, `${base}/c/${i}`), { iv: c.iv, ct: c.ct });
        done++;
        onProgress?.(Math.min(1, done / n));
      }),
    );
  } catch (e) {
    await remove(ref(db, base)).catch(() => {});
    throw e;
  }
  return { ...entry, attId };
}

/** Fetches, decrypts and caches one voice message; resolves an object URL. */
export function loadAudio(conv, att) {
  const clean = cleanAudioAtt(att);
  if (!clean) return Promise.reject(new Error('Invalid voice message'));
  const scope = scopeOf(conv);
  return blobCache.load(`${scope}/${clean.attId}`, async () => {
    const base = `att/${scope}/${clean.attId}`;
    const ms = await get(ref(db, `${base}/meta`));
    if (!ms.exists()) throw new Error('Voice message was deleted');
    const meta = ms.val();
    const n = Number(meta.n);
    if (!Number.isInteger(n) || n < 1 || n > ATT_MAX_CHUNKS) throw new Error('Corrupt voice message');
    const { key } = await keyForScope(conv, meta.epoch);
    const info = await decryptJSON(key, meta, attMetaAad(scope, clean.attId));
    if (info?.kind !== 'audio' || !AUDIO_MIMES.includes(info.mime)) throw new Error('Not a voice message');
    const parts = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const cs = await get(ref(db, `${base}/c/${i}`));
        if (!cs.exists()) throw new Error('Voice message is incomplete');
        return decryptBytes(key, cs.val(), attChunkAad(scope, clean.attId, i));
      }),
    );
    const total = parts.reduce((s, p) => s + (p.byteLength ?? p.length ?? 0), 0);
    if (total > AUDIO_MAX_BYTES) throw new Error('Voice message is too large');
    return new Blob(parts, { type: info.mime });
  });
}

/**
 * Rules require each attachment meta write to carry an `attLog/{uid}` update in the
 * same multi-path write (≤24 uploads per 10-minute window). Try continuing the
 * current window first; if the window has expired the rules refuse it, so start a new one.
 */
async function writeMetaLogged(uid, scope, attId, meta, limitMsg = 'Upload limit reached (24 images per 10 minutes). Try again shortly.') {
  const prev = (await get(ref(db, `attLog/${uid}`))).val();
  const attempts = [];
  if (prev && typeof prev.ws === 'number' && typeof prev.n === 'number') attempts.push({ ws: prev.ws, n: prev.n + 1 });
  attempts.push({ ws: serverTimestamp(), n: 1 });
  let lastErr;
  for (const w of attempts) {
    try {
      await update(ref(db), {
        [`att/${scope}/${attId}/meta`]: meta,
        [`attLog/${uid}`]: { ws: w.ws, n: w.n, id: attId, at: serverTimestamp() },
      });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error(limitMsg);
  err.cause = lastErr;
  throw err;
}

/**
 * Removes attachments (author or moderator, per rules). Called after a message is deleted and when a
 * send fails after upload. Each one is removed separately, so one that is already gone (the rules
 * refuse deleting a missing node) doesn't block the others. Throws only if none could be removed.
 */
export async function deleteAttachments(conv, atts) {
  const list = (atts || []).filter((a) => a && ID_RE.test(a.attId));
  if (list.length === 0) return;
  const scope = scopeOf(conv);
  const results = await Promise.allSettled(
    list.map((a) => {
      blobCache.drop(`${scope}/${a.attId}`);
      return remove(ref(db, `att/${scope}/${a.attId}`));
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === list.length) throw failed[0].reason;
}

/** Fetches, decrypts and caches one attachment; resolves an object URL. */
export function loadAttachment(conv, att) {
  const scope = scopeOf(conv);
  const cacheKey = `${scope}/${att.attId}`;
  return blobCache.load(cacheKey, async () => {
    const base = `att/${scope}/${att.attId}`;
    const ms = await get(ref(db, `${base}/meta`));
    if (!ms.exists()) throw new Error('Image was deleted');
    const meta = ms.val();
    const n = Number(meta.n);
    if (!Number.isInteger(n) || n < 1 || n > ATT_MAX_CHUNKS) throw new Error('Corrupt image');
    const { key } = await keyForScope(conv, meta.epoch);
    const info = await decryptJSON(key, meta, attMetaAad(scope, att.attId));
    if (!STORED_MIMES.includes(info?.mime)) throw new Error('Unsupported image type');
    const parts = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const cs = await get(ref(db, `${base}/c/${i}`));
        if (!cs.exists()) throw new Error('Image is incomplete');
        return decryptBytes(key, cs.val(), attChunkAad(scope, att.attId, i));
      }),
    );
    // Stored images are always <= ATT_MAX_DIM per side; refuse anything larger (decompression bomb from a modified client).
    const head = parts[0] instanceof Uint8Array ? parts[0] : new Uint8Array(parts[0]);
    assertDims(head, { maxDim: ATT_MAX_DIM, requireKnown: true });
    return new Blob(parts, { type: info.mime });
  });
}

/**
 * Lazy object URL for an attachment. Attach `ref` to the element that holds the image; chunks load
 * only once it scrolls into view. Returns { ref, src, loading, error }.
 */
export function useAttachmentSrc(conv, att) {
  const scope = conv && att ? safeScope(conv) : null;
  const cacheKey = scope && att?.attId ? `${scope}/${att.attId}` : null;
  const [src, setSrc] = useState(() => (cacheKey ? blobCache.get(cacheKey) : null));
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState(null);
  const obs = useRef(null);
  const convRef = useRef(conv);
  convRef.current = conv;

  const refCb = useCallback((el) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    obs.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.current?.disconnect();
          obs.current = null;
        }
      },
      { rootMargin: '400px 0px' },
    );
    obs.current.observe(el);
  }, []);

  useEffect(() => () => obs.current?.disconnect(), []);

  useEffect(() => {
    setError(null);
    if (!cacheKey) {
      setSrc(null);
      return undefined;
    }
    const hit = blobCache.get(cacheKey);
    setSrc(hit);
    if (!hit && !visible) return undefined;
    let alive = true;
    let pinned = false;
    const pin = (url) => {
      if (!alive) return;
      blobCache.pin(cacheKey);
      pinned = true;
      setSrc(url);
    };
    if (hit) pin(hit);
    else {
      loadAttachment(convRef.current, att)
        .then(pin)
        .catch((e) => alive && setError(e?.message || 'Could not load image'));
    }
    return () => {
      alive = false;
      if (pinned) blobCache.unpin(cacheKey);
    };
    // att identity is captured by cacheKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, visible]);

  return { ref: refCb, src, loading: !!cacheKey && !src && !error, error };
}

function safeScope(conv) {
  try {
    return scopeOf(conv);
  } catch {
    return null;
  }
}

// Encrypted image attachments (RTDB only; Spark plan).
//   att/{scope}/{attId}/meta = { by, ts, n, size, iv, ct, epoch?, sid?, cid?, gid? }
//       ct = AES-GCM(conv key, JSON { mime, w, h, name }, AAD `att-meta:{scope}/{attId}`)
//       sid/cid (channel) or gid+epoch (group) let the rules check membership, since push ids
//       may contain '_' and rules cannot split the scope string.
//   att/{scope}/{attId}/c/{i} = { iv, ct }   i ∈ 0..7, ct ≤ 100000, AAD `att:{scope}/{attId}/{i}`
// Messages reference attachments as body.attachments = [{ attId, w, h, mime, size }] (≤ 4).
// Chunks are fetched lazily (IntersectionObserver) and kept as object URLs in a ≤ 50 MB LRU.
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, push, ref, serverTimestamp, set, update } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptBytes, decryptJSON, encryptBytes, encryptJSON } from '../crypto.js';
import { currentUid } from '../keystore.js';
import { blobCache } from './cache.js';
import { STORED_MIMES, processImage } from './image.js';
import { keyForScope, scopeOf } from './scope.js';

export const MAX_ATTACHMENTS = 4;
export const ATT_MAX_DIM = 1600;
export const ATT_MAX_BYTES = 500 * 1024;
export const ATT_CHUNK_BYTES = 74_000; // base64url(74000 + 16 tag) ≈ 98688 ≤ 100000
export const ATT_MAX_CHUNKS = 8;

export const attMetaAad = (scope, attId) => `att-meta:${scope}/${attId}`;
export const attChunkAad = (scope, attId, i) => `att:${scope}/${attId}/${i}`;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates and normalises body.attachments from a decrypted message (drops anything malformed). */
export function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && ID_RE.test(a.attId) && STORED_MIMES.includes(a.mime))
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({
      attId: a.attId,
      mime: a.mime,
      w: Math.max(1, Math.min(ATT_MAX_DIM, Number(a.w) | 0)),
      h: Math.max(1, Math.min(ATT_MAX_DIM, Number(a.h) | 0)),
      size: Math.max(0, Number(a.size) | 0),
    }));
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
 * Rules require each attachment meta write to carry an `attLog/{uid}` update in the
 * same multi-path write (≤24 uploads per 10-minute window). Try continuing the
 * current window first; if the window has expired the rules refuse it, so start a new one.
 */
async function writeMetaLogged(uid, scope, attId, meta) {
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
  const err = new Error('Upload limit reached (24 images per 10 minutes). Try again shortly.');
  err.cause = lastErr;
  throw err;
}

/** Removes attachments (author or moderator, per rules). Call alongside deleting the message. */
export async function deleteAttachments(conv, atts) {
  const list = (atts || []).filter((a) => a && ID_RE.test(a.attId));
  if (list.length === 0) return;
  const scope = scopeOf(conv);
  const patch = {};
  for (const a of list) {
    patch[a.attId] = null;
    blobCache.drop(`${scope}/${a.attId}`);
  }
  await update(ref(db, `att/${scope}`), patch);
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

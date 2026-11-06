// Named, encrypted per-file checkpoints for collaborative workspaces (F9).
//
//   {space.base}/checkpoints/{fid}/{cpid}  { uid, ts, iv, ct }
//   ct = encryptJSON(spaceKey, { label, text }, space.aad.checkpoint(fid, cpid))
//
// `space` is the descriptor from src/lib/collab/space.js (channelSpace / codespaceSpace):
// the AAD binds every checkpoint to its workspace, file and id, so a member cannot move a
// checkpoint between files or workspaces without decryption failing.
// The per-file cap (MAX_CHECKPOINTS) is enforced in the UI only: RTDB rules cannot count.
import { useEffect, useRef, useState } from 'react';
import { get, onValue, push, ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from './firebase.js';
import { decryptJSON, encryptJSON } from './crypto.js';
import { MAX_INSERT_BYTES } from './collab/codec.js';

export const MAX_CHECKPOINTS = 20;
export const MAX_LABEL = 80;
// Rules cap ct at 1,400,000 base64url chars; stay just under it.
const MAX_CT = 1_390_000;

const enc = new TextEncoder();

export const checkpointsPath = (space, fid) => `${space.base}/checkpoints/${fid}`;

export function cleanLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

export function defaultLabel(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Checkpoint ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Live list of a file's checkpoints, decrypted, newest first.
 * items: [{ cpid, uid, ts, label, text, broken? }]
 */
export function useCheckpoints(space, key, fid) {
  const [state, setState] = useState({ items: [], loading: true, error: null });
  const cacheRef = useRef(new Map()); // cpid -> { ct, value }
  const base = space && fid ? checkpointsPath(space, fid) : null;

  useEffect(() => {
    if (!base || !key) {
      setState({ items: [], loading: false, error: null });
      return undefined;
    }
    let alive = true;
    let seq = 0;
    cacheRef.current = new Map();
    setState({ items: [], loading: true, error: null });
    const unsub = onValue(
      ref(db, base),
      async (snap) => {
        const my = ++seq;
        const raw = snap.val() || {};
        const cache = cacheRef.current;
        const items = await Promise.all(
          Object.entries(raw).map(async ([cpid, v]) => {
            const ct = v?.ct;
            let value = cache.get(cpid)?.ct === ct ? cache.get(cpid).value : null;
            if (!value) {
              try {
                // Untrusted: any writer can store any JSON here. Keep only the two string fields.
                const d = await decryptJSON(key, { iv: v.iv, ct }, space.aad.checkpoint(fid, cpid));
                if (!d || typeof d !== 'object' || typeof d.text !== 'string') throw new Error('bad checkpoint');
                value = { label: cleanLabel(d.label) || 'Untitled checkpoint', text: d.text };
                cache.set(cpid, { ct, value });
              } catch {
                value = { label: 'Undecryptable checkpoint', text: '', broken: true };
              }
            }
            return { cpid, uid: typeof v?.uid === 'string' ? v.uid : null, ts: typeof v?.ts === 'number' ? v.ts : 0, ...value };
          }),
        );
        if (!alive || my !== seq) return;
        items.sort((a, b) => b.ts - a.ts || b.cpid.localeCompare(a.cpid));
        setState({ items, loading: false, error: null });
      },
      (err) => alive && setState({ items: [], loading: false, error: err?.message || 'Could not load checkpoints' }),
    );
    return () => {
      alive = false;
      unsub();
    };
  }, [base, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

/** Encrypt and store a checkpoint. Returns its id. */
export async function saveCheckpoint({ space, key, fid, uid, label, text }) {
  const clean = cleanLabel(label) || defaultLabel();
  const body = String(text ?? '');
  if (enc.encode(body).length > MAX_INSERT_BYTES) {
    throw new Error('This file is too large to checkpoint (limit about 900 KB).');
  }
  const cpRef = push(ref(db, checkpointsPath(space, fid)));
  const cpid = cpRef.key;
  const box = await encryptJSON(key, { label: clean, text: body }, space.aad.checkpoint(fid, cpid));
  if (box.ct.length > MAX_CT) throw new Error('This file is too large to checkpoint once encrypted.');
  await set(cpRef, { uid, ts: serverTimestamp(), iv: box.iv, ct: box.ct });
  return cpid;
}

export function deleteCheckpoint({ space, fid, cpid }) {
  return remove(ref(db, `${checkpointsPath(space, fid)}/${cpid}`));
}

/**
 * Smallest single replacement that turns `oldText` into `newText`:
 * { index, deleteCount, insert }. Splits never land inside a UTF-16 surrogate pair.
 */
export function minimalReplace(oldText, newText) {
  const a = String(oldText ?? '');
  const b = String(newText ?? '');
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  if (pre > 0 && pre < max && isHigh(a.charCodeAt(pre - 1))) pre--;
  let suf = 0;
  while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  if (suf > 0 && isLow(a.charCodeAt(a.length - suf))) suf--;
  return { index: pre, deleteCount: a.length - pre - suf, insert: b.slice(pre, b.length - suf) };
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Replace the whole content of a Y.Text with `text` as ONE transaction containing the minimal
 * delete+insert, so concurrent collaborators converge and the change syncs as a single update.
 * Returns false when nothing changed.
 */
export function replaceYText(ytext, text) {
  const cur = ytext.toString();
  const { index, deleteCount, insert } = minimalReplace(cur, text);
  if (!deleteCount && !insert) return false;
  if (enc.encode(insert).length > MAX_INSERT_BYTES) {
    throw new Error('The change is too large to apply in one step (limit about 900 KB).');
  }
  const doc = ytext.doc;
  const apply = () => {
    if (deleteCount) ytext.delete(index, deleteCount);
    if (insert) ytext.insert(index, insert);
  };
  if (doc) doc.transact(apply);
  else apply();
  return true;
}

/**
 * Can `uid` delete other members' checkpoints in this space?
 * Channel workspace: server owner/admin. Codespace: the codespace owner. (Mirrors the rules.)
 */
export function useCheckpointModerator(space, uid) {
  const [canModerate, setCanModerate] = useState(false);
  const path = !space || !uid
    ? null
    : space.kind === 'codespace'
      ? `codespaces/${space.csid}/meta/ownerId`
      : `servers/${space.sid}/members/${uid}/role`;
  useEffect(() => {
    if (!path) {
      setCanModerate(false);
      return undefined;
    }
    let alive = true;
    get(ref(db, path)).then(
      (s) => {
        if (!alive) return;
        const v = s.val();
        setCanModerate(space.kind === 'codespace' ? v === uid : v === 'owner' || v === 'admin');
      },
      () => alive && setCanModerate(false),
    );
    return () => {
      alive = false;
    };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  return canModerate;
}

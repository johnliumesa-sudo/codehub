// Workspace-level data for a collab space (server code channel or codespace): file list, linked
// GitHub repo, per-file presence. Every function takes a `space` (collab/space.js); the legacy
// (sid, cid) forms are still accepted and mapped to channelSpace(sid, cid).
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { onValue, push, ref, serverTimestamp, set, update } from 'firebase/database';
import { db } from '../firebase.js';
import { b64u, decryptJSON, encryptJSON, exportRoomKey } from '../crypto.js';
import { LIMITS, PayloadTooLargeError, sealBytes } from './codec.js';
import { isValidBranchName, isValidRepoName } from './github.js';
import { TEXT_NAME } from './provider.js';
import { serverNow } from './time.js';
import { resolveSpace, spaceArgs, spaceKey } from './space.js';

export function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

export function validatePath(path, files, exceptFid) {
  if (!path) return 'Enter a file name';
  if (path.length > 300) return 'Path is too long';
  if (files.some((f) => f.fid !== exceptFid && f.path === path)) return 'A file with that path already exists';
  if (files.some((f) => f.fid !== exceptFid && f.path.startsWith(path + '/'))) return 'A folder with that name already exists';
  return null;
}

// ---------- files ----------

/**
 * Live, decrypted file list. files: [{fid, path, repo?, ref?, sha?, createdBy, createdAt, updatedAt, broken?}]
 * useCollabFiles(space, key) — or legacy useCollabFiles(sid, cid, key).
 */
export function useCollabFiles(...args) {
  const [space, key] = spaceArgs(...args);
  const sk = spaceKey(space);
  const [state, setState] = useState({ files: [], loading: true, error: null });
  const cacheRef = useRef(new Map()); // fid -> { ct, meta }

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    let seq = 0;
    cacheRef.current = new Map();
    setState({ files: [], loading: true, error: null });
    const unsub = onValue(
      ref(db, `${space.base}/files`),
      async (snap) => {
        const my = ++seq;
        try {
          const raw = snap.val() || {};
          const cache = cacheRef.current;
          const files = await Promise.all(
            Object.entries(raw).map(async ([fid, v]) => {
              const ct = v?.enc?.ct;
              let meta = cache.get(fid)?.ct === ct ? cache.get(fid).meta : null;
              if (!meta) {
                try {
                  // Untrusted: any member can encrypt any JSON here. Only keep known string fields,
                  // and treat a path that isn't already normalised (e.g. contains `..`) as broken.
                  const m = await decryptJSON(key, v.enc, space.aad.file(fid));
                  if (!m || typeof m !== 'object' || typeof m.path !== 'string' || !m.path) throw new Error('bad meta');
                  const path = normalizePath(m.path);
                  if (!path || path !== m.path || path.length > 300) throw new Error('bad path');
                  meta = { path };
                  for (const f of ['repo', 'ref', 'sha']) if (typeof m[f] === 'string' && m[f]) meta[f] = m[f];
                  cache.set(fid, { ct, meta });
                } catch {
                  meta = { path: `⚠ undecryptable-${fid.slice(-6)}`, broken: true };
                }
              }
              return { fid, ...meta, createdBy: v?.createdBy, createdAt: v?.createdAt, updatedAt: v?.updatedAt };
            }),
          );
          if (!alive || my !== seq) return;
          files.sort((a, b) => a.path.localeCompare(b.path));
          setState({ files, loading: false, error: null });
        } catch (err) {
          console.error('[collab] file list', err);
          if (alive && my === seq) setState({ files: [], loading: false, error: 'Could not load files' });
        }
      },
      (err) => alive && setState({ files: [], loading: false, error: err.message }),
    );
    return () => {
      alive = false;
      unsub();
    };
  }, [sk, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

// Seed update key for imported files. The rules only allow creating an update key that doesn't
// exist yet, so a fixed key turns the whole multi-path create into "create if absent".
// '-0' sorts before every push id.
const SEED_KEY = '-0seed';

/**
 * Deterministic file id for a path imported from GitHub, so two members opening the same remote
 * file at the same moment converge on ONE workspace file. Keyed with the room key, so the server
 * can't test guesses of (encrypted) paths against the id.
 */
export async function importFid({ space, sid, cid, key, path }) {
  const sp = resolveSpace({ space, sid, cid });
  // channelSpace: `cfid:${sid}/${cid}:${keyB64}:${path}` (unchanged); codespaces: `csfid:...`.
  const material = new TextEncoder().encode(sp.fidMaterial(await exportRoomKey(key), path));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  return `gh_${b64u(digest.subarray(0, 16))}`;
}

const isDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e));

/**
 * Create a file. If `content` is given, the Yjs doc is seeded atomically with the file entry
 * (as its first encrypted update), so two people can never seed the same file twice.
 * meta: { path, repo?, ref?, sha? }
 * With `fid` (see importFid) the create only succeeds if that file doesn't exist yet; otherwise
 * it resolves to { fid, existed: true } without touching anything.
 */
export async function createFile({ space, sid, cid, key, uid, meta, content = '', fid: fixedFid }) {
  const sp = resolveSpace({ space, sid, cid });
  const base = sp.base;
  const fid = fixedFid || push(ref(db, `${base}/files`)).key;
  const clean = { path: meta.path };
  if (meta.repo) clean.repo = meta.repo;
  if (meta.ref) clean.ref = meta.ref;
  if (meta.sha) clean.sha = meta.sha;
  const writes = {
    [`files/${fid}`]: {
      enc: await encryptJSON(key, clean, sp.aad.file(fid)),
      createdBy: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
  };
  if (content || fixedFid) {
    const doc = new Y.Doc();
    if (content) doc.getText(TEXT_NAME).insert(0, content);
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    let box;
    try {
      box = await sealBytes(key, bytes, sp.aad.update(fid), LIMITS.update);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) throw new Error('This file is too large to open in the workspace.');
      throw err;
    }
    const k = fixedFid ? SEED_KEY : push(ref(db, `${base}/updates/${fid}`)).key;
    writes[`updates/${fid}/${k}`] = { iv: box.iv, ct: box.ct, uid, ts: serverTimestamp() };
  }
  try {
    await update(ref(db, base), writes);
  } catch (err) {
    // Someone else created this deterministic file first: use theirs.
    if (fixedFid && isDenied(err)) return { fid, existed: true };
    throw err;
  }
  return fixedFid ? { fid, existed: false } : fid;
}

export async function updateFileMeta({ space, sid, cid, key, fid, meta }) {
  const sp = resolveSpace({ space, sid, cid });
  const clean = { path: meta.path };
  if (meta.repo) clean.repo = meta.repo;
  if (meta.ref) clean.ref = meta.ref;
  if (meta.sha) clean.sha = meta.sha;
  await update(ref(db, `${sp.base}/files/${fid}`), {
    enc: await encryptJSON(key, clean, sp.aad.file(fid)),
    updatedAt: serverTimestamp(),
  });
}

// Also removes the file's checkpoints (F9) — needs the `checkpoints` rules branch (WS8 insert for
// collab/$sid/$cid, WS2 csCollab/$csid); falls back to the old path set if the rules predate it.
export async function deleteFile({ space, sid, cid, fid }) {
  const sp = resolveSpace({ space, sid, cid });
  const writes = {
    [`files/${fid}`]: null,
    [`updates/${fid}`]: null,
    [`snapshots/${fid}`]: null,
    [`awareness/${fid}`]: null,
  };
  try {
    await update(ref(db, sp.base), { ...writes, [`checkpoints/${fid}`]: null });
  } catch (err) {
    // Rules without a `checkpoints` branch (older deploy) deny the whole update; such a workspace
    // can't hold checkpoints either, so retry without that path.
    if (!isDenied(err)) throw err;
    await update(ref(db, sp.base), writes);
  }
}

// ---------- linked repo ----------

/** useRepoLink(space, key) — or legacy useRepoLink(sid, cid, key). */
export function useRepoLink(...args) {
  const [space, key] = spaceArgs(...args);
  const sk = spaceKey(space);
  const [state, setState] = useState({ link: null, loading: true, error: null });
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    setState({ link: null, loading: true, error: null });
    const unsub = onValue(
      ref(db, `${space.base}/repo`),
      async (snap) => {
        const v = snap.val();
        if (!v) return alive && setState({ link: null, loading: false, error: null });
        let link;
        try {
          link = await decryptJSON(key, v, space.aad.repo());
        } catch {
          if (alive) setState({ link: null, loading: false, error: 'Linked repository could not be decrypted' });
          return;
        }
        // Untrusted (any member can write it) and used to build GitHub API URLs with the
        // viewer's token: accept only well-formed names.
        if (!link || !isValidRepoName(link.owner) || !isValidRepoName(link.repo) || !isValidBranchName(link.branch)) {
          if (alive) setState({ link: null, loading: false, error: 'The linked repository is invalid. Re-link it.' });
          return;
        }
        if (alive) setState({ link: { owner: link.owner, repo: link.repo, branch: link.branch }, loading: false, error: null });
      },
      (err) => alive && setState({ link: null, loading: false, error: err.message }),
    );
    return () => {
      alive = false;
      unsub();
    };
  }, [sk, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export async function setRepoLink({ space, sid, cid, key, link }) {
  const sp = resolveSpace({ space, sid, cid });
  const r = ref(db, `${sp.base}/repo`);
  if (!link) return set(r, null);
  const box = await encryptJSON(key, { owner: link.owner, repo: link.repo, branch: link.branch }, sp.aad.repo());
  return set(r, box);
}

// ---------- presence per file (plaintext uids + timestamps only) ----------

/** -> { [fid]: uid[] } of members with a live cursor in that file. useFilePresence(space) or legacy (sid, cid). */
export function useFilePresence(...args) {
  const [space] = spaceArgs(...args);
  const sk = spaceKey(space);
  const [map, setMap] = useState({});
  useEffect(() => {
    let raw = {};
    const compute = () => {
      const now = serverNow();
      const out = {};
      for (const [fid, users] of Object.entries(raw)) {
        const uids = Object.entries(users || {})
          .filter(([, v]) => typeof v?.ts !== 'number' || now - v.ts < 60_000)
          .map(([uid]) => uid);
        if (uids.length) out[fid] = uids;
      }
      setMap((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    };
    const unsub = onValue(
      ref(db, `${space.base}/awareness`),
      (snap) => {
        raw = snap.val() || {};
        compute();
      },
      () => setMap({}),
    );
    const t = setInterval(compute, 20_000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [sk]); // eslint-disable-line react-hooks/exhaustive-deps
  return map;
}

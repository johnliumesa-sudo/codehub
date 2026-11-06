// One-shot, read-only access to a collab space's decrypted contents (no provider, no listeners,
// never writes). Used by preview bundling, game publishing, zip export and checkpoints.
//
// A file's text = snapshot + every remaining update, merged into a throwaway Y.Doc.
// Compaction race: a compactor first writes a new snapshot (CAS) and only then deletes the updates
// folded into it. We read snapshot -> updates -> snapshot again and apply BOTH snapshots plus the
// updates. Whatever interleaving happened, every update is in the updates we read or in the second
// snapshot. Yjs merging is idempotent, so applying overlapping state twice is harmless.
import * as Y from 'yjs';
import { get, ref } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptJSON } from '../crypto.js';
import { openBytes } from './codec.js';
import { TEXT_NAME } from './provider.js';
import { normalizePath } from './workspace.js';
import { isSpace } from './space.js';

const sameSnap = (a, b) => (a?.upTo ?? null) === (b?.upTo ?? null) && (a?.ts ?? null) === (b?.ts ?? null) && (a?.ct ?? null) === (b?.ct ?? null);

async function applyBox(doc, key, box, aad) {
  const bytes = await openBytes(key, box, aad);
  Y.applyUpdate(doc, bytes);
}

/**
 * Decrypted text of one file.
 * @param {object} space  channelSpace(...) | codespaceSpace(...)
 * @param {CryptoKey} key space.getKey() result
 * @param {string} fid
 * @param {{ strict?: boolean }} [opts] strict: throw if any update fails to decrypt (default: skip it,
 *   like the live provider does)
 * @returns {Promise<string>}
 */
export async function loadDocText(space, key, fid, { strict = false } = {}) {
  if (!isSpace(space)) throw new Error('loadDocText needs a collab space');
  if (!key) throw new Error('loadDocText needs the space key');
  const base = space.base;
  const snapRef = ref(db, `${base}/snapshots/${fid}`);
  const snap1 = (await get(snapRef)).val();
  const updates = (await get(ref(db, `${base}/updates/${fid}`))).val() || {};
  const snap2 = (await get(snapRef)).val();

  const doc = new Y.Doc();
  try {
    const snaps = [snap1];
    if (snap2 && !sameSnap(snap1, snap2)) snaps.push(snap2);
    for (const s of snaps) {
      if (!s?.ct) continue;
      try {
        await applyBox(doc, key, s, space.aad.snapshot(fid));
      } catch (err) {
        throw new Error('Could not decrypt this file’s snapshot.');
      }
    }
    // Push ids sort chronologically; order doesn't matter to Yjs, but it keeps pending structs short.
    for (const k of Object.keys(updates).sort()) {
      const u = updates[k];
      if (!u?.ct) continue;
      try {
        await applyBox(doc, key, u, space.aad.update(fid));
      } catch (err) {
        if (strict) throw new Error('A change to this file could not be decrypted.');
        console.warn('[collab/read] skipped undecryptable update', k, err);
      }
    }
    return doc.getText(TEXT_NAME).toString();
  } finally {
    doc.destroy();
  }
}

/**
 * Decrypted, validated file list (no contents). Mirrors useCollabFiles' validation: a meta whose
 * path is not already normalised is treated as broken and skipped.
 * @returns {Promise<Array<{fid, path, repo?, ref?, sha?}>>} sorted by path
 */
export async function loadWorkspaceFileList(space, key) {
  if (!isSpace(space)) throw new Error('loadWorkspaceFileList needs a collab space');
  const raw = (await get(ref(db, `${space.base}/files`))).val() || {};
  const out = [];
  await Promise.all(
    Object.entries(raw).map(async ([fid, v]) => {
      if (!v?.enc) return;
      try {
        const m = await decryptJSON(key, v.enc, space.aad.file(fid));
        if (!m || typeof m !== 'object' || typeof m.path !== 'string' || !m.path) return;
        const path = normalizePath(m.path);
        if (!path || path !== m.path || path.length > 300) return;
        const meta = { fid, path };
        for (const f of ['repo', 'ref', 'sha']) if (typeof m[f] === 'string' && m[f]) meta[f] = m[f];
        out.push(meta);
      } catch {
        /* undecryptable entry: skip */
      }
    }),
  );
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Every (decryptable) file with its text.
 * @param {object} space
 * @param {CryptoKey} key
 * @param {{ maxFiles?: number, concurrency?: number, onProgress?: (done:number, total:number) => void }} [opts]
 * @returns {Promise<Array<{fid:string, path:string, text:string}>>} sorted by path; files whose
 *   contents can't be decrypted are omitted.
 */
export async function loadWorkspaceFiles(space, key, { maxFiles = 200, concurrency = 4, onProgress } = {}) {
  const list = (await loadWorkspaceFileList(space, key)).slice(0, Math.max(0, maxFiles));
  const results = new Array(list.length);
  let next = 0;
  let done = 0;
  onProgress?.(0, list.length);
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const f = list[i];
      try {
        results[i] = { fid: f.fid, path: f.path, text: await loadDocText(space, key, f.fid) };
      } catch (err) {
        console.warn('[collab/read] skipped file', f.path, err);
        results[i] = null;
      }
      done += 1;
      onProgress?.(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results.filter(Boolean);
}

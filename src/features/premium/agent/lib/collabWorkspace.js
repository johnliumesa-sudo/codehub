// The agent's workspace interface (tools.js) on the real collab layer. Files are decrypted locally with
// the space key; every change goes through the shared encrypted Yjs documents, so collaborators see
// the agent's edits live, exactly like a member typing:
//   - read: the open editor's document when it is the file on screen, else a one-shot decrypt
//     (collab/read.js loadDocText);
//   - write: the editor's provider for the file on screen, else a short-lived CollabProvider for that
//     file (synced, one minimal replace transaction, flushed, closed);
//   - create / delete / rename: collab/workspace.js (createFile seeds the content atomically);
//   - checkpoint: src/lib/checkpoints.js saveCheckpoint (encrypted like any checkpoint);
//   - regex search runs in a Web Worker with a timeout; preview hands a bundle to the panel's sandbox
//     frame (preview.js) and waits for its console output.
// Read-only members (codespace viewers) get `readOnly: true`; every write also throws here.
import { CollabProvider } from '../../../../lib/collab/provider.js';
import { loadDocText, loadWorkspaceFileList } from '../../../../lib/collab/read.js';
import { createFile, deleteFile, updateFileMeta } from '../../../../lib/collab/workspace.js';
import { replaceYText, saveCheckpoint } from '../../../../lib/checkpoints.js';
import { searchFiles } from './search.js';

const SYNC_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 4_000;

function waitSynced(p, ms = SYNC_TIMEOUT_MS) {
  if (p.status === 'synced') return Promise.resolve(p);
  if (p.status === 'error') return Promise.reject(new Error(p.error || 'Could not open the file.'));
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const t = setTimeout(() => {
      unsub();
      reject(new Error('Timed out opening the file.'));
    }, ms);
    unsub = p.subscribe(() => {
      if (p.status === 'synced') {
        clearTimeout(t);
        unsub();
        resolve(p);
      } else if (p.status === 'error') {
        clearTimeout(t);
        unsub();
        reject(new Error(p.error || 'Could not open the file.'));
      }
    });
  });
}

/** Regex search in a worker, terminated after SEARCH_TIMEOUT_MS; plain text searches run inline. */
function searchInWorker(files, opts) {
  if (!opts.regex || typeof Worker === 'undefined') return Promise.resolve(searchFiles(files, opts));
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./searchWorker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(searchFiles(files, opts));
      return;
    }
    const t = setTimeout(() => {
      worker.terminate();
      reject(new Error(`The regular expression took longer than ${SEARCH_TIMEOUT_MS / 1000} s and was stopped. Use a simpler pattern.`));
    }, SEARCH_TIMEOUT_MS);
    worker.onmessage = (e) => {
      clearTimeout(t);
      worker.terminate();
      if (e.data?.ok) resolve(e.data.result);
      else reject(new Error(e.data?.error || 'Search failed.'));
    };
    worker.onerror = (e) => {
      clearTimeout(t);
      worker.terminate();
      reject(new Error(e?.message || 'Search failed.'));
    };
    worker.postMessage({ files, opts });
  });
}

/**
 * @param {object} o
 * @param {object} o.space        collab space descriptor
 * @param {CryptoKey} o.key       space key
 * @param {{uid:string, name?:string, color?:string}} o.me
 * @param {boolean} o.readOnly
 * @param {() => object|null} o.activeProvider  the editor's synced provider for the file on screen
 * @param {(entry:string|null) => Promise} [o.preview]
 */
export function collabWorkspace({ space, key, me, readOnly, activeProvider, preview }) {
  const live = (fid) => {
    const p = activeProvider?.();
    return p && !p.destroyed && p.fid === fid && p.status === 'synced' ? p : null;
  };
  const refuse = () => {
    if (readOnly) throw new Error('You can only read this workspace.');
  };

  return {
    readOnly: !!readOnly,
    list: () => loadWorkspaceFileList(space, key),
    async read(fid) {
      const p = live(fid);
      return p ? p.ytext.toString() : loadDocText(space, key, fid);
    },
    async create(path, text) {
      refuse();
      return createFile({ space, key, uid: me.uid, meta: { path }, content: text });
    },
    async write(fid, text) {
      refuse();
      const shown = live(fid);
      if (shown) {
        replaceYText(shown.ytext, text);
        await shown.flush();
        if (shown.status === 'error') throw new Error(shown.error || 'The change could not be saved.');
        return;
      }
      const p = new CollabProvider({ space, fid, key, uid: me.uid, user: { name: me.name, color: me.color }, readOnly: false });
      try {
        await waitSynced(p);
        replaceYText(p.ytext, text);
        await p.flush();
        if (p.status === 'error') throw new Error(p.error || 'The change could not be saved.');
      } finally {
        p.destroy();
      }
    },
    async remove(fid) {
      refuse();
      await deleteFile({ space, fid });
    },
    async rename(fid, newPath) {
      refuse();
      const f = (await loadWorkspaceFileList(space, key)).find((x) => x.fid === fid);
      if (!f) throw new Error('The file no longer exists.');
      await updateFileMeta({ space, key, fid, meta: { ...f, path: newPath } });
    },
    async checkpoint(fid, label, text) {
      refuse();
      return saveCheckpoint({ space, key, fid, uid: me.uid, label, text });
    },
    search: searchInWorker,
    preview: preview || undefined,
  };
}

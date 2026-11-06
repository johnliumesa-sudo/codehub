// Import planning + execution for ExportImportMenu (F10): turn picked/dropped files or a zip into
// a checked list of workspace files, then create (or overwrite) them one by one.
import { createFile, normalizePath, validatePath } from '../../lib/collab/workspace.js';
import { CollabProvider } from '../../lib/collab/provider.js';
import { replaceYText } from '../../lib/checkpoints.js';
import { readZip } from '../../lib/zip.js';

export const IMPORT_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 900_000,
  maxTotalBytes: 5_000_000,
  maxZipBytes: 50_000_000,
  maxPathLength: 300,
};

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', 'Thumbs.db', '.svn', '.hg']);

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Binary = a NUL byte in the first 8 KB, or not valid UTF-8. Returns text or null. */
export function decodeText(bytes) {
  const head = bytes.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return null;
  try {
    return fatalUtf8.decode(bytes);
  } catch {
    return null;
  }
}

const isZipName = (name) => /\.zip$/i.test(name || '');

/**
 * Read picked or dropped files into raw entries: [{ srcPath, bytes | null, size, error? }].
 * A lone .zip is expanded; zips mixed with other files are treated as (skipped) binaries.
 * files: [{ file: File, path: string }]
 */
export async function readSources(files) {
  const { maxFileBytes, maxZipBytes } = IMPORT_LIMITS;
  if (files.length === 1 && isZipName(files[0].file.name)) {
    const f = files[0].file;
    if (f.size > maxZipBytes) throw new Error(`That zip is too large (limit ${Math.round(maxZipBytes / 1e6)} MB).`);
    const entries = await readZip(await f.arrayBuffer(), { maxEntrySize: maxFileBytes, maxEntries: 5000 });
    return entries.map((e) => ({
      srcPath: e.path,
      bytes: e.bytes,
      size: e.bytes ? e.bytes.length : e.size || 0,
      error: e.error === 'too-large' ? 'larger than 900 KB' : e.error,
    }));
  }
  const out = [];
  for (const { file, path } of files) {
    if (file.size > maxFileBytes) {
      out.push({ srcPath: path, bytes: null, size: file.size, error: 'larger than 900 KB' });
      continue;
    }
    if (isIgnored(path)) {
      out.push({ srcPath: path, bytes: null, size: file.size, error: 'ignored' });
      continue;
    }
    try {
      out.push({ srcPath: path, bytes: new Uint8Array(await file.arrayBuffer()), size: file.size });
    } catch {
      out.push({ srcPath: path, bytes: null, size: file.size, error: 'could not be read' });
    }
  }
  return out;
}

function isIgnored(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .some((s) => IGNORED_SEGMENTS.has(s));
}

/** The shared top-level folder of every path, or null. */
export function commonRoot(paths) {
  let root = null;
  for (const p of paths) {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (root === null) root = parts[0];
    else if (root !== parts[0]) return null;
  }
  return root;
}

/**
 * Build the import plan.
 * raw: from readSources; existing: ctx.files ([{fid, path}]); opts.stripRoot: drop the common top folder.
 * -> { items: [{ key, srcPath, path, text, size, status: 'new'|'exists'|'skip', reason?, fid? }],
 *      counts: { new, exists, skip }, totalBytes, root }
 */
export function buildPlan(raw, existing, { stripRoot = true } = {}) {
  const { maxFiles, maxTotalBytes, maxPathLength } = IMPORT_LIMITS;
  const usable = raw.filter((r) => r.error !== 'ignored' && !isIgnored(r.srcPath));
  const root = commonRoot(usable.map((r) => r.srcPath));
  const byPath = new Map(existing.filter((f) => !f.broken).map((f) => [f.path, f.fid]));
  const planned = [];
  const items = [];
  let accepted = 0;
  let totalBytes = 0;

  raw.forEach((r, i) => {
    const item = { key: `${i}:${r.srcPath}`, srcPath: r.srcPath, path: '', text: null, size: r.size || 0, status: 'skip' };
    items.push(item);
    if (r.error === 'ignored' || isIgnored(r.srcPath)) {
      item.reason = 'ignored folder';
      return;
    }
    let src = String(r.srcPath).replace(/\\/g, '/');
    if (stripRoot && root && src.startsWith(`${root}/`)) src = src.slice(root.length + 1);
    item.path = normalizePath(src);
    if (r.error) {
      item.reason = r.error;
      return;
    }
    if (!item.path) {
      item.reason = 'invalid path';
      return;
    }
    if (item.path.length > maxPathLength) {
      item.reason = 'path too long';
      return;
    }
    const text = decodeText(r.bytes);
    if (text === null) {
      item.reason = 'binary file';
      return;
    }
    const existingFid = byPath.get(item.path);
    if (!existingFid) {
      const others = [...existing, ...planned];
      const problem = validatePath(item.path, others, null);
      if (problem) {
        item.reason = planned.some((p) => p.path === item.path) ? 'duplicate path' : problem.toLowerCase();
        return;
      }
    } else if (planned.some((p) => p.path === item.path)) {
      item.reason = 'duplicate path';
      return;
    }
    if (accepted >= maxFiles) {
      item.reason = `over the ${maxFiles}-file limit`;
      return;
    }
    if (totalBytes + item.size > maxTotalBytes) {
      item.reason = 'over the 5 MB total limit';
      return;
    }
    accepted += 1;
    totalBytes += item.size;
    item.text = text;
    item.status = existingFid ? 'exists' : 'new';
    if (existingFid) item.fid = existingFid;
    planned.push({ fid: `planned:${i}`, path: item.path });
  });

  const counts = { new: 0, exists: 0, skip: 0 };
  for (const it of items) counts[it.status] += 1;
  return { items, counts, totalBytes, root };
}

function waitForSync(provider, ms = 20_000) {
  return new Promise((resolve, reject) => {
    let unsub = () => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('Timed out loading the existing file'));
    }, ms);
    const check = (p) => {
      if (p.status === 'synced') {
        clearTimeout(timer);
        unsub();
        resolve();
      } else if (p.status === 'error') {
        clearTimeout(timer);
        unsub();
        reject(new Error(p.error || 'Could not open the existing file'));
      }
    };
    unsub = provider.subscribe(check);
    check(provider);
  });
}

/**
 * Replace an existing file's text with ONE minimal Yjs transaction. Uses the open editor's
 * provider when it is that file, otherwise a temporary provider that is torn down afterwards.
 */
export async function overwriteFile({ ctx, fid, text }) {
  const { space, key, me } = ctx;
  if (ctx.provider && ctx.activeFid === fid) {
    await waitForSync(ctx.provider);
    replaceYText(ctx.provider.ytext, text);
    await ctx.provider.flush();
    return;
  }
  // `sid`/`cid` keep this working with the pre-refactor provider signature for channel spaces.
  const provider = new CollabProvider({
    space,
    sid: space.sid,
    cid: space.cid,
    fid,
    key,
    uid: me.uid,
    user: { name: me.name, color: me.color },
  });
  try {
    await waitForSync(provider);
    replaceYText(provider.ytext, text);
    await provider.flush();
    if (provider.status === 'error') throw new Error(provider.error || 'The change could not be saved');
  } finally {
    provider.destroy();
  }
}

/** Create a new workspace file seeded with `text` (post-refactor signature, legacy-compatible). */
export function createImportedFile({ ctx, path, text }) {
  const { space, key, me } = ctx;
  return createFile({ space, sid: space.sid, cid: space.cid, key, uid: me.uid, meta: { path }, content: text });
}

// ---------- drag & drop (folders included) ----------

function readAllEntries(dirReader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      dirReader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

/** DataTransfer -> [{ file, path }] walking dropped folders (capped to avoid runaway trees). */
export async function filesFromDrop(dataTransfer, cap = 5000) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  if (!entries.some(Boolean)) {
    return [...(dataTransfer.files || [])].map((file) => ({ file, path: file.name }));
  }
  const out = [];
  const walk = async (entry, prefix) => {
    if (!entry || out.length >= cap) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      out.push({ file: await entryFile(entry), path });
    } else if (entry.isDirectory) {
      if (IGNORED_SEGMENTS.has(entry.name)) return;
      const children = await readAllEntries(entry.createReader());
      for (const c of children) await walk(c, path);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** <input type=file> FileList -> [{ file, path }] (folder picks keep their relative path). */
export function filesFromInput(fileList) {
  return [...(fileList || [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

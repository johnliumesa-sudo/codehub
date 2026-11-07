// The agent's tools, implemented against a small workspace interface so the same code runs on the
// real collab layer (collabWorkspace.js) and on an in-memory workspace in the unit tests. Pure.
//
// Workspace interface (all async):
//   readOnly                      true for codespace viewers: every change is refused
//   list()                        -> [{ fid, path }] (decrypted, validated paths)
//   read(fid)                     -> string
//   create(path, text)            -> fid
//   write(fid, text)              replace the whole text (applied as a minimal edit)
//   remove(fid)
//   rename(fid, newPath)
//   checkpoint?(fid, label, text) -> checkpoint id (the existing per-file checkpoints)
//   search?(files, opts)          -> searchFiles() result (the page runs regexes in a worker)
//   preview?(entry)               -> { entry, lines: [{ level, text }], missing: [], error? }
//
// Reading tools run straight away. Changing tools are planned first (planChange: validation and the
// proposed before/after text, shown to the member as a diff), then applied (applyChange) once the
// member approves, re-checked against the file as it is at that moment.
import { MAX_PATH } from './schema.js';
import { searchFiles } from './search.js';

/** Most characters read_file returns in one call. */
export const MAX_READ_CHARS = 100_000;
/** Most characters of console output preview returns. */
export const MAX_PREVIEW_CHARS = 20_000;

/** A tool failure Claude should see as an `is_error` result (bad path, old_str not unique, …). */
export class ToolError extends Error {}

/** Same normalisation as the collab workspace (src/lib/collab/workspace.js normalizePath). */
export function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

/** A path Claude sent must already be a clean workspace path; returns it or throws ToolError. */
export function checkPath(p) {
  const raw = String(p ?? '');
  const clean = normalizePath(raw);
  if (!clean) throw new ToolError('The path is empty.');
  if (clean !== raw) throw new ToolError(`"${raw.slice(0, MAX_PATH)}" is not a clean workspace path. Use "${clean}" (no leading slash, no "." or ".." segments, no spaces around "/").`);
  if (clean.length > MAX_PATH) throw new ToolError(`The path is too long (max ${MAX_PATH} characters).`);
  return clean;
}

function findFile(files, path) {
  const f = files.find((x) => x.path === path);
  if (!f) {
    const near = files.filter((x) => x.path.endsWith(`/${path.split('/').pop()}`) || x.path === path.split('/').pop()).slice(0, 5).map((x) => x.path);
    throw new ToolError(`No file at "${path}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Use list_files to see the workspace.'}`);
  }
  return f;
}

/** A path new files may use: free, not a folder of other files, not inside a file. */
function checkFree(files, path, exceptFid) {
  const others = files.filter((f) => f.fid !== exceptFid);
  if (others.some((f) => f.path === path)) throw new ToolError(`A file already exists at "${path}".`);
  if (others.some((f) => f.path.startsWith(`${path}/`))) throw new ToolError(`"${path}" is a folder in this workspace.`);
  if (others.some((f) => path.startsWith(`${f.path}/`))) throw new ToolError(`"${path}" would be inside the file "${others.find((f) => path.startsWith(`${f.path}/`)).path}".`);
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n += 1;
    if (n > 1) return n; // only "0, 1 or many" matters
    i = text.indexOf(needle, i + 1);
  }
  return n;
}

const lineCount = (t) => (t === '' ? 0 : String(t).split('\n').length);

/** Line-numbered text, optionally a 1-based inclusive range, capped at MAX_READ_CHARS. */
export function numberLines(text, start, end) {
  const lines = String(text).split('\n');
  const total = lines.length;
  if (text === '') return '(empty file)';
  const from = Math.max(1, start || 1);
  const to = Math.min(total, end || total);
  if (from > total) throw new ToolError(`The file has only ${total} line${total === 1 ? '' : 's'}.`);
  if (to < from) throw new ToolError('end_line is before start_line.');
  const width = String(to).length;
  let out = '';
  let last = from - 1;
  for (let i = from; i <= to; i++) {
    const row = `${String(i).padStart(width, ' ')}| ${lines[i - 1]}\n`;
    if (out.length + row.length > MAX_READ_CHARS) break;
    out += row;
    last = i;
  }
  if (last < to) out += `… (output cut at line ${last} of ${total}; read again with start_line ${last + 1})\n`;
  else if (from > 1 || to < total) out += `(lines ${from}–${to} of ${total})\n`;
  return out;
}

async function readAll(ws, files) {
  const out = [];
  for (const f of files) {
    try {
      out.push({ path: f.path, text: await ws.read(f.fid) });
    } catch {
      /* undecryptable file: skipped */
    }
  }
  return out;
}

/** Run a reading tool. -> result text (throws ToolError for problems Claude should fix). */
export async function runReadTool(name, input, ws) {
  if (name === 'list_files') {
    const files = await ws.list();
    if (!files.length) return 'The workspace is empty.';
    return `${files.length} file${files.length === 1 ? '' : 's'}:\n${files.map((f) => f.path).join('\n')}`;
  }
  if (name === 'read_file') {
    const path = checkPath(input.path);
    const f = findFile(await ws.list(), path);
    return numberLines(await ws.read(f.fid), input.start_line, input.end_line);
  }
  if (name === 'search_files') {
    const files = await ws.list();
    const prefix = input.path_prefix ? normalizePath(input.path_prefix) + (input.path_prefix.endsWith('/') ? '/' : '') : '';
    const texts = await readAll(ws, prefix ? files.filter((f) => f.path.startsWith(prefix)) : files);
    const opts = { query: input.query, regex: !!input.regex, caseSensitive: !!input.case_sensitive, pathPrefix: prefix };
    let res;
    try {
      res = ws.search ? await ws.search(texts, opts) : searchFiles(texts, opts);
    } catch (e) {
      throw new ToolError(String(e?.message || e));
    }
    if (!res.total) return `No matches in ${res.filesSearched} file${res.filesSearched === 1 ? '' : 's'}.`;
    return `${res.total} matching line${res.total === 1 ? '' : 's'}${res.truncated ? ` (first ${res.matches.length} shown)` : ''}:\n${res.matches.join('\n')}`;
  }
  if (name === 'preview') {
    if (!ws.preview) throw new ToolError('Preview is not available here.');
    const entry = input.entry ? checkPath(input.entry) : null;
    if (entry) findFile(await ws.list(), entry);
    const r = await ws.preview(entry);
    if (r.error) throw new ToolError(r.error);
    let text = `Ran ${r.entry} in the sandbox.`;
    if (r.missing?.length) text += `\nMissing references (not found in the workspace): ${r.missing.join(', ')}`;
    const lines = (r.lines || []).map((l) => `[${l.level}] ${l.text}`);
    let body = lines.length ? lines.join('\n') : '(no console output)';
    if (body.length > MAX_PREVIEW_CHARS) body = `${body.slice(0, MAX_PREVIEW_CHARS)}\n… (console output cut)`;
    return `${text}\nConsole:\n${body}`;
  }
  throw new ToolError(`Unknown tool "${name}".`);
}

/**
 * Plan a change: validate it against the workspace now and compute the before/after text.
 * -> { tool, kind, path, newPath?, fid?, before, after, edit?, summary }
 */
export async function planChange(name, input, ws) {
  if (ws.readOnly) throw new ToolError('You can only read this workspace: the member running the agent is a viewer, so no file can be changed.');
  const files = await ws.list();
  if (name === 'create_file') {
    const path = checkPath(input.path);
    checkFree(files, path);
    return { tool: name, kind: 'create', path, before: '', after: input.content, summary: `Create ${path}` };
  }
  if (name === 'edit_file') {
    const path = checkPath(input.path);
    const f = findFile(files, path);
    const before = await ws.read(f.fid);
    if (!input.old_str) throw new ToolError('old_str is empty. To add text, include a nearby line in old_str and repeat it in new_str.');
    if (input.old_str === input.new_str) throw new ToolError('old_str and new_str are the same, so nothing would change.');
    const n = countOccurrences(before, input.old_str);
    if (n === 0) throw new ToolError(`old_str was not found in ${path}. Read the file again and copy the text exactly, including whitespace.`);
    if (n > 1) throw new ToolError(`old_str appears more than once in ${path}. Include more surrounding lines so it matches exactly one place.`);
    const after = before.replace(input.old_str, () => input.new_str);
    return { tool: name, kind: 'edit', path, fid: f.fid, before, after, edit: { old_str: input.old_str, new_str: input.new_str }, summary: `Edit ${path}` };
  }
  if (name === 'write_file') {
    const path = checkPath(input.path);
    const f = findFile(files, path);
    const before = await ws.read(f.fid);
    if (before === input.content) throw new ToolError(`${path} already has exactly this content.`);
    return { tool: name, kind: 'write', path, fid: f.fid, before, after: input.content, summary: `Rewrite ${path}` };
  }
  if (name === 'delete_file') {
    const path = checkPath(input.path);
    const f = findFile(files, path);
    const before = await ws.read(f.fid);
    return { tool: name, kind: 'delete', path, fid: f.fid, before, after: '', summary: `Delete ${path}` };
  }
  if (name === 'rename_file') {
    const path = checkPath(input.path);
    const newPath = checkPath(input.new_path);
    const f = findFile(files, path);
    if (newPath === path) throw new ToolError('new_path is the same as path.');
    checkFree(files, newPath, f.fid);
    const text = await ws.read(f.fid);
    return { tool: name, kind: 'rename', path, newPath, fid: f.fid, before: text, after: text, summary: `Rename ${path} → ${newPath}` };
  }
  throw new ToolError(`Unknown tool "${name}".`);
}

/** "+3 −1" style counts for a change (whole lines). */
export function changeStats(change) {
  if (change.kind === 'create') return { added: lineCount(change.after), removed: 0 };
  if (change.kind === 'delete') return { added: 0, removed: lineCount(change.before) };
  if (change.kind === 'rename') return { added: 0, removed: 0 };
  const a = change.before.split('\n');
  const b = change.after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { added: b.length - pre - suf, removed: a.length - pre - suf };
}

/**
 * Apply an approved change, re-checked against the workspace as it is now (a collaborator may have
 * edited the file while the member was reading the diff). `tracker` (createRunTracker) saves the
 * checkpoint before a file's first change in the run and records what undo needs.
 * -> result text for Claude.
 */
export async function applyChange(change, ws, tracker) {
  if (ws.readOnly) throw new ToolError('You can only read this workspace.');
  const files = await ws.list();
  const current = change.fid ? files.find((f) => f.fid === change.fid) : null;
  if (change.kind !== 'create' && (!current || current.path !== change.path)) {
    throw new ToolError(`${change.path} was renamed or deleted while waiting for approval. List the files again.`);
  }
  if (change.kind === 'create') {
    checkFree(files, change.path);
    const fid = await ws.create(change.path, change.after);
    tracker?.created(fid, change.path);
    const n = lineCount(change.after);
    return `Created ${change.path} (${n} line${n === 1 ? '' : 's'}).`;
  }
  const now = await ws.read(change.fid);
  let after = change.after;
  if (now !== change.before) {
    if (change.kind === 'edit' && countOccurrences(now, change.edit.old_str) === 1) {
      after = now.replace(change.edit.old_str, () => change.edit.new_str);
    } else if (change.kind === 'rename') {
      after = now;
    } else {
      throw new ToolError(`${change.path} changed while waiting for approval (someone else edited it), so the change was not applied. Read it again.`);
    }
  }
  if (change.kind === 'rename') checkFree(files, change.newPath, change.fid);
  await tracker?.touch(change.fid, change.path, now);
  if (change.kind === 'edit' || change.kind === 'write') {
    await ws.write(change.fid, after);
    const s = changeStats({ ...change, before: now, after });
    return `${change.kind === 'edit' ? 'Edited' : 'Rewrote'} ${change.path} (+${s.added} −${s.removed} lines).`;
  }
  if (change.kind === 'delete') {
    await ws.remove(change.fid);
    tracker?.deleted(change.fid);
    return `Deleted ${change.path}.`;
  }
  if (change.kind === 'rename') {
    await ws.rename(change.fid, change.newPath);
    tracker?.renamed(change.fid, change.newPath);
    return `Renamed ${change.path} to ${change.newPath}.`;
  }
  throw new ToolError(`Unknown change "${change.kind}".`);
}

/**
 * Per-run record of every file the agent changed, so the run can be undone in one click, plus the
 * checkpoint saved before a file's first change. `label` names the checkpoints.
 */
export function createRunTracker(ws, label) {
  // key -> { existed, origPath, origText, curFid, curPath, cpid }
  const files = new Map();
  const byFid = new Map(); // current fid -> key
  let seq = 0;
  const checkpoints = [];

  return {
    checkpoints,
    get changed() {
      return files.size;
    },
    /** Before the first change to an existing file: checkpoint it and remember its text. */
    async touch(fid, path, text) {
      if (byFid.has(fid)) return;
      let cpid = null;
      if (ws.checkpoint) {
        try {
          cpid = await ws.checkpoint(fid, label, text);
        } catch (e) {
          throw new ToolError(`Couldn't save a checkpoint of ${path} before changing it (${String(e?.message || e)}), so nothing was changed.`);
        }
        checkpoints.push({ fid, path, cpid });
      }
      const key = `k${++seq}`;
      files.set(key, { existed: true, origPath: path, origText: text, curFid: fid, curPath: path, cpid });
      byFid.set(fid, key);
    },
    created(fid, path) {
      const key = `k${++seq}`;
      files.set(key, { existed: false, curFid: fid, curPath: path });
      byFid.set(fid, key);
    },
    renamed(fid, newPath) {
      const k = byFid.get(fid);
      if (k) files.get(k).curPath = newPath;
    },
    deleted(fid) {
      const k = byFid.get(fid);
      if (!k) return;
      files.get(k).curFid = null;
      byFid.delete(fid);
    },
    /**
     * Put every file back the way it was before the run: files the run created are deleted, deleted
     * files are recreated, renames are reversed and contents restored. Later edits by others to those
     * files are replaced too (the confirmation says so). -> { restored, removed, failed: [msg] }
     */
    async undo() {
      const failed = [];
      const restoredSet = new Set();
      let removed = 0;
      const entries = [...files.values()];
      const list = async () => ws.list();
      // 1. files the run created
      for (const e of entries.filter((x) => !x.existed && x.curFid)) {
        try {
          if ((await list()).some((f) => f.fid === e.curFid)) {
            await ws.remove(e.curFid);
            removed += 1;
          }
          e.curFid = null;
        } catch (err) {
          failed.push(`${e.curPath}: ${String(err?.message || err)}`);
        }
      }
      // 2. renames back, then 3. recreate deleted files, then 4. contents
      for (const e of entries.filter((x) => x.existed && x.curFid)) {
        try {
          const cur = (await list()).find((f) => f.fid === e.curFid);
          if (!cur) {
            e.curFid = null;
            continue;
          }
          if (cur.path !== e.origPath) {
            if ((await list()).some((f) => f.path === e.origPath && f.fid !== e.curFid)) throw new Error(`${e.origPath} is taken by another file`);
            await ws.rename(e.curFid, e.origPath);
            e.curPath = e.origPath;
            restoredSet.add(e);
          }
        } catch (err) {
          failed.push(`${e.origPath}: ${String(err?.message || err)}`);
        }
      }
      for (const e of entries.filter((x) => x.existed && !x.curFid)) {
        try {
          if ((await list()).some((f) => f.path === e.origPath)) throw new Error('another file now has this path');
          e.curFid = await ws.create(e.origPath, e.origText);
          e.curPath = e.origPath;
          restoredSet.add(e);
        } catch (err) {
          failed.push(`${e.origPath}: ${String(err?.message || err)}`);
        }
      }
      for (const e of entries.filter((x) => x.existed && x.curFid)) {
        try {
          if ((await ws.read(e.curFid)) !== e.origText) {
            await ws.write(e.curFid, e.origText);
            restoredSet.add(e);
          }
        } catch (err) {
          failed.push(`${e.origPath}: ${String(err?.message || err)}`);
        }
      }
      return { restored: restoredSet.size, removed, failed };
    },
  };
}

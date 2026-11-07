// Server folders: pure helpers (no Firebase imports; unit-tested in node).
//   udata/{me}/serverFolders/{fid} = { iv, ct, color: '#rrggbb', sids: 'sid1,sid2,…', collapsed: bool, at: ms }
//   iv/ct = sealForMe(`sfolder:{me}/{fid}`, { name }). The folder sits in the rail where its first server
//   (in join order) would be; servers inside keep the folder's own order.

export const FOLDER_COLORS = Object.freeze(['#5b8cff', '#a66bff', '#ff6b9a', '#ff8f4d', '#f5c542', '#3ccf91', '#2bc4d9', '#8892a6']);
export const FOLDER_NAME_MAX = 32;
export const FOLDER_MAX = 30;
export const DEFAULT_FOLDER_NAME = 'Folder';

const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const isSid = (v) => typeof v === 'string' && SID_RE.test(v);

/** 'a,b,c' -> ['a','b','c'] (valid, unique, in order). */
export function parseSids(v) {
  if (typeof v !== 'string' || !v) return [];
  const seen = new Set();
  for (const s of v.split(',')) if (isSid(s) && !seen.has(s)) seen.add(s);
  return [...seen];
}

export const sidsString = (list) => [...new Set(list.filter(isSid))].join(',');

export const cleanColor = (c) => (typeof c === 'string' && HEX_RE.test(c) ? c.toLowerCase() : FOLDER_COLORS[0]);

export function cleanFolderName(v) {
  if (typeof v !== 'string') return '';
  const one = v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(one).slice(0, FOLDER_NAME_MAX).join('').trim();
}

/** udata/{me}/serverFolders -> [{ id, color, sids, collapsed, at, box }] ordered by creation. */
export function parseFolders(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([id, f]) => isSid(id) && f && typeof f === 'object')
    .map(([id, f]) => ({
      id,
      color: cleanColor(f.color),
      sids: parseSids(f.sids),
      collapsed: f.collapsed === true,
      at: typeof f.at === 'number' && Number.isFinite(f.at) ? f.at : 0,
      box: typeof f.iv === 'string' && typeof f.ct === 'string' ? { iv: f.iv, ct: f.ct } : null,
    }))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/**
 * Rail items for my servers (in their natural order) and folders:
 * [{ type: 'server', sid } | { type: 'folder', folder, sids }]. A server listed by several folders
 * belongs to the first; servers I left are skipped; folders with none of my servers are left out.
 */
export function railLayout(servers, folders) {
  const mine = new Set(servers.map((s) => s.sid));
  const owner = new Map(); // sid -> folder
  const members = new Map(); // folder id -> sids present, folder order
  for (const f of folders) {
    const list = [];
    for (const sid of f.sids) {
      if (!mine.has(sid) || owner.has(sid)) continue;
      owner.set(sid, f);
      list.push(sid);
    }
    members.set(f.id, list);
  }
  const out = [];
  const emitted = new Set();
  for (const { sid } of servers) {
    const f = owner.get(sid);
    if (!f) out.push({ type: 'server', sid });
    else if (!emitted.has(f.id)) {
      emitted.add(f.id);
      out.push({ type: 'folder', folder: f, sids: members.get(f.id) });
    }
  }
  return out;
}

/** The folder a server is in (first match), or null. */
export const folderOf = (folders, sid) => folders.find((f) => f.sids.includes(sid)) || null;

/**
 * Move `sid` into folder `to` (before `before` if given, else at the end) or out of every folder
 * (`to` = null). Returns { [folderId]: newSids[] | null } for the folders that change; null = the
 * folder became empty and should be deleted.
 */
export function planMove(folders, sid, to, before = null) {
  const out = {};
  for (const f of folders) {
    if (f.id === to) continue;
    if (f.sids.includes(sid)) {
      const next = f.sids.filter((s) => s !== sid);
      out[f.id] = next.length ? next : null;
    }
  }
  if (to) {
    const f = folders.find((x) => x.id === to);
    if (f) {
      const rest = f.sids.filter((s) => s !== sid);
      const at = before && before !== sid ? rest.indexOf(before) : -1;
      if (at >= 0) rest.splice(at, 0, sid);
      else rest.push(sid);
      if (rest.join(',') !== f.sids.join(',')) out[f.id] = rest;
    }
  }
  return out;
}

/** For a new folder holding `sids`: the changes to other folders that currently hold them. */
export function planTake(folders, sids) {
  const take = new Set(sids);
  const out = {};
  for (const f of folders) {
    if (!f.sids.some((s) => take.has(s))) continue;
    const next = f.sids.filter((s) => !take.has(s));
    out[f.id] = next.length ? next : null;
  }
  return out;
}

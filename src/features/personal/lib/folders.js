// Server folders: live hook and writes for udata/{me}/serverFolders (pure helpers in foldersCore.js).
// Folder names are typed by the user, so they are sealed with my vault key (AAD sfolder:{me}/{fid});
// colors, collapsed state and the server id lists are plaintext ids/flags in my private udata.
import { useEffect, useMemo, useState } from 'react';
import { push, ref, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { myUid, openForMe, sealForMe, useUdata } from '../../../lib/ext/store.js';
import { onLock } from '../../../lib/keystore.js';
import {
  DEFAULT_FOLDER_NAME, FOLDER_MAX, cleanColor, cleanFolderName, parseFolders, planMove, planTake, sidsString,
} from './foldersCore.js';

export const folderAad = (uid, fid) => `sfolder:${uid}/${fid}`;
const base = (uid) => `udata/${uid}/serverFolders`;

const names = new Map(); // `${fid}|${ct}` -> name | null (failed); plaintext in memory only
onLock(() => names.clear());

/**
 * Live folders with decrypted names: { loading, folders: [{ id, name (display), savedName, nameFailed,
 * nameLoading, color, sids, collapsed }] }.
 */
export function useServerFolders() {
  const { loading, value } = useUdata('serverFolders');
  const parsed = useMemo(() => parseFolders(value), [value]);
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    let uid;
    try {
      uid = myUid();
    } catch {
      return undefined;
    }
    parsed.forEach((f) => {
      const k = `${f.id}|${f.box?.ct || ''}`;
      if (!f.box || names.has(k)) return;
      openForMe(folderAad(uid, f.id), f.box).then(
        (v) => {
          names.set(k, cleanFolderName(v?.name));
          if (alive) bump((n) => n + 1);
        },
        () => {
          names.set(k, null);
          if (alive) bump((n) => n + 1);
        },
      );
    });
    return () => {
      alive = false;
    };
  }, [parsed]);
  const folders = parsed.map((f) => {
    const k = `${f.id}|${f.box?.ct || ''}`;
    const n = f.box ? names.get(k) : '';
    return { ...f, name: n || DEFAULT_FOLDER_NAME, savedName: n || '', nameFailed: n === null, nameLoading: f.box ? !names.has(k) : false };
  });
  return { loading, folders };
}

/** Patch entries for planMove/planTake results. */
function changesPatch(uid, changes) {
  const patch = {};
  for (const [fid, sids] of Object.entries(changes)) {
    if (sids === null) patch[`${base(uid)}/${fid}`] = null;
    else patch[`${base(uid)}/${fid}/sids`] = sidsString(sids);
  }
  return patch;
}

/** Create a folder holding `sids` (taken out of other folders in the same update). Resolves to its id. */
export async function createFolder(folders, { name, color, sids }) {
  if (folders.length >= FOLDER_MAX) throw new Error(`You can have up to ${FOLDER_MAX} folders.`);
  const uid = myUid();
  const fid = push(ref(db, base(uid))).key;
  const box = await sealForMe(folderAad(uid, fid), { name: cleanFolderName(name) });
  const patch = changesPatch(uid, planTake(folders, sids));
  patch[`${base(uid)}/${fid}`] = { iv: box.iv, ct: box.ct, color: cleanColor(color), sids: sidsString(sids), collapsed: false, at: Date.now() };
  await update(ref(db), patch);
  return fid;
}

/** Rename / recolor / set the servers of a folder (an empty server list deletes it). */
export async function editFolder(folders, fid, { name, color, sids }) {
  const uid = myUid();
  const patch = {};
  if (sids !== undefined) {
    Object.assign(patch, changesPatch(uid, planTake(folders.filter((f) => f.id !== fid), sids)));
    if (!sids.length) {
      patch[`${base(uid)}/${fid}`] = null;
      return update(ref(db), patch);
    }
    patch[`${base(uid)}/${fid}/sids`] = sidsString(sids);
  }
  if (name !== undefined) {
    const box = await sealForMe(folderAad(uid, fid), { name: cleanFolderName(name) });
    patch[`${base(uid)}/${fid}/iv`] = box.iv;
    patch[`${base(uid)}/${fid}/ct`] = box.ct;
  }
  if (color !== undefined) patch[`${base(uid)}/${fid}/color`] = cleanColor(color);
  return update(ref(db), patch);
}

export function setFolderCollapsed(fid, collapsed) {
  return update(ref(db, `${base(myUid())}/${fid}`), { collapsed: !!collapsed });
}

/** Remove a folder; its servers go back to the rail. */
export function deleteFolder(fid) {
  return update(ref(db), { [`${base(myUid())}/${fid}`]: null });
}

/** Move a server into folder `to` (before `before`) or out of its folder (`to` = null). */
export function moveServer(folders, sid, to, before = null) {
  const patch = changesPatch(myUid(), planMove(folders, sid, to, before));
  return Object.keys(patch).length ? update(ref(db), patch) : Promise.resolve();
}

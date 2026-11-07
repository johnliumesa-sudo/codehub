// App mount for the personal features (one per signed-in Workspace):
//  - keeps the favorites listener alive and refreshes the chat header star when favorites change;
//  - clears my custom status when its "clear after" time passes, and keeps the public DND flag in
//    line with my private mode;
//  - mirrors Appearance settings to udata/{me}/appearance/prefs while sync is on;
//  - renders the personal dialogs (custom status, server folders).
import { useEffect } from 'react';
import { ref, remove, set, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { useUdata } from '../../../lib/ext/store.js';
import { isDndRecord } from '../lib/statusCore.js';
import { clearCustomStatus, useMyPublicStatus, useMyStatusMode } from '../lib/status.js';
import { retainFavorites, subscribeFavorites } from '../lib/favorites.js';
import { onRemoteAppearance, setAppearanceRemote } from '../lib/appearance.js';
import { closePersonalDialog, openPersonalDialog, usePersonalDialog } from '../lib/uiBus.js';
import CustomStatusDialog from './CustomStatusDialog.jsx';
import { FolderDialog, FoldersDialog } from './ServerFolders.jsx';

function FavoritesKeeper({ uid, onChange }) {
  useEffect(() => retainFavorites(uid), [uid]);
  useEffect(() => subscribeFavorites(onChange), [onChange]);
  return null;
}

function StatusKeeper({ uid }) {
  const { loading: pubLoading, value: pub } = useMyPublicStatus(uid);
  const { loading: modeLoading, mode } = useMyStatusMode();
  const until = pub && typeof pub.until === 'number' ? pub.until : 0;

  // "Clear after": remove the custom status when it expires (readers already hide it by then).
  useEffect(() => {
    if (!until) return undefined;
    const left = until - Date.now();
    const t = setTimeout(() => {
      clearCustomStatus().catch((e) => console.warn('[status] clearing an expired status failed', e));
    }, Math.max(0, Math.min(left, 2_147_000_000)));
    return () => clearTimeout(t);
  }, [until]);

  // The public DND flag follows my private mode (both are written together; this repairs drift).
  const pubDnd = isDndRecord(pub);
  useEffect(() => {
    if (pubLoading || modeLoading) return;
    const want = mode === 'dnd';
    if (want === pubDnd) return;
    update(ref(db, `upub/${uid}/status/now`), { mode: want ? 'dnd' : null }).catch((e) => console.warn('[status] DND flag repair failed', e));
  }, [uid, pubLoading, modeLoading, mode, pubDnd]);
  return null;
}

function AppearanceKeeper({ uid }) {
  const { loading, value } = useUdata('appearance', 'prefs');
  useEffect(() => {
    const r = ref(db, `udata/${uid}/appearance/prefs`);
    setAppearanceRemote({ push: (prefs, ts) => set(r, { ...prefs, ts }), remove: () => remove(r) });
    return () => setAppearanceRemote(null);
  }, [uid]);
  useEffect(() => {
    if (!loading) onRemoteAppearance(value);
  }, [loading, value]);
  return null;
}

function DialogHost() {
  const d = usePersonalDialog();
  if (!d) return null;
  const back = () => (d.props?.back ? openPersonalDialog(d.props.back) : closePersonalDialog());
  if (d.name === 'status') return <CustomStatusDialog onClose={closePersonalDialog} />;
  if (d.name === 'folder') return <FolderDialog key={d.props?.fid || 'new'} fid={d.props?.fid} sids={d.props?.sids} onClose={back} />;
  if (d.name === 'folders') return <FoldersDialog onClose={closePersonalDialog} />;
  return null;
}

/** appMounts entry. `onFavoritesChange` refreshes registry entries that depend on favorites. */
export default function PersonalHost({ ctx, onFavoritesChange }) {
  const uid = ctx?.me?.uid;
  useEffect(() => closePersonalDialog, [uid]);
  if (!uid) return null;
  return (
    <>
      <FavoritesKeeper uid={uid} onChange={onFavoritesChange} />
      <StatusKeeper uid={uid} />
      <AppearanceKeeper uid={uid} />
      <DialogHost />
    </>
  );
}

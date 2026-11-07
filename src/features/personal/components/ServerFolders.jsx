// Server folders in the server rail: named, colored, collapsible groups of servers.
// Drag a server onto a folder (or onto a server inside it) to move it there, onto a loose server to
// make a new folder of the two, or onto "Take out" to leave the folder. The same moves are in the
// server's context menu (right-click, Shift+F10 or the Menu key) and in the folder editor dialog.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ServerIcon as MediaServerIcon } from '../../../components/media/Avatar.jsx';
import { useServerMeta } from '../../../components/layout/hooks.js';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { FOLDER_COLORS, FOLDER_NAME_MAX, folderOf, railLayout } from '../lib/foldersCore.js';
import { createFolder, deleteFolder, editFolder, moveServer, setFolderCollapsed, useServerFolders } from '../lib/folders.js';
import { closePersonalDialog, openPersonalDialog } from '../lib/uiBus.js';
import Dialog from './Dialog.jsx';
import PopMenu from './PopMenu.jsx';

const DND_TYPE = 'application/x-codehub-server';
const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
const sameInfo = (a, b) => !!a && !!b && a.unread === b.unread && a.name === b.name && a.color === b.color;

function nextColor(folders) {
  const used = new Set(folders.map((f) => f.color));
  return FOLDER_COLORS.find((c) => !used.has(c)) || FOLDER_COLORS[folders.length % FOLDER_COLORS.length];
}

function FolderGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
    </svg>
  );
}

function MiniGrid({ sids, info }) {
  return (
    <span className="pf-mini-grid" aria-hidden="true">
      {sids.slice(0, 4).map((sid) => (
        <MediaServerIcon key={sid} sid={sid} name={info[sid]?.name || '?'} color={info[sid]?.color} size={18} />
      ))}
    </span>
  );
}

/**
 * Replaces the plain server list in ServerRail. `renderServer(server, extra)` renders one rail
 * server; extra = { hidden, wrapProps, btnProps, onInfo(sid, { unread, name, color }) }.
 */
export function FolderedServers({ servers, activeSid, renderServer, RailButton }) {
  const ws = useWorkspaceCtx();
  const { folders } = useServerFolders();
  const items = useMemo(() => railLayout(servers, folders), [servers, folders]);
  const bySid = useMemo(() => new Map(servers.map((s) => [s.sid, s])), [servers]);
  const [info, setInfo] = useState({});
  const [drag, setDrag] = useState(null); // { sid, from: folderId | null, over }
  const [menu, setMenu] = useState(null); // { anchor, sid?, folder? }

  const onInfo = useCallback((sid, v) => setInfo((m) => (sameInfo(m[sid], v) ? m : { ...m, [sid]: v })), []);
  const fail = (e) => ws?.toast(e?.message || "Couldn't update your server folders", 'error');
  const nameOf = (sid) => info[sid]?.name || 'this server';

  const dropOn = (target) => (e) => {
    e.preventDefault();
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (target.folder) {
      if (target.sid === d.sid) return;
      moveServer(folders, d.sid, target.folder.id, target.sid || null).catch(fail);
    } else if (target.out) {
      moveServer(folders, d.sid, null).catch(fail);
    } else if (target.sid && target.sid !== d.sid) {
      createFolder(folders, { name: '', color: nextColor(folders), sids: [target.sid, d.sid] }).catch(fail);
    }
  };

  const overProps = (overKey) => ({
    onDragOver: (e) => {
      if (!drag || overKey === drag.sid) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (drag.over !== overKey) setDrag({ ...drag, over: overKey });
    },
    'data-drop': drag && drag.over === overKey ? 'on' : undefined,
  });

  const serverExtra = (sid, folder) => ({
    hidden: !!folder?.collapsed,
    onInfo,
    wrapProps: {
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_TYPE, sid);
        setDrag({ sid, from: folder?.id || null, over: null });
      },
      onDragEnd: () => setDrag(null),
      ...overProps(sid),
      onDrop: dropOn({ sid, folder }),
    },
    btnProps: {
      'aria-keyshortcuts': 'Shift+F10',
      onContextMenu: (e) => {
        e.preventDefault();
        setMenu({ anchor: e.currentTarget, sid, folder });
      },
      onKeyDown: (e) => {
        if (!isMenuKey(e)) return;
        e.preventDefault();
        setMenu({ anchor: e.currentTarget, sid, folder });
      },
    },
  });

  const menuItems = () => {
    if (!menu) return [];
    if (menu.sid) {
      const current = folderOf(folders, menu.sid);
      return [
        { id: 'new', label: 'New folder with this server…', icon: '＋', run: () => openPersonalDialog('folder', { sids: [menu.sid] }) },
        ...items
          .filter((it) => it.type === 'folder' && it.folder.id !== current?.id)
          .map((it) => it.folder)
          .map((f) => ({ id: `to-${f.id}`, label: `Move to “${f.name}”`, icon: <span className="pf-swatch" style={{ background: f.color }} />, run: () => moveServer(folders, menu.sid, f.id).catch(fail) })),
        ...(current ? [{ id: 'out', label: `Take out of “${current.name}”`, icon: '↩', run: () => moveServer(folders, menu.sid, null).catch(fail) }] : []),
        { id: 'sep', separator: true },
        { id: 'manage', label: 'Manage server folders…', icon: '⚙', run: () => openPersonalDialog('folders') },
      ];
    }
    const f = menu.folder;
    return [
      { id: 'edit', label: 'Edit folder…', icon: '✎', run: () => openPersonalDialog('folder', { fid: f.id }) },
      { id: 'toggle', label: f.collapsed ? 'Expand folder' : 'Collapse folder', icon: f.collapsed ? '▾' : '▴', run: () => setFolderCollapsed(f.id, !f.collapsed).catch(fail) },
      { id: 'sep', separator: true },
      { id: 'delete', label: 'Delete folder (keeps the servers)', icon: '✕', danger: true, run: () => deleteFolder(f.id).catch(fail) },
    ];
  };

  const menuRef = useRef(null);
  menuRef.current = menu;
  const closeMenu = useCallback((refocus) => {
    const anchor = menuRef.current?.anchor;
    setMenu(null);
    if (refocus && anchor && document.contains(anchor)) anchor.focus();
  }, []);

  const out = items.map((it) => {
    if (it.type === 'server') {
      const s = bySid.get(it.sid);
      return s ? renderServer(s, serverExtra(it.sid, null)) : null;
    }
    const f = it.folder;
    const unread = it.sids.some((sid) => info[sid]?.unread);
    const hasActive = it.sids.includes(activeSid);
    const title = f.savedName ? `Folder ${f.savedName}` : 'Folder';
    const label = `${title}, ${it.sids.length} server${it.sids.length === 1 ? '' : 's'}${f.collapsed && unread ? ', unread messages' : ''}`;
    return (
      <div key={`f-${f.id}`} className={`pf-folder${f.collapsed ? '' : ' open'}`} style={{ '--folder': f.color }} role="group" aria-label={title}>
        <RailButton
          label={label}
          active={f.collapsed && hasActive}
          unread={f.collapsed && unread}
          color={f.color}
          className="pf-folder-head"
          onClick={() => setFolderCollapsed(f.id, !f.collapsed).catch(fail)}
          wrapProps={{ ...overProps(`f-${f.id}`), onDrop: dropOn({ folder: f }) }}
          btnProps={{
            'aria-expanded': !f.collapsed,
            'aria-keyshortcuts': 'Shift+F10',
            onContextMenu: (e) => {
              e.preventDefault();
              setMenu({ anchor: e.currentTarget, folder: f });
            },
            onKeyDown: (e) => {
              if (!isMenuKey(e)) return;
              e.preventDefault();
              setMenu({ anchor: e.currentTarget, folder: f });
            },
          }}
        >
          {f.collapsed ? <MiniGrid sids={it.sids} info={info} /> : <FolderGlyph />}
        </RailButton>
        {it.sids.map((sid) => {
          const s = bySid.get(sid);
          return s ? renderServer(s, serverExtra(sid, f)) : null;
        })}
      </div>
    );
  });

  return (
    <>
      {out}
      {drag?.from && (
        <div className="pf-drop-out" {...overProps('__out')} onDrop={dropOn({ out: true })}>
          <span aria-hidden="true">↩</span>
          Take out
        </div>
      )}
      {menu && (
        <PopMenu
          anchor={menu.anchor}
          items={menuItems()}
          label={menu.sid ? `Folders for ${nameOf(menu.sid)}` : menu.folder.savedName ? `Folder ${menu.folder.savedName}` : 'Folder'}
          onClose={closeMenu}
        />
      )}
    </>
  );
}

function ServerCheck({ sid, checked, onChange, otherFolder }) {
  const meta = useServerMeta(sid);
  const name = meta.name || (meta.nameFailed ? 'Locked server' : meta.status === 'loading' ? '…' : 'Unavailable server');
  return (
    <label className="pf-check-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <MediaServerIcon sid={sid} name={name} color={meta.color} size={24} />
      <span className="pf-check-name">{name}</span>
      {otherFolder && <span className="pf-muted-sm">in “{otherFolder}”</span>}
    </label>
  );
}

/** Create (no fid; optional initial sids) or edit (fid) a folder: name, color, servers. */
export function FolderDialog({ fid, sids: initialSids = [], onClose }) {
  const ws = useWorkspaceCtx();
  const { loading, folders } = useServerFolders();
  const folder = fid ? folders.find((f) => f.id === fid) : null;
  const [name, setName] = useState('');
  const [color, setColor] = useState(null);
  const [picked, setPicked] = useState(() => new Set(initialSids));
  const [ready, setReady] = useState(!fid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameId = useId();

  useEffect(() => {
    if (ready || loading || !folder || folder.nameLoading) return;
    setName(folder.savedName);
    setColor(folder.color);
    setPicked(new Set(folder.sids));
    setReady(true);
  }, [ready, loading, folder]);

  const servers = ws?.servers || [];
  const shownColor = color || folder?.color || nextColor(folders);
  const sids = servers.map((s) => s.sid).filter((sid) => picked.has(sid));

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!sids.length) {
      setError('Pick at least one server.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (folder) await editFolder(folders, folder.id, { name, color: shownColor, sids });
      else await createFolder(folders, { name, color: shownColor, sids });
      onClose();
    } catch (err) {
      setError(err?.message || "Couldn't save the folder");
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteFolder(folder.id);
      onClose();
    } catch (err) {
      setError(err?.message || "Couldn't delete the folder");
      setBusy(false);
    }
  };

  if (fid && !loading && !folder) {
    return (
      <Dialog title="Server folder" onClose={onClose}>
        <p className="muted">This folder no longer exists.</p>
        <div className="pf-actions"><span className="pf-spacer" /><button type="button" className="btn" onClick={onClose}>Close</button></div>
      </Dialog>
    );
  }

  return (
    <Dialog title={folder ? 'Edit folder' : 'New server folder'} onClose={onClose} className="pf-folder-dialog">
      {!ready ? (
        <p className="muted">Loading…</p>
      ) : (
        <form onSubmit={save} className="pf-form">
          <label className="field" htmlFor={nameId}>
            <span>Folder name</span>
            <input id={nameId} className="input" value={name} maxLength={FOLDER_NAME_MAX} placeholder="Folder" data-autofocus onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="pf-field">
            <span className="pf-field-label" id={`${nameId}-c`}>Color</span>
            <div className="pf-swatches" role="radiogroup" aria-labelledby={`${nameId}-c`}>
              {FOLDER_COLORS.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={shownColor === c}
                  aria-label={`Color ${i + 1}`}
                  tabIndex={shownColor === c ? 0 : -1}
                  className={`pf-swatch-btn${shownColor === c ? ' on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  onKeyDown={(e) => {
                    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                    if (!d) return;
                    e.preventDefault();
                    const n = FOLDER_COLORS[(i + d + FOLDER_COLORS.length) % FOLDER_COLORS.length];
                    setColor(n);
                    e.currentTarget.parentElement.querySelectorAll('[role="radio"]')[(i + d + FOLDER_COLORS.length) % FOLDER_COLORS.length]?.focus();
                  }}
                />
              ))}
            </div>
          </div>
          <fieldset className="pf-fieldset">
            <legend className="pf-field-label">Servers in this folder</legend>
            {servers.length === 0 && <p className="muted">You haven't joined any servers yet.</p>}
            <div className="pf-check-list">
              {servers.map((s) => {
                const other = folders.find((f) => f.id !== folder?.id && f.sids.includes(s.sid));
                return (
                  <ServerCheck
                    key={s.sid}
                    sid={s.sid}
                    checked={picked.has(s.sid)}
                    otherFolder={other ? other.name : null}
                    onChange={(on) => setPicked((p) => {
                      const n = new Set(p);
                      if (on) n.add(s.sid);
                      else n.delete(s.sid);
                      return n;
                    })}
                  />
                );
              })}
            </div>
          </fieldset>
          <p className="pf-note-text">Folder names are encrypted with your key; only you see your folders.</p>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="pf-actions">
            {folder && <button type="button" className="btn ghost danger-text" onClick={remove} disabled={busy}>Delete folder</button>}
            <span className="pf-spacer" />
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : folder ? 'Save' : 'Create folder'}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** List of my folders with edit / delete, and "New folder". */
export function FoldersDialog({ onClose }) {
  const ws = useWorkspaceCtx();
  const { loading, folders } = useServerFolders();
  const fail = (e) => ws?.toast(e?.message || "Couldn't delete the folder", 'error');
  const mine = new Set((ws?.servers || []).map((s) => s.sid));
  return (
    <Dialog title="Server folders" onClose={onClose} className="pf-folders-dialog">
      <p className="pf-note-text">Group servers in the server rail. You can also drag a server onto another one, or right-click a server (Shift+F10 on the keyboard).</p>
      {loading && <p className="muted">Loading…</p>}
      {!loading && folders.length === 0 && <p className="muted">No folders yet.</p>}
      <ul className="pf-folder-list">
        {folders.map((f) => {
          const n = f.sids.filter((sid) => mine.has(sid)).length;
          return (
            <li key={f.id} className="pf-folder-li">
              <span className="pf-swatch" style={{ background: f.color }} aria-hidden="true" />
              <span className="pf-check-name">{f.name}</span>
              <span className="pf-muted-sm">{n} server{n === 1 ? '' : 's'}</span>
              <button type="button" className="btn ghost sm" onClick={() => openPersonalDialog('folder', { fid: f.id, back: 'folders' })} aria-label={`Edit folder ${f.name}`}>Edit</button>
              <button type="button" className="btn ghost sm" onClick={() => deleteFolder(f.id).catch(fail)} aria-label={`Delete folder ${f.name}`}>Delete</button>
            </li>
          );
        })}
      </ul>
      <div className="pf-actions">
        <span className="pf-spacer" />
        <button type="button" className="btn ghost" onClick={() => closePersonalDialog()}>Close</button>
        <button type="button" className="btn primary" onClick={() => openPersonalDialog('folder', { back: 'folders' })} disabled={!(ws?.servers?.length)}>New folder</button>
      </div>
    </Dialog>
  );
}

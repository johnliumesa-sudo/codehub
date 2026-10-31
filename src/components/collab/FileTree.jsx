// Workspace file tree: folders derived from paths, inline create / rename / delete,
// avatars of members currently in each file.
import { useMemo, useState } from 'react';
import { languageFor } from '../../lib/collab/languages.js';
import { normalizePath, validatePath } from '../../lib/collab/workspace.js';
import { AvatarStack, Icon } from './ui.jsx';

// Rows hold nested action buttons, so they can't be <button>s themselves: make them focusable
// buttons for keyboard users (Enter/Space activate; keys pressed on nested buttons are ignored).
const rowA11y = (activate, label, extra = {}) => ({
  role: 'button',
  tabIndex: 0,
  'aria-label': label,
  onKeyDown: (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  },
  ...extra,
});


function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  return root;
}

function InlineInput({ initial = '', placeholder, onSubmit, onCancel, files, exceptFid, depth = 0 }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const path = normalizePath(value);
    const err = validatePath(path, files, exceptFid);
    if (err) return setError(err);
    if (path === initial) return onCancel();
    setBusy(true);
    try {
      await onSubmit(path);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="cx-tree-input" style={{ paddingLeft: 10 + depth * 14 }}>
      <input
        className="input"
        autoFocus
        value={value}
        disabled={busy}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onFocus={(e) => {
          // Select the file name (not the folder or extension) when renaming.
          const v = e.target.value;
          const start = v.lastIndexOf('/') + 1;
          const dot = v.lastIndexOf('.');
          e.target.setSelectionRange(start, dot > start ? dot : v.length);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => !busy && !value.trim() && onCancel()}
      />
      {error && <div className="error-text cx-tree-err">{error}</div>}
    </div>
  );
}

export default function FileTree({ files, loading, error, activeFid, presence, profiles, onOpen, onCreate, onRename, onDelete }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [creating, setCreating] = useState(null); // folder prefix string or null
  const [renaming, setRenaming] = useState(null); // fid
  const [confirmDel, setConfirmDel] = useState(null); // fid
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);
  const tree = useMemo(() => buildTree(shown), [shown]);

  const toggle = (p) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const renderDir = (node, depth) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const items = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    return (
      <>
        {dirs.map((d) => {
          const open = filter || !collapsed.has(d.path);
          return (
            <div key={'d:' + d.path}>
              <div
                className="cx-tree-row cx-dir"
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => toggle(d.path)}
                {...rowA11y(() => toggle(d.path), `Folder ${d.path}`, { 'aria-expanded': !!open })}
              >
                <Icon name="chevron" size={12} className={`cx-chev ${open ? 'open' : ''}`} />
                <Icon name="folder" size={15} className="cx-folder-ico" />
                <span className="cx-name">{d.name}</span>
                <button
                  className="cx-row-act"
                  title={`New file in ${d.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed((s) => {
                      const n = new Set(s);
                      n.delete(d.path);
                      return n;
                    });
                    setCreating(d.path + '/');
                  }}
                >
                  <Icon name="plus" size={13} />
                </button>
              </div>
              {open && (
                <>
                  {creating === d.path + '/' && (
                    <InlineInput
                      initial={d.path + '/'}
                      placeholder="name.ext"
                      files={files}
                      depth={depth + 1}
                      onCancel={() => setCreating(null)}
                      onSubmit={async (p) => {
                        await onCreate(p);
                        setCreating(null);
                      }}
                    />
                  )}
                  {renderDir(d, depth + 1)}
                </>
              )}
            </div>
          );
        })}
        {items.map((f) => {
          if (renaming === f.fid)
            return (
              <InlineInput
                key={f.fid}
                initial={f.path}
                files={files}
                exceptFid={f.fid}
                depth={depth}
                onCancel={() => setRenaming(null)}
                onSubmit={async (p) => {
                  await onRename(f.fid, p);
                  setRenaming(null);
                }}
              />
            );
          const lang = languageFor(f.path);
          const people = (presence[f.fid] || []).map((uid) => profiles[uid] || { uid });
          return (
            <div key={f.fid}>
              <div
                className={`cx-tree-row cx-file ${activeFid === f.fid ? 'active' : ''} ${f.broken ? 'broken' : ''}`}
                style={{ paddingLeft: 22 + depth * 14 }}
                onClick={() => !f.broken && onOpen(f.fid)}
                title={f.path}
                {...rowA11y(() => !f.broken && onOpen(f.fid), f.broken ? `${f.path} (undecryptable)` : `Open ${f.path}`, {
                  'aria-current': activeFid === f.fid ? 'true' : undefined,
                })}
              >
                <span className="cx-lang-dot" style={{ background: lang.color }} />
                <span className="cx-name">{f.name}</span>
                {f.repo && <Icon name="github" size={12} className="cx-gh-mark" title={`From ${f.repo}`} />}
                <AvatarStack people={people} size={16} max={3} />
                <span className="cx-row-acts">
                  {!f.broken && (
                    <button className="cx-row-act" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(f.fid); }}>
                      <Icon name="edit" size={13} />
                    </button>
                  )}
                  <button className="cx-row-act danger" title="Delete" onClick={(e) => { e.stopPropagation(); setConfirmDel(f.fid); }}>
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>
              {confirmDel === f.fid && (
                <div className="cx-confirm" style={{ marginLeft: 22 + depth * 14 }}>
                  <span>Delete for everyone?</span>
                  <button className="btn sm danger" onClick={async () => { setConfirmDel(null); await onDelete(f.fid); }}>Delete</button>
                  <button className="btn sm ghost" onClick={() => setConfirmDel(null)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div className="cx-tree">
      <div className="cx-pane-head">
        <span className="cx-pane-title">Files</span>
        <button className="btn ghost sm" title="New file" onClick={() => setCreating('')}>
          <Icon name="plus" size={14} /> New
        </button>
      </div>
      {files.length > 6 && (
        <div className="cx-filter">
          <Icon name="search" size={13} />
          <input placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="cx-tree-body">
        {creating === '' && (
          <InlineInput
            placeholder="src/index.js"
            files={files}
            onCancel={() => setCreating(null)}
            onSubmit={async (p) => {
              await onCreate(p);
              setCreating(null);
            }}
          />
        )}
        {loading ? (
          <div className="cx-tree-skel">
            {[70, 52, 84, 60].map((w, i) => <div key={i} className="cx-skel" style={{ width: `${w}%` }} />)}
          </div>
        ) : error ? (
          <div className="error-text cx-pad">{error}</div>
        ) : files.length === 0 && creating === null ? (
          <div className="cx-tree-empty">
            <Icon name="code" size={26} />
            <p>No files yet.</p>
            <button className="btn sm primary" onClick={() => setCreating('')}>Create a file</button>
          </div>
        ) : shown.length === 0 ? (
          <div className="muted cx-pad">No matches</div>
        ) : (
          renderDir(tree, 0)
        )}
      </div>
    </div>
  );
}

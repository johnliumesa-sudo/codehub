// Collab tab: end-to-end encrypted, real-time code workspace for a server's code channel.
// Props: { sid, cid, me: {uid, name, color, ...}, serverName }
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getServerKey, subscribeGithubToken } from '../../lib/keystore.js';
import { useProfiles } from '../../lib/profiles.js';
import { CollabProvider } from '../../lib/collab/provider.js';
import { languageFor } from '../../lib/collab/languages.js';
import { getBlobText } from '../../lib/collab/github.js';
import {
  createFile,
  deleteFile,
  importFid,
  updateFileMeta,
  useCollabFiles,
  useFilePresence,
  useRepoLink,
} from '../../lib/collab/workspace.js';
import CollabEditor from './CollabEditor.jsx';
import FileTree from './FileTree.jsx';
import GitHubPanel from './GitHubPanel.jsx';
import { CommitModal, DiffModal } from './GitModals.jsx';
import { AvatarStack, Icon } from './ui.jsx';
import './collab.css';

const MAX_IMPORT_BYTES = 400_000;

const lsKey = (sid, cid) => `codehub.collab.active.${sid}.${cid}`;
function lsGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k, v) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function useProviderState(provider) {
  const [s, setS] = useState({ status: 'connecting', error: null, warning: null, peers: [] });
  useEffect(() => {
    if (!provider) return undefined;
    const read = (p) => setS({ status: p.status, error: p.error, warning: p.warning, peers: p.getPeers() });
    read(provider);
    return provider.subscribe(read);
  }, [provider]);
  return s;
}

export default function CollabView({ sid, cid, me, serverName }) {
  // ---- server key ----
  const [keyState, setKeyState] = useState({ key: null, error: null });
  useEffect(() => {
    let alive = true;
    setKeyState({ key: null, error: null });
    getServerKey(sid)
      .then((key) => alive && setKeyState({ key, error: null }))
      .catch((err) => alive && setKeyState({ key: null, error: err.message }));
    return () => {
      alive = false;
    };
  }, [sid]);
  const sKey = keyState.key;

  // ---- GitHub token (from encrypted vault) ----
  // Live: saving or clearing the token in Settings (a modal over this view) applies immediately.
  const [token, setToken] = useState(null);
  useEffect(() => {
    try {
      return subscribeGithubToken((t) => setToken(t));
    } catch {
      setToken(null);
      return undefined;
    }
  }, []);

  // ---- workspace data ----
  const { files, loading: filesLoading, error: filesError } = useCollabFiles(sid, cid, sKey);
  const repo = useRepoLink(sid, cid, sKey);
  const presence = useFilePresence(sid, cid);
  const presenceUids = useMemo(() => [...new Set(Object.values(presence).flat())], [presence]);
  const profiles = useProfiles(presenceUids);

  const [sideTab, setSideTab] = useState('files');
  const [activeFid, setActiveFidRaw] = useState(() => lsGet(lsKey(sid, cid)));
  const setActiveFid = useCallback(
    (fid) => {
      setActiveFidRaw(fid);
      lsSet(lsKey(sid, cid), fid);
    },
    [sid, cid],
  );
  useEffect(() => {
    setActiveFidRaw(lsGet(lsKey(sid, cid)));
  }, [sid, cid]);

  const activeFile = files.find((f) => f.fid === activeFid) || null;
  // The active file was deleted (or never existed here).
  useEffect(() => {
    if (!filesLoading && activeFid && !activeFile) setActiveFid(null);
  }, [filesLoading, activeFid, activeFile, setActiveFid]);

  // ---- toast ----
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const notify = useCallback((text, kind = 'ok', href) => {
    clearTimeout(toastTimer.current);
    setToast({ text, kind, href, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 6000 : 3200);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // ---- provider for the active file ----
  const [provider, setProvider] = useState(null);
  const providerFid = activeFile && !activeFile.broken ? activeFile.fid : null;
  useEffect(() => {
    if (!sKey || !providerFid) {
      setProvider(null);
      return undefined;
    }
    const p = new CollabProvider({ sid, cid, fid: providerFid, key: sKey, uid: me.uid, user: { name: me.name, color: me.color } });
    setProvider(p);
    return () => {
      p.destroy();
    };
    // Name/color updates are pushed into awareness below without reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, cid, sKey, providerFid, me.uid]);
  useEffect(() => {
    if (!provider || provider.destroyed) return;
    const color = me.color || '#5b8cff';
    provider.awareness.setLocalStateField('user', { uid: me.uid, name: me.name || 'Anonymous', color, colorLight: color + '33' });
  }, [provider, me.uid, me.name, me.color]);
  const pstate = useProviderState(provider);

  const viewRef = useRef(null);
  const [cursor, setCursor] = useState(null);
  const [modal, setModal] = useState(null); // 'diff' | 'commit'
  const getText = useCallback(() => (provider ? provider.ytext.toString() : ''), [provider]);

  // Cmd/Ctrl+S: changes already sync live; flush immediately and reassure.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && provider) {
        e.preventDefault();
        provider.flush();
        notify('All changes are saved and synced automatically');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [provider, notify]);

  // ---- actions ----
  const handleCreate = async (path) => {
    const fid = await createFile({ sid, cid, key: sKey, uid: me.uid, meta: { path } });
    setActiveFid(fid);
  };
  const handleRename = async (fid, path) => {
    const f = files.find((x) => x.fid === fid);
    await updateFileMeta({ sid, cid, key: sKey, fid, meta: { ...f, path } });
  };
  const handleDelete = async (fid) => {
    if (fid === activeFid) setActiveFid(null);
    try {
      await deleteFile({ sid, cid, fid });
      notify('File deleted');
    } catch (err) {
      notify(`Couldn’t delete: ${err.message}`, 'error');
    }
  };

  const openRemote = async ({ path, sha, size }) => {
    const link = repo.link;
    const existing = files.find((f) => f.path === path);
    if (existing) {
      setActiveFid(existing.fid);
      return;
    }
    if (size > MAX_IMPORT_BYTES) {
      notify(`${path} is too large to open (${Math.round(size / 1024)} KB)`, 'error');
      return;
    }
    try {
      // Deterministic id: if a teammate opens the same path at the same moment, both land on
      // one file instead of two divergent copies.
      const fid = await importFid({ sid, cid, key: sKey, path });
      if (files.some((f) => f.fid === fid)) {
        setActiveFid(fid);
        return;
      }
      const text = await getBlobText(link.owner, link.repo, sha, token);
      const res = await createFile({
        sid,
        cid,
        key: sKey,
        uid: me.uid,
        fid,
        meta: { path, repo: `${link.owner}/${link.repo}`, ref: link.branch, sha },
        content: text,
      });
      setActiveFid(res.fid);
      notify(res.existed ? `${path} was just opened by someone else — joined their copy` : `Opened ${path}`);
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const copyForChat = async () => {
    if (!provider || !activeFile) return;
    const view = viewRef.current;
    const lang = languageFor(activeFile.path);
    let code = provider.ytext.toString();
    let where = '';
    if (view) {
      const sel = view.state.selection.main;
      if (!sel.empty) {
        code = view.state.sliceDoc(sel.from, sel.to);
        const a = view.state.doc.lineAt(sel.from).number;
        const b = view.state.doc.lineAt(sel.to).number;
        where = a === b ? ` (line ${a})` : ` (lines ${a}–${b})`;
      }
    }
    const fence = code.includes('```') ? '~~~~' : '```';
    const snippet = `\`${activeFile.path}\`${where}\n${fence}${lang.fence}\n${code.replace(/\n$/, '')}\n${fence}`;
    if (await copyText(snippet)) notify(where ? 'Selection copied — paste it in chat' : 'File copied — paste it in chat');
    else notify('Clipboard unavailable', 'error');
  };

  // ---- render ----
  if (keyState.error)
    return (
      <div className="cx-root cx-center">
        <div className="cx-blank">
          <Icon name="lock" size={30} />
          <h3>Can’t unlock this workspace</h3>
          <p className="muted">{keyState.error}. Ask a server admin to re-invite you.</p>
        </div>
      </div>
    );
  if (!sKey)
    return (
      <div className="cx-root cx-center">
        <div className="spinner" />
      </div>
    );

  const lang = activeFile ? languageFor(activeFile.path) : null;
  const crumbs = activeFile ? activeFile.path.split('/') : [];
  const link = repo.link;
  const peers = pstate.peers;

  return (
    <div className="cx-root">
      <aside className="cx-side">
        <div className="cx-ws-title">
          <span className="cx-ws-icon"><Icon name="code" size={15} /></span>
          <span className="cx-ws-name" title={serverName}>{serverName || 'Workspace'}</span>
          <span className="badge-e2e" title="File names, contents and cursors are end-to-end encrypted"><Icon name="lock" size={10} /> E2E</span>
        </div>
        <div className="cx-side-tabs" role="tablist">
          <button role="tab" aria-selected={sideTab === 'files'} className={sideTab === 'files' ? 'active' : ''} onClick={() => setSideTab('files')}>
            <Icon name="file" size={14} /> Files <span className="cx-count">{files.length}</span>
          </button>
          <button role="tab" aria-selected={sideTab === 'github'} className={sideTab === 'github' ? 'active' : ''} onClick={() => setSideTab('github')}>
            <Icon name="github" size={14} /> GitHub {link && <span className="cx-dot-ok" />}
          </button>
        </div>
        <div className="cx-side-body">
          {sideTab === 'files' ? (
            <FileTree
              files={files}
              loading={filesLoading}
              error={filesError}
              activeFid={activeFid}
              presence={presence}
              profiles={profiles}
              onOpen={setActiveFid}
              onCreate={handleCreate}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          ) : (
            <GitHubPanel
              sid={sid}
              cid={cid}
              sKey={sKey}
              link={link}
              linkLoading={repo.loading}
              linkError={repo.error}
              token={token}
              files={files}
              onOpenRemote={openRemote}
              notify={notify}
            />
          )}
        </div>
      </aside>

      <section className="cx-main">
        {activeFile ? (
          <>
            <header className="cx-toolbar">
              <div className="cx-crumbs" title={activeFile.path}>
                <span className="cx-lang-dot" style={{ background: lang.color }} />
                {crumbs.map((c, i) => (
                  <span key={i} className={i === crumbs.length - 1 ? 'cx-crumb last' : 'cx-crumb'}>
                    {c}
                    {i < crumbs.length - 1 && <span className="cx-crumb-sep">/</span>}
                  </span>
                ))}
              </div>
              <span className={`cx-sync ${pstate.status}`} title={pstate.error || ''}>
                <span className="cx-sync-dot" />
                {pstate.status === 'synced' ? 'Live' : pstate.status === 'error' ? 'Offline' : 'Syncing'}
              </span>
              <div className="cx-toolbar-spacer" />
              {peers.length > 0 && (
                <span className="cx-peers" title={peers.map((p) => p.name).join(', ')}>
                  <AvatarStack people={peers} size={24} max={5} ring />
                </span>
              )}
              <div className="cx-actions">
                <button className="btn sm ghost" onClick={copyForChat} title="Copy selection (or whole file) as a fenced snippet to paste in chat">
                  <Icon name="copy" size={14} /> Send to chat
                </button>
                <button className="btn sm ghost" disabled={!link || pstate.status !== 'synced'} onClick={() => setModal('diff')} title={link ? 'Diff vs GitHub' : 'Link a GitHub repo first'}>
                  <Icon name="diff" size={14} /> Diff
                </button>
                <button
                  className="btn sm primary"
                  disabled={!link || !token || pstate.status !== 'synced'}
                  onClick={() => setModal('commit')}
                  title={!link ? 'Link a GitHub repo first' : !token ? 'Add a GitHub token in Settings' : 'Commit this file to GitHub'}
                >
                  <Icon name="commit" size={14} /> Commit
                </button>
              </div>
            </header>
            {pstate.warning && <div className="cx-banner warn">{pstate.warning}</div>}
            <div className="cx-editor-wrap">
              {pstate.status === 'error' ? (
                <div className="cx-center">
                  <div className="cx-blank">
                    <Icon name="lock" size={28} />
                    <h3>Couldn’t sync this file</h3>
                    <p className="muted">{pstate.error}</p>
                    <button className="btn sm" onClick={() => { const f = activeFid; setActiveFid(null); setTimeout(() => setActiveFid(f), 0); }}>Reload file</button>
                  </div>
                </div>
              ) : pstate.status !== 'synced' || !provider ? (
                <div className="cx-center">
                  <div className="cx-loading">
                    <div className="spinner" />
                    <span className="muted">Decrypting {crumbs[crumbs.length - 1]}…</span>
                  </div>
                </div>
              ) : (
                <CollabEditor
                  key={provider.fid}
                  provider={provider}
                  path={activeFile.path}
                  onCursor={setCursor}
                  onRejectEdit={(bytes) => notify(`That paste is too large to sync (${Math.round(bytes / 1024)} KB). Paste it in smaller pieces.`, 'error')}
                  onView={(v) => {
                    viewRef.current = v;
                  }}
                />
              )}
            </div>
            <footer className="cx-status">
              {cursor && <span>Ln {cursor.line}, Col {cursor.col}{cursor.selected ? ` (${cursor.selected} selected)` : ''}</span>}
              {cursor && <span>{cursor.lines} lines</span>}
              <span className="cx-status-spacer" />
              {activeFile.repo && <span title="Opened from GitHub"><Icon name="github" size={11} /> {activeFile.repo}{activeFile.ref ? `@${activeFile.ref}` : ''}</span>}
              <span>{lang.label}</span>
              <span>{peers.length ? `${peers.length + 1} editing` : 'Only you'}</span>
              <span className="cx-status-e2e"><Icon name="lock" size={11} /> Encrypted</span>
            </footer>
          </>
        ) : (
          <div className="cx-center">
            <div className="cx-blank cx-welcome">
              <div className="cx-welcome-art">
                <Icon name="code" size={34} />
              </div>
              <h3>{files.length ? 'Pick a file to start collaborating' : 'Your shared code workspace'}</h3>
              <p className="muted">
                Everyone in <b>{serverName || 'this server'}</b> edits together in real time. Contents, file names and cursors are
                end-to-end encrypted — the server only stores ciphertext.
              </p>
              <div className="cx-welcome-actions">
                <button className="btn primary" onClick={() => setSideTab('files')}>
                  <Icon name="plus" size={14} /> {files.length ? 'Browse files' : 'New file'}
                </button>
                <button className="btn" onClick={() => setSideTab('github')}>
                  <Icon name="github" size={14} /> {link ? 'Open from GitHub' : 'Link GitHub repo'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {modal === 'diff' && activeFile && link && (
        <DiffModal link={link} file={activeFile} getText={getText} token={token} onClose={() => setModal(null)} />
      )}
      {modal === 'commit' && activeFile && link && (
        <CommitModal sid={sid} cid={cid} sKey={sKey} link={link} file={activeFile} getText={getText} token={token} onClose={() => setModal(null)} notify={notify} />
      )}

      {toast && (
        <div key={toast.id} className={`cx-toast ${toast.kind}`} role="status">
          {toast.text}
          {toast.href && (
            <a href={toast.href} target="_blank" rel="noreferrer noopener">
              View <Icon name="external" size={11} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

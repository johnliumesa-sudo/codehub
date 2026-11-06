// GitHub side panel: link a repo, switch branch, browse the tree, open files into the
// workspace, create branches, open PRs, and list open PRs & issues.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createBranch,
  createPullRequest,
  getRepo,
  getTree,
  listBranches,
  listIssues,
  listPulls,
  parseRepo,
} from '../../lib/collab/github.js';
import { setRepoLink } from '../../lib/collab/workspace.js';
import { languageFor } from '../../lib/collab/languages.js';
import { Icon, Modal, timeAgo } from './ui.jsx';

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


function LinkForm({ space, sid, cid, sKey, token, onDone, initial }) {
  const [repoInput, setRepoInput] = useState(initial ? `${initial.owner}/${initial.repo}` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const parsed = parseRepo(repoInput);
    if (!parsed) return setError('Use the form owner/repo or a GitHub URL');
    setBusy(true);
    setError(null);
    try {
      const info = await getRepo(parsed.owner, parsed.repo, token);
      await setRepoLink({
        space,
        sid,
        cid,
        key: sKey,
        link: { owner: info.owner.login, repo: info.name, branch: info.default_branch },
      });
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="cx-gh-link" onSubmit={submit}>
      <div className="cx-gh-hero">
        <Icon name="github" size={30} />
        <h3>Link a GitHub repository</h3>
        <p className="muted">Browse files, open them for live editing, and commit changes back. The link is end-to-end encrypted.</p>
      </div>
      <label className="field">
        Repository
        <input className="input" placeholder="owner/repo" value={repoInput} onChange={(e) => setRepoInput(e.target.value)} autoFocus />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button className="btn primary" disabled={busy || !repoInput.trim()}>
        {busy ? 'Checking…' : 'Link repository'}
      </button>
      {!token && <p className="cx-hint">No GitHub token saved — public repos work read-only. Add a token in Settings to commit.</p>}
    </form>
  );
}

function RemoteTree({ link, token, files, onOpenRemote }) {
  const [state, setState] = useState({ loading: true, error: null, entries: [], truncated: false });
  const [open, setOpen] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [opening, setOpening] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    getTree(link.owner, link.repo, link.branch, token)
      .then((t) => alive && setState({ loading: false, error: null, ...t }))
      .catch((err) => alive && setState({ loading: false, error: err.message, entries: [], truncated: false }));
    return () => {
      alive = false;
    };
  }, [link.owner, link.repo, link.branch, token, nonce]);

  const inWorkspace = useMemo(() => new Set(files.map((f) => f.path)), [files]);

  const children = useMemo(() => {
    const map = new Map();
    for (const e of state.entries) {
      const i = e.path.lastIndexOf('/');
      const parent = i < 0 ? '' : e.path.slice(0, i);
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(e);
    }
    for (const arr of map.values())
      arr.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'tree' ? -1 : 1));
    return map;
  }, [state.entries]);

  const openFile = async (e) => {
    setOpening(e.path);
    try {
      await onOpenRemote({ path: e.path, sha: e.sha, size: e.size });
    } finally {
      setOpening(null);
    }
  };

  const fileRow = (e, depth, showFull = false) => {
    const name = showFull ? e.path : e.path.split('/').pop();
    return (
      <div
        key={e.path}
        className={`cx-tree-row cx-file ${inWorkspace.has(e.path) ? 'in-ws' : ''}`}
        style={{ paddingLeft: 22 + depth * 14 }}
        onClick={() => !opening && openFile(e)}
        title={inWorkspace.has(e.path) ? 'Already in workspace — click to open' : `Open ${e.path} in workspace`}
        {...rowA11y(() => !opening && openFile(e), `Open ${e.path} in workspace`)}
      >
        <span className="cx-lang-dot" style={{ background: languageFor(e.path).color }} />
        <span className="cx-name">{name}</span>
        {opening === e.path ? <span className="spinner cx-spin-xs" /> : inWorkspace.has(e.path) && <span className="cx-ws-tag">open</span>}
      </div>
    );
  };

  const toggleDir = (path) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const renderLevel = (parent, depth) =>
    (children.get(parent) || []).map((e) => {
      if (e.type === 'blob') return fileRow(e, depth);
      const isOpen = open.has(e.path);
      return (
        <div key={e.path}>
          <div
            className="cx-tree-row cx-dir"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => toggleDir(e.path)}
            {...rowA11y(() => toggleDir(e.path), `Folder ${e.path}`, { 'aria-expanded': isOpen })}
          >
            <Icon name="chevron" size={12} className={`cx-chev ${isOpen ? 'open' : ''}`} />
            <Icon name="folder" size={15} className="cx-folder-ico" />
            <span className="cx-name">{e.path.split('/').pop()}</span>
          </div>
          {isOpen && renderLevel(e.path, depth + 1)}
        </div>
      );
    });

  const q = filter.trim().toLowerCase();
  const matches = q ? state.entries.filter((e) => e.type === 'blob' && e.path.toLowerCase().includes(q)).slice(0, 200) : null;

  return (
    <div className="cx-gh-tree">
      <div className="cx-filter">
        <Icon name="search" size={13} />
        <input placeholder="Find a file…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="cx-row-act" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {state.loading ? (
        <div className="cx-tree-skel">
          {[64, 80, 48, 72, 56].map((w, i) => <div key={i} className="cx-skel" style={{ width: `${w}%` }} />)}
        </div>
      ) : state.error ? (
        <div className="cx-pad">
          <div className="error-text">{state.error}</div>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setNonce((n) => n + 1)}>Retry</button>
        </div>
      ) : (
        <div className="cx-tree-body">
          {state.truncated && <div className="cx-hint cx-pad">Large repo: tree truncated by GitHub. Use search.</div>}
          {matches ? (matches.length ? matches.map((e) => fileRow(e, 0, true)) : <div className="muted cx-pad">No matches</div>) : renderLevel('', 0)}
          {!matches && state.entries.length === 0 && <div className="muted cx-pad">This branch is empty.</div>}
        </div>
      )}
    </div>
  );
}

function ListView({ load, deps, render, empty }) {
  const [state, setState] = useState({ loading: true, error: null, items: [] });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, items: [] });
    load()
      .then((items) => alive && setState({ loading: false, error: null, items: items || [] }))
      .catch((err) => alive && setState({ loading: false, error: err.message, items: [] }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  if (state.loading) return <div className="cx-pad"><div className="spinner cx-spin-sm" /></div>;
  if (state.error)
    return (
      <div className="cx-pad">
        <div className="error-text">{state.error}</div>
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setNonce((n) => n + 1)}>Retry</button>
      </div>
    );
  if (!state.items.length) return <div className="muted cx-pad">{empty}</div>;
  return (
    <div className="cx-tree-body">
      <div className="cx-list-refresh">
        <button className="btn ghost sm" onClick={() => setNonce((n) => n + 1)}><Icon name="refresh" size={12} /> Refresh</button>
      </div>
      {state.items.map(render)}
    </div>
  );
}

function ItemRow({ item, icon, sub }) {
  return (
    <a className="cx-gh-item" href={item.html_url} target="_blank" rel="noreferrer noopener" data-trusted-link>
      <Icon name={icon} size={15} className={`cx-gh-item-ico ${icon}`} />
      <span className="cx-gh-item-main">
        <span className="cx-gh-item-title">{item.title}</span>
        <span className="cx-gh-item-sub">#{item.number} · {item.user?.login} · {timeAgo(item.updated_at)}{sub ? ` · ${sub}` : ''}</span>
      </span>
      <Icon name="external" size={12} className="cx-gh-item-ext" />
    </a>
  );
}

function BranchModal({ link, token, branches, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState(link.branch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const n = name.trim().replace(/\s+/g, '-');
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      await createBranch(link.owner, link.repo, from, n, token);
      onCreated(n);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Create branch" icon="branch" onClose={onClose}>
      <form className="cx-form" onSubmit={submit}>
        <label className="field">
          New branch name
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/my-change" />
        </label>
        <label className="field">
          From
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
            {[...new Set([link.branch, ...branches.map((b) => b.name)])].map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
        {error && <div className="error-text">{error}</div>}
        <div className="cx-form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create & switch'}</button>
        </div>
      </form>
    </Modal>
  );
}

function PullModal({ link, token, branches, defaultBranch, onClose }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [head, setHead] = useState(link.branch);
  const [base, setBase] = useState(defaultBranch || link.branch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const names = [...new Set([link.branch, defaultBranch, ...branches.map((b) => b.name)].filter(Boolean))];
  const submit = async (e) => {
    e.preventDefault();
    if (head === base) return setError('Head and base must be different branches');
    setBusy(true);
    setError(null);
    try {
      setDone(await createPullRequest(link.owner, link.repo, { title: title.trim(), head, base, body }, token));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Open pull request" icon="pr" onClose={onClose}>
      {done ? (
        <div className="cx-form">
          <p>Pull request <b>#{done.number}</b> opened.</p>
          <div className="cx-form-actions">
            <a className="btn primary" href={done.html_url} target="_blank" rel="noreferrer noopener" data-trusted-link>View on GitHub <Icon name="external" size={13} /></a>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : (
        <form className="cx-form" onSubmit={submit}>
          <div className="cx-row2">
            <label className="field">
              Merge
              <select className="input" value={head} onChange={(e) => setHead(e.target.value)}>
                {names.map((b) => <option key={b}>{b}</option>)}
              </select>
            </label>
            <label className="field">
              Into
              <select className="input" value={base} onChange={(e) => setBase(e.target.value)}>
                {names.map((b) => <option key={b}>{b}</option>)}
              </select>
            </label>
          </div>
          <label className="field">
            Title
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Describe the change" />
          </label>
          <label className="field">
            Description
            <textarea className="input cx-textarea" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {error && <div className="error-text">{error}</div>}
          <div className="cx-form-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !title.trim()}>{busy ? 'Opening…' : 'Open pull request'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default function GitHubPanel({ space, sid, cid, sKey, link, linkLoading, linkError, token, files, onOpenRemote, notify, readOnly = false }) {
  const [tab, setTab] = useState('files');
  const [branches, setBranches] = useState([]);
  const [defaultBranch, setDefaultBranch] = useState(null);
  const [modal, setModal] = useState(null); // 'branch' | 'pr' | 'relink' | 'unlink'
  const [branchNonce, setBranchNonce] = useState(0);

  const repoKey = link ? `${link.owner}/${link.repo}` : '';
  useEffect(() => {
    if (!link) return undefined;
    let alive = true;
    listBranches(link.owner, link.repo, token).then((b) => alive && setBranches(b || [])).catch(() => alive && setBranches([]));
    getRepo(link.owner, link.repo, token).then((r) => alive && setDefaultBranch(r.default_branch)).catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey, token, branchNonce]);

  const switchBranch = useCallback(
    async (branch) => {
      try {
        await setRepoLink({ space, sid, cid, key: sKey, link: { ...link, branch } });
      } catch (err) {
        notify(err.message, 'error');
      }
    },
    [space, sid, cid, sKey, link, notify],
  );

  if (linkLoading) return <div className="cx-pad"><div className="spinner cx-spin-sm" /></div>;
  if (!link && readOnly)
    return (
      <div className="cx-gh">
        {linkError && <div className="error-text cx-pad">{linkError}</div>}
        <div className="cx-gh-hero cx-pad">
          <Icon name="github" size={30} />
          <h3>No repository linked</h3>
          <p className="muted">An editor can link a GitHub repository to this workspace.</p>
        </div>
      </div>
    );
  if (!link || modal === 'relink')
    return (
      <div className="cx-gh">
        {linkError && <div className="error-text cx-pad">{linkError}</div>}
        <LinkForm space={space} sid={sid} cid={cid} sKey={sKey} token={token} initial={link} onDone={() => setModal(null)} />
        {modal === 'relink' && <button className="btn ghost sm cx-pad" onClick={() => setModal(null)}>Cancel</button>}
      </div>
    );

  const canWrite = !!token;
  return (
    <div className="cx-gh">
      <div className="cx-gh-head">
        <a className="cx-gh-repo" href={`https://github.com/${link.owner}/${link.repo}`} target="_blank" rel="noreferrer noopener" data-trusted-link title="Open on GitHub">
          <Icon name="github" size={15} />
          <span><span className="muted">{link.owner}/</span>{link.repo}</span>
        </a>
        {!readOnly && <button className="cx-row-act" title="Change repository" onClick={() => setModal('relink')}><Icon name="edit" size={13} /></button>}
        {!readOnly && <button className="cx-row-act danger" title="Unlink" onClick={() => setModal('unlink')}><Icon name="close" size={13} /></button>}
      </div>
      {modal === 'unlink' && (
        <div className="cx-confirm cx-pad-x">
          <span>Unlink repo for everyone?</span>
          <button className="btn sm danger" onClick={async () => { setModal(null); await setRepoLink({ space, sid, cid, key: sKey, link: null }); }}>Unlink</button>
          <button className="btn sm ghost" onClick={() => setModal(null)}>Cancel</button>
        </div>
      )}
      <div className="cx-gh-branch">
        <Icon name="branch" size={14} />
        <select className="cx-select" value={link.branch} disabled={readOnly} title={readOnly ? 'Only editors can switch the workspace branch' : undefined} onChange={(e) => switchBranch(e.target.value)}>
          {[...new Set([link.branch, ...branches.map((b) => b.name)])].map((b) => <option key={b}>{b}</option>)}
        </select>
        <button className="btn sm" disabled={!canWrite || readOnly} title={readOnly ? 'Only editors can create a workspace branch' : canWrite ? 'Create branch' : 'Requires a GitHub token'} onClick={() => setModal('branch')}>
          <Icon name="plus" size={12} />
        </button>
        <button className="btn sm" disabled={!canWrite} title={canWrite ? 'Open pull request' : 'Requires a GitHub token'} onClick={() => setModal('pr')}>
          <Icon name="pr" size={13} /> PR
        </button>
      </div>
      {!canWrite && <div className="cx-hint cx-pad-x">Read-only — add a GitHub token in Settings to commit, branch and open PRs.</div>}
      <div className="cx-subtabs">
        {[['files', 'Files'], ['pulls', 'Pull requests'], ['issues', 'Issues']].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'files' && <RemoteTree link={link} token={token} files={files} onOpenRemote={onOpenRemote} />}
      {tab === 'pulls' && (
        <ListView
          deps={[repoKey, token]}
          load={() => listPulls(link.owner, link.repo, token)}
          empty="No open pull requests."
          render={(p) => <ItemRow key={p.id} item={p} icon="pr" sub={`${p.head?.ref} → ${p.base?.ref}`} />}
        />
      )}
      {tab === 'issues' && (
        <ListView
          deps={[repoKey, token]}
          load={() => listIssues(link.owner, link.repo, token)}
          empty="No open issues."
          render={(i) => <ItemRow key={i.id} item={i} icon="issue" sub={i.comments ? `${i.comments} comments` : ''} />}
        />
      )}
      {modal === 'branch' && (
        <BranchModal
          link={link}
          token={token}
          branches={branches}
          onClose={() => setModal(null)}
          onCreated={async (name) => {
            setModal(null);
            setBranchNonce((n) => n + 1);
            await switchBranch(name);
            notify(`Branch ${name} created`);
          }}
        />
      )}
      {modal === 'pr' && <PullModal link={link} token={token} branches={branches} defaultBranch={defaultBranch} onClose={() => setModal(null)} />}
    </div>
  );
}

// Diff-vs-GitHub and Commit modals for the active workspace file.
import { useEffect, useMemo, useState } from 'react';
import { getFile, putFile } from '../../lib/collab/github.js';
import { diffLines } from '../../lib/collab/diff.js';
import { updateFileMeta } from '../../lib/collab/workspace.js';
import { Icon, Modal } from './ui.jsx';

function useRemoteFile(link, path, token) {
  const [state, setState] = useState({ loading: true, error: null, remote: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, remote: null });
    getFile(link.owner, link.repo, path, link.branch, token)
      .then((remote) => alive && setState({ loading: false, error: null, remote }))
      .catch((err) => alive && setState({ loading: false, error: err.message, remote: null }));
    return () => {
      alive = false;
    };
  }, [link.owner, link.repo, link.branch, path, token]);
  return state;
}

function DiffBody({ oldText, newText }) {
  const d = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  if (d.tooLarge) return <div className="muted cx-pad">The files differ too much to show a line diff.</div>;
  if (!d.hunks.length) return <div className="cx-diff-same"><Icon name="commit" size={18} /> No changes — identical to GitHub.</div>;
  return (
    <>
      <div className="cx-diff-stats">
        <span className="add">+{d.added}</span> <span className="del">−{d.removed}</span>
      </div>
      <div className="cx-diff">
        {d.hunks.map((h, i) => (
          <div key={i} className="cx-hunk">
            <div className="cx-hunk-head">@@ −{h.oldStart} +{h.newStart} @@</div>
            {h.lines.map((l, j) => (
              <div key={j} className={`cx-dl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}`}>
                <span className="cx-ln">{l.oldNo ?? ''}</span>
                <span className="cx-ln">{l.newNo ?? ''}</span>
                <span className="cx-sign">{l.type}</span>
                <span className="cx-code">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

export function DiffModal({ link, file, getText, token, onClose }) {
  const { loading, error, remote } = useRemoteFile(link, file.path, token);
  const text = useMemo(() => getText(), [getText]);
  return (
    <Modal title="Changes vs GitHub" icon="diff" onClose={onClose} wide>
      <div className="cx-diff-meta">
        <code>{file.path}</code>
        <span className="muted">
          vs <b>{link.owner}/{link.repo}</b> @ <b>{link.branch}</b>
        </span>
      </div>
      {loading ? (
        <div className="cx-pad"><div className="spinner" /></div>
      ) : error ? (
        <div className="error-text">{error}</div>
      ) : (
        <>
          {!remote && <div className="cx-hint">This file doesn’t exist on <b>{link.branch}</b> yet — everything is new.</div>}
          <DiffBody oldText={remote?.text ?? ''} newText={text} />
        </>
      )}
    </Modal>
  );
}

export function CommitModal({ space, sid, cid, sKey, link, file, getText, token, onClose, notify }) {
  const { loading, error, remote } = useRemoteFile(link, file.path, token);
  const [message, setMessage] = useState(`Update ${file.path.split('/').pop()}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showDiff, setShowDiff] = useState(false);
  const text = useMemo(() => getText(), [getText]);
  const repoName = `${link.owner}/${link.repo}`;

  const unchanged = remote && remote.text === text;
  const otherRepo = file.repo && file.repo !== repoName;
  const drifted = remote && file.sha && file.repo === repoName && file.ref === link.branch && remote.sha !== file.sha;

  const commit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await putFile(
        link.owner,
        link.repo,
        { path: file.path, text, message: message.trim(), branch: link.branch, sha: remote?.sha },
        token,
      );
      await updateFileMeta({ space, sid, cid, key: sKey, fid: file.fid, meta: { path: file.path, repo: repoName, ref: link.branch, sha: res.contentSha } });
      notify(`Committed to ${link.branch}`, 'ok', res.commitUrl);
      onClose();
    } catch (e2) {
      setErr(e2.status === 409 ? 'GitHub reports a conflict — the file changed while committing. Try again.' : e2.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Commit to GitHub" icon="commit" onClose={onClose} wide={showDiff}>
      <form className="cx-form" onSubmit={commit}>
        <div className="cx-commit-target">
          <div><span className="muted">Repository</span><b>{repoName}</b></div>
          <div><span className="muted">Branch</span><b><Icon name="branch" size={12} /> {link.branch}</b></div>
          <div><span className="muted">File</span><code>{file.path}</code></div>
        </div>
        {loading && <div className="muted">Checking GitHub…</div>}
        {error && <div className="error-text">{error}</div>}
        {!loading && !error && (
          <>
            {otherRepo && <div className="cx-warn">This file was opened from <b>{file.repo}</b>; it will be committed to <b>{repoName}</b>.</div>}
            {drifted && <div className="cx-warn">The file changed on GitHub since it was opened. Committing will overwrite those changes — review the diff first.</div>}
            {!remote && <div className="cx-hint">New file — it will be created on <b>{link.branch}</b>.</div>}
            {unchanged && <div className="cx-hint">No changes compared to GitHub.</div>}
            <label className="field">
              Commit message
              <input className="input" autoFocus value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <button type="button" className="btn ghost sm cx-self-start" onClick={() => setShowDiff((v) => !v)}>
              <Icon name="diff" size={13} /> {showDiff ? 'Hide' : 'Show'} diff
            </button>
            {showDiff && <DiffBody oldText={remote?.text ?? ''} newText={text} />}
          </>
        )}
        {err && <div className="error-text">{err}</div>}
        <div className="cx-form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || loading || !!error || unchanged || !message.trim()}>
            {busy ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

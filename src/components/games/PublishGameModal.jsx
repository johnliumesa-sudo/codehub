// Publish (or update) a workspace as a PUBLIC PLAINTEXT game.
// Props: { ctx, onClose, onPublished?(gameId) }
//   ctx: the CollabView extras contract ({ space, key, me, files, activePath, provider, … }).
// All workspace files are decrypted locally (loadWorkspaceFiles), the chosen .html entry is
// bundled with everything it uses from the workspace (scripts, styles, ES modules, data files;
// bundle()), and the result is written as plaintext to games/{id} + gameCode/{id} + publishLog/{me}
// in ONE update after an explicit confirmation. "Test run" plays exactly that bundle in the same
// sandbox profile as the Arcade (without saving its data).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadWorkspaceFiles } from '../../lib/collab/read.js';
import { CODE_MAX, DESC_MAX, TITLE_MAX, publishCooldownLeft, publishGame, titleFromHtml, updateGame, useGames } from '../../lib/games.js';
import { bundle, cleanPath, formatSize, isHtmlPath } from '../../lib/sandbox.js';
import SandboxFrame from '../sandbox/SandboxFrame.jsx';
import { Icon } from '../sandbox/icons.jsx';
import './games.css';

const CONFIRM_TEXT = 'This decrypts your code and publishes it as PUBLIC PLAINTEXT. Anyone signed in can read and run it.';

const CDN_NOTE = 'When it runs it can load scripts, styles and fonts from cdn.jsdelivr.net/npm, cdnjs, unpkg and Google Fonts; nothing else on the network.';

function useCooldown() {
  const [left, setLeft] = useState(() => publishCooldownLeft());
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft(publishCooldownLeft()), 500);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(publishCooldownLeft())];
}

export default function PublishGameModal({ ctx, onClose, onPublished }) {
  const { space, key, me, activePath, provider } = ctx || {};

  // ---- decrypt the workspace locally ----
  const [load, setLoad] = useState({ status: 'loading', files: [], error: null, done: 0, total: 0 });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await loadWorkspaceFiles(space, key, {
          maxFiles: 200,
          onProgress: (done, total) => alive && setLoad((s) => ({ ...s, done, total })),
        });
        if (!alive) return;
        let files = (list || []).map((f) => ({ path: cleanPath(f.path), text: f.text }));
        // The open editor may be ahead of what's been flushed: use its live text.
        if (activePath && provider && !provider.destroyed && provider.status === 'synced') {
          const p = cleanPath(activePath);
          const live = provider.ytext.toString();
          files = files.some((f) => f.path === p) ? files.map((f) => (f.path === p ? { path: p, text: live } : f)) : [...files, { path: p, text: live }];
        }
        setLoad({ status: 'ready', files, error: null, done: 0, total: 0 });
      } catch (err) {
        if (alive) setLoad({ status: 'error', files: [], error: err?.message || String(err), done: 0, total: 0 });
      }
    })();
    return () => {
      alive = false;
    };
  }, [space, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const htmlFiles = useMemo(() => load.files.filter((f) => isHtmlPath(f.path)).map((f) => f.path).sort(), [load.files]);

  // ---- form ----
  const [entry, setEntry] = useState('');
  useEffect(() => {
    if (entry && htmlFiles.includes(entry)) return;
    const active = activePath ? cleanPath(activePath) : '';
    const pick =
      (isHtmlPath(active) && htmlFiles.includes(active) && active) ||
      htmlFiles.find((p) => p === 'index.html') ||
      htmlFiles.find((p) => /(^|\/)index\.html?$/i.test(p)) ||
      htmlFiles[0] ||
      '';
    setEntry(pick);
  }, [htmlFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const { games: ownGames } = useGames({ sort: 'new', ownerId: me?.uid || '-', limit: 100 });
  const myGames = useMemo(() => ownGames.filter((g) => g.ownerId === me?.uid), [ownGames, me?.uid]);
  const [target, setTarget] = useState('new'); // 'new' | gameId
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testIssues, setTestIssues] = useState([]);
  const onTestRuntime = useCallback((ev) => {
    if (ev.kind === 'start') return;
    setTestIssues((list) => (list.length >= 6 || list.some((x) => x.message === ev.message) ? list : [...list, ev]));
  }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null); // { gameId, updated }
  const [cooldown, refreshCooldown] = useCooldown();

  const built = useMemo(() => {
    if (!entry || load.status !== 'ready') return null;
    try {
      return { ...bundle(entry, load.files), error: null };
    } catch (ex) {
      return { html: '', missing: [], inlined: [], external: [], unpinned: [], modules: [], errors: [], error: ex?.message || String(ex) };
    }
  }, [entry, load.status, load.files]);

  // Default the title from <title> (or the file name) until the user types one.
  useEffect(() => {
    if (titleTouched || target !== 'new' || !entry) return;
    const f = load.files.find((x) => x.path === entry);
    const fromDoc = titleFromHtml(f?.text);
    const parts = entry.split('/');
    const fallback = parts.length > 1 ? parts[parts.length - 2] : '';
    setTitle(fromDoc || fallback);
  }, [entry, load.files, titleTouched, target]);

  const chooseTarget = (value) => {
    setTarget(value);
    const g = myGames.find((x) => x.id === value);
    if (g) {
      setTitle(g.title);
      setDesc(g.desc);
      setTitleTouched(true);
    }
  };
  // The selected game was deleted elsewhere.
  useEffect(() => {
    if (target !== 'new' && !myGames.some((g) => g.id === target)) setTarget('new');
  }, [myGames, target]);

  const blockedUrls = (built?.external || []).filter((x) => !x.allowed).map((x) => x.url);
  const size = built?.html?.length || 0;
  const ratio = Math.min(1, size / CODE_MAX);
  const tooBig = size > CODE_MAX;
  const meterClass = tooBig ? 'over' : ratio > 0.85 ? 'high' : '';
  const canPublish =
    !busy && !done && load.status === 'ready' && !!built && !built.error && size > 0 && !tooBig && !!title.trim() && confirmed && cooldown <= 0 && !ctx?.readOnly;

  const submit = async (e) => {
    e.preventDefault();
    if (!canPublish) return;
    setBusy(true);
    setErr('');
    try {
      if (target === 'new') {
        const gameId = await publishGame({ uid: me.uid, title, desc, html: built.html });
        setDone({ gameId, updated: false });
        onPublished?.(gameId);
      } else {
        await updateGame({ uid: me.uid, gameId: target, title, desc, html: built.html });
        setDone({ gameId: target, updated: true });
        onPublished?.(target);
      }
    } catch (ex) {
      setErr(ex?.message || 'Publishing failed');
    } finally {
      setBusy(false);
      refreshCooldown();
    }
  };

  // Capture phase so Escape doesn't also reach editor shortcuts underneath.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop gm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose?.()}>
      <form className="modal gm-modal gm-publish" role="dialog" aria-modal="true" aria-label="Publish game" onSubmit={submit}>
        <div className="gm-modal-head">
          <h2>
            <Icon name="gamepad" size={18} /> Publish to the Arcade
          </h2>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close" disabled={busy}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {done ? (
          <div className="gm-done">
            <span className="gm-done-icon"><Icon name="check" size={26} /></span>
            <h3>{done.updated ? 'Game updated' : 'Game published'}</h3>
            <p className="muted">
              “{title.trim()}” is live in the Arcade{done.updated ? '' : ' under New and Mine'}. Anyone signed in can play it and read its code.
            </p>
            <div className="gm-modal-foot">
              <button type="button" className="btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : load.status === 'loading' ? (
          <div className="gm-loading">
            <span className="spinner" />
            <span className="muted">Decrypting workspace files{load.total ? ` (${load.done}/${load.total})` : ''}…</span>
          </div>
        ) : load.status === 'error' ? (
          <div className="gm-loading">
            <Icon name="alert" size={24} />
            <p className="error-text">Couldn’t read the workspace: {load.error}</p>
          </div>
        ) : htmlFiles.length === 0 ? (
          <div className="gm-loading">
            <Icon name="file" size={24} />
            <p>A game needs an HTML entry file.</p>
            <p className="muted gm-small">Create an <code>index.html</code> in this workspace (it can pull in <code>.js</code> and <code>.css</code> files next to it), then publish again.</p>
          </div>
        ) : (
          <>
            <div className="gm-row">
              <label className="field">
                Publish as
                <select className="input" value={target} onChange={(e) => chooseTarget(e.target.value)}>
                  <option value="new">A new game</option>
                  {myGames.map((g) => (
                    <option key={g.id} value={g.id}>
                      Update “{g.title}”
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Entry file
                <select className="input" value={entry} onChange={(e) => setEntry(e.target.value)}>
                  {htmlFiles.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              Title
              <input
                className="input"
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                }}
                placeholder="Snake, but faster"
                dir="auto"
              />
            </label>
            <label className="field">
              Description
              <textarea className="input gm-textarea" rows={3} value={desc} maxLength={DESC_MAX} onChange={(e) => setDesc(e.target.value)} placeholder="How to play, controls, credits…" dir="auto" />
              <span className="gm-counter">{desc.length}/{DESC_MAX}</span>
            </label>

            <div className="gm-meter-wrap">
              <div className="gm-meter-label">
                <span>Bundle size</span>
                <span className={tooBig ? 'error-text' : 'muted'}>
                  {formatSize(size)} of {formatSize(CODE_MAX)}
                </span>
              </div>
              <div className={`gm-meter ${meterClass}`} role="meter" aria-valuemin={0} aria-valuemax={CODE_MAX} aria-valuenow={size} aria-label="Bundle size">
                <span style={{ width: `${Math.max(1, ratio * 100)}%` }} />
              </div>
              {built?.error && <p className="error-text gm-small">{built.error}</p>}
              {built && !built.error && (
                <p className="muted gm-small">
                  {built.inlined.length ? `Inlined ${built.inlined.length} file${built.inlined.length === 1 ? '' : 's'}: ${built.inlined.slice(0, 4).join(', ')}${built.inlined.length > 4 ? '…' : ''}.` : 'No linked workspace files.'}
                  {built.missing.length > 0 && <span className="gm-warn"> Not found: {built.missing.slice(0, 3).join(', ')}{built.missing.length > 3 ? '…' : ''}.</span>}
                  {' '}{CDN_NOTE}
                </p>
              )}
              {blockedUrls.length > 0 && (
                <p className="gm-warn gm-small" role="note">
                  Won’t load in the sandbox: {blockedUrls.slice(0, 3).join(', ')}{blockedUrls.length > 3 ? ` +${blockedUrls.length - 3} more` : ''}. Load it from
                  jsDelivr (cdn.jsdelivr.net/npm/…), cdnjs or unpkg instead, or copy it into the workspace.
                </p>
              )}
              {built?.unpinned?.length > 0 && (
                <p className="muted gm-small">
                  Unpinned packages (latest version at play time): {built.unpinned.slice(0, 4).join(', ')}{built.unpinned.length > 4 ? '…' : ''}. Add them with a
                  version to a <code>package.json</code> to pin them.
                </p>
              )}
              {built?.errors?.length > 0 && <p className="error-text gm-small">{built.errors.slice(0, 3).join(' · ')}</p>}
              {tooBig && <p className="error-text gm-small">Too large to publish. Trim assets or code below {formatSize(CODE_MAX)}.</p>}
            </div>

            <div className="gm-test">
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setTestIssues([]);
                  setTesting((t) => !t);
                }}
                disabled={!built || !!built.error || !size}
              >
                <Icon name={testing ? 'stop' : 'play'} size={11} fill="currentColor" /> {testing ? 'Stop test' : 'Test run'}
              </button>
              <span className="muted gm-small">Runs exactly what will be published, in the same sandbox.</span>
            </div>
            {testing && built?.html && (
              <div className="gm-test-stage">
                <SandboxFrame html={built.html} profile="play" mode="game" onRuntime={onTestRuntime} title="Game test run" />
              </div>
            )}
            {testing && testIssues.length > 0 && (
              <ul className="gm-test-issues" role="alert" aria-label="Test run problems">
                {testIssues.map((x, i) => (
                  <li key={i}>
                    <code>{x.message}</code>
                  </li>
                ))}
              </ul>
            )}

            <label className={`gm-confirm ${confirmed ? 'on' : ''}`}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                <Icon name="alert" size={14} /> {CONFIRM_TEXT}
              </span>
            </label>

            {ctx?.readOnly && <p className="error-text gm-small">This workspace is read-only for you, so it can’t be published from here.</p>}
            {err && <p className="error-text" role="alert">{err}</p>}
            <div className="gm-modal-foot">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="btn primary gm-publish-btn" disabled={!canPublish}>
                {busy ? 'Publishing…' : cooldown > 0 ? `Wait ${Math.ceil(cooldown / 1000)}s` : target === 'new' ? 'Publish publicly' : 'Update game'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  );
}

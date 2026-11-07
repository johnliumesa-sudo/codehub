// Install and update dialogs (personal or server). Both show the permissions before anything is
// written, and pin exactly the code that was reviewed (its SHA-256).
import { useEffect, useMemo, useState } from 'react';
import { diffLines } from '../../../lib/collab/diff.js';
import { isCurrentRuntime, normalizePerms, permDiff, PERM_INFO, updateBlock } from '../lib/manifest.js';
import { installPersonal, installServer, loadAddon, loadPinnedCode, personalPinPath, serverPinPath } from '../lib/store.js';
import Dialog from './Dialog.jsx';
import { AddonIcon, PermPicker, Publisher, errText } from './bits.jsx';

/** Shown instead of Install / Accept when a listing can't be installed. */
export const OLD_RUNTIME_TEXT =
  'This add-on needs an update for the new add-on runtime: it was written for the old one, which let add-on code run in a web page. It can be installed once its publisher updates it.';

const targetLabel = (target) => (target?.scope === 'server' ? `on ${target.serverName || 'this server'}` : 'for you');

function Note({ target }) {
  return target?.scope === 'server' ? (
    <p className="ad-hint muted">
      Every member can open it from the channel header. Each member sees these permissions and must accept them the first
      time they open it. It runs in each member’s browser, in a sandbox with no network access, and stops running if it is
      removed from the directory.
    </p>
  ) : (
    <p className="ad-hint muted">
      It runs in a sandbox in your browser with no network access. Only you see it. If it is removed from the directory, it stops
      running.
    </p>
  );
}

/**
 * Load the published add-on and show the install dialog.
 * target: { scope: 'personal' } | { scope: 'server', sid, serverName }
 */
export function InstallDialog({ id, target, onClose, onInstalled }) {
  const [state, setState] = useState({ loading: true, error: '', manifest: null, code: '' });
  const [perms, setPerms] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let off = false;
    loadAddon(id).then(
      ({ manifest, code }) => {
        if (off) return;
        setState({ loading: false, error: '', manifest, code });
        setPerms(manifest.perms);
      },
      (e) => !off && setState({ loading: false, error: errText(e), manifest: null, code: '' }),
    );
    return () => {
      off = true;
    };
  }, [id]);

  const { manifest, code } = state;
  const install = async () => {
    setBusy(true);
    setErr('');
    try {
      if (target?.scope === 'server') await installServer(target.sid, manifest, code, perms);
      else await installPersonal(manifest, code, perms);
      onInstalled?.(manifest);
      onClose();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={manifest ? `Install ${manifest.name} ${targetLabel(target)}` : 'Install add-on'} onClose={onClose}>
      {state.loading ? (
        <div className="ad-center"><div className="spinner" aria-label="Checking the add-on" /></div>
      ) : state.error ? (
        <p className="error-text" role="alert">{state.error}</p>
      ) : (
        <>
          <div className="ad-run-title">
            <AddonIcon icon={manifest.icon} />
            <div>
              <h4>{manifest.name}</h4>
              <span className="muted">v{manifest.version} · checksum {manifest.sha.slice(0, 12)}</span>
            </div>
          </div>
          {isCurrentRuntime(manifest) ? (
            <>
              <PermPicker requested={manifest.perms} value={perms} onChange={setPerms} />
              <Note target={target} />
            </>
          ) : (
            <p className="ad-warn" role="note">{OLD_RUNTIME_TEXT}</p>
          )}
          {err && <p className="error-text" role="alert">{err}</p>}
        </>
      )}
      <div className="ad-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        {manifest && isCurrentRuntime(manifest) && (
          <button type="button" className="btn primary" disabled={busy} onClick={install}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Review a published update of an installed add-on: version, permission changes and a code diff
 * against the pinned copy. Accepting re-pins the new code.
 * install: parseInstall result; target as above.
 */
export function UpdateDialog({ install, target, onClose }) {
  const [state, setState] = useState({ loading: true, error: '', manifest: null, code: '', oldCode: '' });
  const [perms, setPerms] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let off = false;
    const pinPath = target?.scope === 'server' ? serverPinPath(target.sid, install.id) : personalPinPath(install.id);
    Promise.all([loadAddon(install.id), loadPinnedCode(pinPath, install.sha).catch(() => '')]).then(
      ([{ manifest, code }, oldCode]) => {
        if (off) return;
        setState({ loading: false, error: '', manifest, code, oldCode });
        // Keep what was granted; newly requested permissions start unticked so they are a choice.
        setPerms(normalizePerms(manifest.perms.filter((p) => install.perms.includes(p))));
      },
      (e) => !off && setState({ loading: false, error: errText(e), manifest: null, code: '', oldCode: '' }),
    );
    return () => {
      off = true;
    };
  }, [install.id, install.sha, target?.scope, target?.sid]); // eslint-disable-line react-hooks/exhaustive-deps

  const { manifest, code, oldCode } = state;
  const blocked = manifest ? updateBlock(install, manifest) : null;
  const changes = manifest ? permDiff(install.perms, manifest.perms) : { added: [], removed: [] };
  const diff = useMemo(() => (manifest && oldCode ? diffLines(oldCode, code, 2) : null), [manifest, oldCode, code]);

  const accept = async () => {
    setBusy(true);
    setErr('');
    try {
      if (target?.scope === 'server') await installServer(target.sid, manifest, code, perms);
      else await installPersonal(manifest, code, perms, { auto: install.auto && perms.includes('send') && install.perms.includes('send') });
      onClose();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Update ${install.name}`} onClose={onClose} wide>
      {state.loading ? (
        <div className="ad-center"><div className="spinner" aria-label="Loading the update" /></div>
      ) : state.error ? (
        <p className="error-text" role="alert">{state.error}</p>
      ) : blocked === 'publisher' ? (
        <p className="error-text" role="alert">
          This update was published by a different account (<Publisher uid={manifest.by} />) than the version that was approved, so
          Codehub won’t apply it. Uninstall the add-on, and install it again only if you trust the new publisher.
        </p>
      ) : blocked === 'runtime' ? (
        <p className="ad-warn" role="note">{OLD_RUNTIME_TEXT}</p>
      ) : (
        <>
          <p>
            Version <strong>{install.v || '?'}</strong> → <strong>{manifest.version}</strong> by <Publisher uid={manifest.by} />. Until you
            accept, {target?.scope === 'server' ? 'members keep' : 'you keep'}{' '}
            {install.rt === manifest.rt ? 'running the version that was approved' : 'seeing “needs update” instead of the add-on'}.
          </p>
          {changes.added.length > 0 && (
            <div className="ad-warn" role="note">
              <strong>New permissions requested:</strong> {changes.added.map((p) => PERM_INFO[p].label).join(', ')}.
              {target?.scope === 'server' && ' Members will be asked to accept them again.'}
            </div>
          )}
          {changes.removed.length > 0 && (
            <p className="muted">No longer requested: {changes.removed.map((p) => PERM_INFO[p].label).join(', ')}.</p>
          )}
          <PermPicker requested={manifest.perms} value={perms} onChange={setPerms} />
          <details className="ad-diff">
            <summary>
              Code changes{diff && !diff.tooLarge ? ` (+${diff.added} −${diff.removed} lines)` : ''}
            </summary>
            {!oldCode ? (
              <p className="muted">The previously approved copy is not available to compare.</p>
            ) : diff?.tooLarge ? (
              <p className="muted">The change is too large to show line by line.</p>
            ) : (
              <pre className="ad-diff-body">
                {diff.hunks.map((h, i) => (
                  <span key={i} className="ad-hunk">
                    <span className="ad-hunk-head">@@ −{h.oldStart} +{h.newStart} @@{'\n'}</span>
                    {h.lines.map((l, j) => (
                      <span key={j} className={l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}>
                        {l.type === ' ' ? ' ' : l.type} {l.text}{'\n'}
                      </span>
                    ))}
                  </span>
                ))}
              </pre>
            )}
          </details>
          {err && <p className="error-text" role="alert">{err}</p>}
        </>
      )}
      <div className="ad-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Not now</button>
        {manifest && !blocked && (
          <button type="button" className="btn primary" disabled={busy} onClick={accept}>
            {busy ? 'Updating…' : 'Accept update'}
          </button>
        )}
      </div>
    </Dialog>
  );
}

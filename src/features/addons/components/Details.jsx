// One add-on in the directory: what it is, who published it, the permissions it asks for (shown
// before install), install / update / uninstall, try it with sample data, report, and owner or
// app-admin removal.
import { useState } from 'react';
import { useIsAppAdmin } from '../../../lib/admin.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { formatBytes } from '../lib/manifest.js';
import { loadAddon, unpublishAddon, uninstallPersonal, uninstallServer, useManifest, usePersonalInstalls, useServerInstalls } from '../lib/store.js';
import { InstallDialog, UpdateDialog } from './InstallFlow.jsx';
import PreviewPane from './PreviewPane.jsx';
import ReportAddon from './ReportAddon.jsx';
import { AddonIcon, PermList, Publisher, errText, fmtDate } from './bits.jsx';

/**
 * Props: id, me, onBack?, onEdit?(id), target? ({ scope: 'server', sid, serverName } to install on a
 * server; default: personal), canManageServer? (server target: I hold manageApps)
 */
export default function Details({ id, me, onBack, onEdit, target = { scope: 'personal' } }) {
  const { manifest, loading } = useManifest(id);
  const isAdmin = useIsAppAdmin();
  const personal = usePersonalInstalls();
  const server = useServerInstalls(target.scope === 'server' ? target.sid : null);
  const installs = target.scope === 'server' ? server.list : personal.list;
  const installed = installs.find((i) => i.id === id) || null;
  const [dialog, setDialog] = useState(null); // 'install' | 'update'
  const [trying, setTrying] = useState(null); // { code } | { error }
  const [err, setErr] = useState('');

  if (loading) return <div className="ad-center"><div className="spinner" aria-label="Loading add-on" /></div>;
  if (!manifest) {
    return (
      <div className="ad-details">
        {onBack && <BackButton onBack={onBack} />}
        <p className="muted">This add-on is no longer in the directory.</p>
        {installed && (
          <button type="button" className="btn danger sm" onClick={() => (target.scope === 'server' ? uninstallServer(target.sid, id) : uninstallPersonal(id)).catch((e) => setErr(errText(e)))}>
            Uninstall {installed.name}
          </button>
        )}
        {err && <p className="error-text" role="alert">{err}</p>}
      </div>
    );
  }

  const mine = manifest.by === me?.uid;
  const hasUpdate = installed && installed.sha !== manifest.sha;
  const where = target.scope === 'server' ? 'on this server' : '';

  const tryIt = async () => {
    if (trying) return setTrying(null);
    try {
      const { code } = await loadAddon(id);
      setTrying({ code });
    } catch (e) {
      setTrying({ error: errText(e) });
    }
    return undefined;
  };

  return (
    <article className="ad-details" aria-labelledby={`ad-d-${id}`}>
      {onBack && <BackButton onBack={onBack} />}
      <header className="ad-d-head">
        <AddonIcon icon={manifest.icon} size="lg" />
        <div className="ad-d-title">
          <h3 id={`ad-d-${id}`}>{manifest.name}</h3>
          <span className="muted">
            v{manifest.version} · by <Publisher uid={manifest.by} /> · updated {fmtDate(manifest.ts)} · {formatBytes(manifest.size)}
          </span>
        </div>
      </header>
      {manifest.desc ? <p className="ad-desc">{manifest.desc}</p> : <p className="muted">No description.</p>}

      <section aria-labelledby={`ad-d-perms-${id}`}>
        <h4 id={`ad-d-perms-${id}`} className="ad-subhead">Permissions it asks for</h4>
        <PermList perms={manifest.perms} />
      </section>

      <p className="ad-hint muted">
        Checksum <code className="ad-code-inline">{manifest.sha.slice(0, 16)}…</code>. Installing pins this exact code;
        later changes by the publisher wait for {target.scope === 'server' ? 'a server manager' : 'you'} to review them.
      </p>

      <div className="ad-actions left">
        {!installed && (
          <button type="button" className="btn primary" onClick={() => setDialog('install')}>
            {target.scope === 'server' ? 'Install on this server' : 'Install'}
          </button>
        )}
        {installed && !hasUpdate && <span className="ad-chip ok">Installed {where}</span>}
        {hasUpdate && (
          <button type="button" className="btn primary" onClick={() => setDialog('update')}>
            Review update to v{manifest.version}
          </button>
        )}
        {installed && (
          <ConfirmButton
            confirmLabel={target.scope === 'server' ? 'Remove for everyone?' : 'Uninstall and delete its data?'}
            onConfirm={() => (target.scope === 'server' ? uninstallServer(target.sid, id) : uninstallPersonal(id)).catch((e) => setErr(errText(e)))}
          >
            Uninstall
          </ConfirmButton>
        )}
        <button type="button" className="btn sm" onClick={tryIt} aria-expanded={!!trying}>
          {trying ? 'Close preview' : 'Try with sample data'}
        </button>
        {!mine && <ReportAddon addon={manifest} />}
        {mine && onEdit && <button type="button" className="btn sm" onClick={() => onEdit(id)}>Edit</button>}
        {mine && (
          <ConfirmButton confirmLabel="Unpublish for everyone?" onConfirm={() => unpublishAddon(id).then(onBack, (e) => setErr(errText(e)))}>
            Unpublish
          </ConfirmButton>
        )}
        {!mine && isAdmin && (
          <ConfirmButton confirmLabel="Remove for everyone?" onConfirm={() => unpublishAddon(id).then(onBack, (e) => setErr(errText(e)))}>
            Remove (app admin)
          </ConfirmButton>
        )}
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}

      {trying?.error && <p className="error-text" role="alert">{trying.error}</p>}
      {trying?.code && (
        <div className="ad-try">
          <PreviewPane code={trying.code} perms={manifest.perms} meName={me?.name} title={`${manifest.name} preview`} />
        </div>
      )}

      {dialog === 'install' && <InstallDialog id={id} target={target} onClose={() => setDialog(null)} />}
      {dialog === 'update' && installed && <UpdateDialog install={installed} target={target} onClose={() => setDialog(null)} />}
    </article>
  );
}

export function BackButton({ onBack, label = 'Back to the directory' }) {
  return (
    <button type="button" className="btn sm ghost ad-back" onClick={onBack}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      {label}
    </button>
  );
}

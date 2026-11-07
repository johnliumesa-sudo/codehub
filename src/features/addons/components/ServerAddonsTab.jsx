// Server settings → "Add-ons" (members with manageApps): install add-ons for the server from the
// directory, review updates, uninstall.
import { useState } from 'react';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { uninstallServer, useManifest, useServerInstalls } from '../lib/store.js';
import Details, { BackButton } from './Details.jsx';
import Directory from './Directory.jsx';
import { UpdateDialog } from './InstallFlow.jsx';
import { AddonIcon, PermChips, Publisher, errText, fmtDate } from './bits.jsx';
import { MAX_HEADER_ADDONS } from './ServerAddonMount.jsx';
import '../addons.css';

export default function ServerAddonsTab({ ctx }) {
  const sid = ctx.sid;
  const serverName = ctx.server?.meta?.name || '';
  const { loading, list } = useServerInstalls(sid);
  const [view, setView] = useState(null); // null | 'browse' | { id }
  const [err, setErr] = useState('');
  const target = { scope: 'server', sid, serverName };
  const installedIds = new Set(list.map((i) => i.id));

  if (view && typeof view === 'object') {
    return (
      <div className="ad-settings">
        <Details id={view.id} me={ctx.me} target={target} onBack={() => setView('browse')} />
      </div>
    );
  }
  if (view === 'browse') {
    return (
      <div className="ad-settings">
        <BackButton onBack={() => setView(null)} label="Back to installed add-ons" />
        <Directory compact onOpen={(id) => setView({ id })} installedIds={installedIds} />
      </div>
    );
  }

  return (
    <div className="ad-settings">
      <p className="muted">
        Add-ons installed here get a button in every channel’s header (the first {MAX_HEADER_ADDONS}; all of them are in
        the “Add-ons” panel). They run in each member’s browser, in a sandbox with no network access, and every member
        accepts their permissions the first time they open one.
      </p>
      <div className="ad-actions left">
        <button type="button" className="btn primary sm" onClick={() => setView('browse')}>Install an add-on</button>
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}
      {loading ? (
        <div className="ad-center"><div className="spinner" aria-label="Loading" /></div>
      ) : list.length === 0 ? (
        <p className="muted">No add-ons are installed on this server yet.</p>
      ) : (
        <ul className="ad-list">
          {list.map((inst) => (
            <ServerRow key={inst.id} sid={sid} inst={inst} target={target} onDetails={() => setView({ id: inst.id })} onError={setErr} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ServerRow({ sid, inst, target, onDetails, onError }) {
  const { manifest } = useManifest(inst.id);
  const [review, setReview] = useState(false);
  const hasUpdate = manifest && manifest.sha !== inst.sha;
  return (
    <li className="ad-row wrap">
      <AddonIcon icon={inst.icon} />
      <div className="ad-row-main">
        <span className="ad-row-name">
          {inst.name} {inst.v && <span className="muted">v{inst.v}</span>}
          {hasUpdate && <span className="ad-chip warn">update: v{manifest.version}</span>}
          {!manifest && <span className="ad-chip quiet">no longer in the directory</span>}
        </span>
        <span className="ad-row-chips"><PermChips perms={inst.perms} /></span>
        {inst.by && (
          <span className="muted ad-hint">
            Installed by <Publisher uid={inst.by} />{inst.at ? ` on ${fmtDate(inst.at)}` : ''}
          </span>
        )}
      </div>
      <div className="ad-row-actions">
        {hasUpdate && <button type="button" className="btn sm primary" onClick={() => setReview(true)}>Review update</button>}
        <button type="button" className="btn sm" onClick={onDetails} disabled={!manifest}>Details</button>
        <ConfirmButton confirmLabel="Remove for everyone?" onConfirm={() => uninstallServer(sid, inst.id).catch((x) => onError(errText(x)))}>
          Uninstall
        </ConfirmButton>
      </div>
      {review && <UpdateDialog install={inst} target={target} onClose={() => setReview(false)} />}
    </li>
  );
}

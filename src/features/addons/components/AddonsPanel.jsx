// The "Add-ons" chat panel: my personal add-ons plus, in a server channel, the server's add-ons.
// Picking one runs it in this panel. Server add-ons also get their own header buttons
// (ServerAddonMount), which open ServerAddonPanel.
import { useState } from 'react';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { openHub } from '../lib/hub.js';
import { usePersonalInstalls, useServerInstalls } from '../lib/store.js';
import AddonRunner from './AddonRunner.jsx';
import { AddonIcon, PermChips } from './bits.jsx';

export function AddonsPanel({ ctx }) {
  const ws = useWorkspaceCtx();
  const sid = ctx.conv.kind === 'channel' ? ctx.conv.sid : null;
  const personal = usePersonalInstalls();
  const server = useServerInstalls(sid);
  const [running, setRunning] = useState(null); // { scope, id }

  const runningInstall = running
    ? (running.scope === 'server' ? server.list : personal.list).find((i) => i.id === running.id)
    : null;
  if (running && runningInstall) {
    return (
      <AddonRunner
        key={`${running.scope}:${running.id}`}
        scope={running.scope}
        sid={sid}
        install={runningInstall}
        ctx={ctx}
        onBack={() => setRunning(null)}
      />
    );
  }

  const loading = personal.loading || (sid && server.loading);
  const row = (scope, inst) => (
    <li key={`${scope}:${inst.id}`} className="ad-row">
      <AddonIcon icon={inst.icon} />
      <div className="ad-row-main">
        <span className="ad-row-name">
          {inst.name} {inst.v && <span className="muted">v{inst.v}</span>}
        </span>
        <span className="ad-row-chips"><PermChips perms={inst.perms} /></span>
      </div>
      <button type="button" className="btn sm primary" onClick={() => setRunning({ scope, id: inst.id })} aria-label={`Open ${inst.name}`}>
        Open
      </button>
    </li>
  );

  return (
    <div className="ad-panel">
      {loading ? (
        <div className="ad-center"><div className="spinner" aria-label="Loading add-ons" /></div>
      ) : (
        <>
          {sid && server.list.length > 0 && (
            <section aria-labelledby="ad-panel-server">
              <h4 id="ad-panel-server" className="ad-subhead">This server</h4>
              <ul className="ad-list">{server.list.map((i) => row('server', i))}</ul>
            </section>
          )}
          <section aria-labelledby="ad-panel-mine">
            <h4 id="ad-panel-mine" className="ad-subhead">Your add-ons</h4>
            {personal.list.length ? (
              <ul className="ad-list">{personal.list.map((i) => row('personal', i))}</ul>
            ) : (
              <p className="muted ad-empty-text">
                Add-ons are small apps that run in a sandbox beside your chats: timers, word clouds, helpers. Install one
                from the directory and it shows up here.
              </p>
            )}
          </section>
        </>
      )}
      <div className="ad-actions left">
        <button type="button" className="btn sm" onClick={() => openHub({ view: 'browse' })}>Browse add-ons</button>
        <button type="button" className="btn sm ghost" onClick={() => ws?.openSettings('addonApps')}>Manage</button>
      </div>
    </div>
  );
}

/** Panel of one server add-on (opened from its own header button). */
export function ServerAddonPanel({ ctx, sid, id }) {
  const server = useServerInstalls(sid);
  const install = server.list.find((i) => i.id === id);
  if (server.loading) return <div className="ad-center"><div className="spinner" aria-label="Loading add-on" /></div>;
  if (!install) return <p className="muted">This add-on is no longer installed on this server.</p>;
  return <AddonRunner key={install.sha} scope="server" sid={sid} install={install} ctx={ctx} />;
}

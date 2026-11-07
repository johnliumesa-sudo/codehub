// The add-on hub (appMount): directory, my published add-ons and the builder in one dialog.
// Opened with openHub() from lib/hub.js.
import { useMemo, useState } from 'react';
import { closeHub } from '../lib/hub.js';
import { usePersonalInstalls, usePublishedBy } from '../lib/store.js';
import { LIMITS } from '../lib/manifest.js';
import Builder from './Builder.jsx';
import Details from './Details.jsx';
import Dialog from './Dialog.jsx';
import Directory from './Directory.jsx';
import { AddonIcon, PermChips, fmtDate } from './bits.jsx';
import '../addons.css';

/** The hub dialog (lazy chunk); HubMount in register.jsx renders it while the hub is open. */
export default function Hub({ initial, me }) {
  const [view, setView] = useState(initial.view);
  const [id, setId] = useState(initial.id);
  const personal = usePersonalInstalls();
  const installedIds = useMemo(() => new Set(personal.list.map((i) => i.id)), [personal.list]);

  const tab = view === 'details' ? 'browse' : view === 'build' && !id ? 'build' : view === 'build' ? 'mine' : view;
  const go = (v, nextId = null) => {
    setView(v);
    setId(nextId);
  };

  const tabs = [
    ['browse', 'Directory'],
    ['mine', 'Your add-ons'],
    ['build', 'Create'],
  ];

  return (
    <Dialog title="Add-ons" onClose={closeHub} wide className="ad-hub">
      <div className="ad-tabs" role="tablist" aria-label="Add-on sections">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`ad-tab${tab === k ? ' on' : ''}`}
            onClick={() => go(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="ad-hub-body" role="tabpanel" aria-label={tabs.find(([k]) => k === tab)?.[1]}>
        {view === 'browse' && <Directory onOpen={(x) => go('details', x)} installedIds={installedIds} />}
        {view === 'details' && id && <Details id={id} me={me} onBack={() => go('browse')} onEdit={(x) => go('build', x)} />}
        {view === 'mine' && <Mine me={me} onOpen={(x) => go('details', x)} onEdit={(x) => go('build', x)} onCreate={() => go('build')} />}
        {view === 'build' && (
          <Builder
            key={id || 'new'}
            me={me}
            editId={id}
            onCancel={() => go(id ? 'mine' : 'browse')}
            onDone={(newId) => (newId ? go('details', newId) : go('mine'))}
          />
        )}
      </div>
    </Dialog>
  );
}

function Mine({ me, onOpen, onEdit, onCreate }) {
  const { loading, list } = usePublishedBy(me?.uid);
  return (
    <div className="ad-mine">
      <div className="ad-actions left">
        <button type="button" className="btn primary sm" onClick={onCreate} disabled={list.length >= LIMITS.perPublisher}>
          New add-on
        </button>
        <span className="muted ad-hint">{list.length}/{LIMITS.perPublisher} published</span>
      </div>
      {loading ? (
        <div className="ad-center"><div className="spinner" aria-label="Loading your add-ons" /></div>
      ) : list.length === 0 ? (
        <p className="muted ad-empty-text">You haven’t published an add-on yet. Create one: it’s a single HTML file.</p>
      ) : (
        <ul className="ad-list">
          {list.map((m) => (
            <li key={m.id} className="ad-row">
              <AddonIcon icon={m.icon} />
              <div className="ad-row-main">
                <span className="ad-row-name">{m.name} <span className="muted">v{m.version} · {fmtDate(m.ts)}</span></span>
                <span className="ad-row-chips"><PermChips perms={m.perms} /></span>
              </div>
              <button type="button" className="btn sm" onClick={() => onOpen(m.id)} aria-label={`View ${m.name}`}>View</button>
              <button type="button" className="btn sm" onClick={() => onEdit(m.id)} aria-label={`Edit ${m.name}`}>Edit</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

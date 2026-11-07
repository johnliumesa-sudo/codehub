// Settings → "Add-on apps": my installed add-ons (updates, auto-send, uninstall), my consents to
// server add-ons, and the data add-ons stored for me.
import { useState } from 'react';
import { useServerMeta } from '../../../components/layout/hooks.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { useUdata } from '../../../lib/ext/store.js';
import { openHub } from '../lib/hub.js';
import { formatBytes, isCurrentRuntime, parseConsent } from '../lib/manifest.js';
import {
  FEAT, clearStorage, revokeConsent, setConsentAutoSend, setPersonalAutoSend, uninstallPersonal, useManifest, usePersonalInstalls, useStoredData,
} from '../lib/store.js';
import { UpdateDialog } from './InstallFlow.jsx';
import { AddonIcon, BlockChip, PermChips, errText } from './bits.jsx';
import '../addons.css';

export default function UserAddonsTab({ ctx }) {
  const personal = usePersonalInstalls();
  const consents = useUdata(FEAT.consent);
  const stored = useStoredData();
  const [err, setErr] = useState('');
  const open = (opts) => {
    ctx.close?.();
    openHub(opts);
  };
  const consentList = Object.entries(consents.value && typeof consents.value === 'object' ? consents.value : {})
    .map(([key, raw]) => {
      const [sid, id] = key.split('~');
      const c = parseConsent(raw);
      return sid && id && c ? { key, sid, id, ...c } : null;
    })
    .filter(Boolean);
  const nameOf = new Map(personal.list.map((i) => [i.id, i.name]));

  return (
    <div className="ad-settings">
      <p className="muted">
        Add-on apps are small programs other Codehub users publish. Their code runs in a sandboxed worker in your browser,
        with no network access and no way to open other pages, and can only do what you allow. Codehub stops running an
        add-on that is removed from the directory. Cosmetic items from the shop are under “Shop items”.
      </p>
      <div className="ad-actions left">
        <button type="button" className="btn primary sm" onClick={() => open({ view: 'browse' })}>Browse the directory</button>
        <button type="button" className="btn sm" onClick={() => open({ view: 'build' })}>Create an add-on</button>
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}

      <section aria-labelledby="ad-s-installed">
        <h3 id="ad-s-installed" className="ad-h3">Installed for you</h3>
        {personal.loading ? (
          <div className="ad-center"><div className="spinner" aria-label="Loading" /></div>
        ) : personal.list.length === 0 ? (
          <p className="muted">Nothing installed yet. Open an add-on from the “Add-ons” button in any chat header.</p>
        ) : (
          <ul className="ad-list">
            {personal.list.map((inst) => <InstalledRow key={inst.id} inst={inst} onError={setErr} />)}
          </ul>
        )}
      </section>

      {consentList.length > 0 && (
        <section aria-labelledby="ad-s-consent">
          <h3 id="ad-s-consent" className="ad-h3">Server add-ons you allowed</h3>
          <ul className="ad-list">
            {consentList.map((c) => <ConsentRow key={c.key} c={c} onError={setErr} />)}
          </ul>
        </section>
      )}

      {stored.list.length > 0 && (
        <section aria-labelledby="ad-s-data">
          <h3 id="ad-s-data" className="ad-h3">Stored data</h3>
          <p className="muted ad-hint">Encrypted with your vault key; only you can read it.</p>
          <ul className="ad-list">
            {stored.list.map((s) => (
              <StoredRow key={s.key} item={s} name={nameOf.get(s.key)} onError={setErr} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function InstalledRow({ inst, onError }) {
  const { manifest, loading } = useManifest(inst.id);
  const [review, setReview] = useState(false);
  const hasUpdate = isCurrentRuntime(manifest) && manifest.sha !== inst.sha && (!inst.publisher || manifest.by === inst.publisher);
  return (
    <li className="ad-row wrap">
      <AddonIcon icon={inst.icon} />
      <div className="ad-row-main">
        <span className="ad-row-name">
          {inst.name} {inst.v && <span className="muted">v{inst.v}</span>}
          {hasUpdate && <span className="ad-chip warn">update: v{manifest.version}</span>}
          <BlockChip install={inst} manifest={manifest} loading={loading} />
        </span>
        <span className="ad-row-chips"><PermChips perms={inst.perms} /></span>
        {inst.perms.includes('send') && (
          <label className="ad-check inline">
            <input
              type="checkbox"
              checked={inst.auto}
              onChange={(e) => setPersonalAutoSend(inst.id, e.target.checked).catch((x) => onError(errText(x)))}
            />
            <span>Send messages without asking me</span>
          </label>
        )}
      </div>
      <div className="ad-row-actions">
        {hasUpdate && <button type="button" className="btn sm primary" onClick={() => setReview(true)}>Review update</button>}
        <button type="button" className="btn sm" onClick={() => openHub({ view: 'details', id: inst.id })} disabled={!manifest}>Details</button>
        <ConfirmButton confirmLabel="Uninstall and delete its data?" onConfirm={() => uninstallPersonal(inst.id).catch((x) => onError(errText(x)))}>
          Uninstall
        </ConfirmButton>
      </div>
      {review && <UpdateDialog install={inst} target={{ scope: 'personal' }} onClose={() => setReview(false)} />}
    </li>
  );
}

function ConsentRow({ c, onError }) {
  const { manifest } = useManifest(c.id);
  const server = useServerMeta(c.sid);
  const revoke = () => revokeConsent(c.sid, c.id).catch((x) => onError(errText(x)));
  return (
    <li className="ad-row wrap">
      <AddonIcon icon={manifest?.icon} />
      <div className="ad-row-main">
        <span className="ad-row-name">
          {manifest?.name || 'Add-on'} <span className="muted">on {server.name || 'a server'}</span>
        </span>
        <span className="ad-row-chips"><PermChips perms={c.perms} /></span>
        {c.perms.includes('send') && (
          <label className="ad-check inline">
            <input type="checkbox" checked={c.auto} onChange={(e) => setConsentAutoSend(c.sid, c.id, e.target.checked).catch((x) => onError(errText(x)))} />
            <span>Send messages without asking me</span>
          </label>
        )}
      </div>
      <div className="ad-row-actions">
        <button type="button" className="btn sm" onClick={revoke}>Revoke</button>
      </div>
    </li>
  );
}

function StoredRow({ item, name, onError }) {
  const id = item.key.includes('~') ? item.key.split('~')[1] : item.key;
  const { manifest } = useManifest(name ? null : id);
  return (
    <li className="ad-row">
      <div className="ad-row-main">
        <span className="ad-row-name">
          {name || manifest?.name || 'Removed add-on'} {item.key.includes('~') && <span className="muted">(server add-on)</span>}
        </span>
        <span className="muted ad-hint">about {formatBytes(item.size)}</span>
      </div>
      <ConfirmButton confirmLabel="Delete this data?" onConfirm={() => clearStorage(item.key).catch((x) => onError(errText(x)))}>
        Clear
      </ConfirmButton>
    </li>
  );
}

// Settings → Add-ons: what you own, what is equipped, editor add-on toggles, wallet summary.
import { useMemo, useState } from 'react';
import { KIND_PLURAL, SLOTS } from '../../lib/addons/registry.js';
import { equip, toggleExt, unequipAll, useCatalog, useEquipped, useInventory } from '../../lib/shop.js';
import { useToast } from '../layout/ui.jsx';
import ItemPreview from './ItemPreview.jsx';
import { WalletBar } from './Wallet.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const SLOT_HINT = {
  theme: 'Recolors the whole app for you.',
  editorTheme: 'Colors the collaborative code editor for you.',
  badge: 'Shown next to your name for everyone.',
  nameColor: 'Colors your display name for everyone.',
};

/**
 * Props: { me: {uid, name?}, onOpenShop?() }
 */
export default function AddonsTab({ me, onOpenShop }) {
  const uid = me?.uid;
  const toast = useToast();
  const { byId, loading: catLoading } = useCatalog();
  const { inventory, loading: invLoading } = useInventory(uid);
  const { equipped } = useEquipped(uid);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const owned = useMemo(() => {
    const out = { theme: [], editorTheme: [], editorExt: [], badge: [], nameColor: [], missing: [] };
    for (const id of Object.keys(inventory)) {
      const item = byId[id];
      if (!item) out.missing.push(id);
      else out[item.kind].push(item);
    }
    for (const k of Object.keys(out)) if (k !== 'missing') out[k].sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [inventory, byId]);

  const run = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
      toast(errText(e), 'error');
    } finally {
      setBusy('');
    }
  };

  const loading = catLoading || invLoading;
  const total = Object.keys(inventory).length;
  const anyEquipped = SLOTS.some((s) => typeof equipped[s] === 'string') || Object.keys(equipped.ext || {}).length > 0;

  return (
    <div className="shop-tab">
      <div className="shop-tab-card">
        <div className="shop-tab-row">
          <div>
            <h3>Wallet</h3>
            <p className="muted">Claim free coins once a day and spend them in the shop. No real money, ever.</p>
          </div>
          {onOpenShop && <button className="btn sm" onClick={onOpenShop}>Open shop</button>}
        </div>
        <WalletBar uid={uid} compact />
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <div className="shop-empty small"><span className="spinner" /></div>
      ) : total === 0 ? (
        <div className="shop-tab-card">
          <h3>No add-ons yet</h3>
          <p className="muted">Grab a free editor theme or badge from the shop to get started.</p>
        </div>
      ) : (
        <>
          {SLOTS.map((slot) => (
            <div key={slot} className="shop-tab-card">
              <div className="shop-tab-row">
                <div>
                  <h3>{KIND_PLURAL[slot]}</h3>
                  <p className="muted">{SLOT_HINT[slot]}</p>
                </div>
              </div>
              {owned[slot].length === 0 ? (
                <p className="muted shop-tab-none">None owned.</p>
              ) : (
                <div className="shop-owned-list" role="radiogroup" aria-label={KIND_PLURAL[slot]}>
                  <label className={`shop-owned ${!equipped[slot] ? 'on' : ''}`}>
                    <input
                      type="radio"
                      name={`shop-slot-${slot}`}
                      checked={!equipped[slot]}
                      disabled={!!busy}
                      onChange={() => run(slot, () => equip(uid, slot, null))}
                    />
                    <span className="shop-owned-thumb default">Aa</span>
                    <span className="shop-owned-name">Default</span>
                  </label>
                  {owned[slot].map((item) => (
                    <label key={item.id} className={`shop-owned ${equipped[slot] === item.id ? 'on' : ''} ${item.supported ? '' : 'disabled'}`}>
                      <input
                        type="radio"
                        name={`shop-slot-${slot}`}
                        checked={equipped[slot] === item.id}
                        disabled={!!busy || !item.supported}
                        onChange={() => run(slot, () => equip(uid, slot, item.id))}
                      />
                      <span className="shop-owned-thumb"><ItemPreview item={item} me={me} /></span>
                      <span className="shop-owned-name">
                        {item.name}
                        {!item.supported && <span className="muted"> (unavailable)</span>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="shop-tab-card">
            <div className="shop-tab-row">
              <div>
                <h3>{KIND_PLURAL.editorExt}</h3>
                <p className="muted">Toggle extras for the code editor. Changes apply to open editors immediately.</p>
              </div>
            </div>
            {owned.editorExt.length === 0 ? (
              <p className="muted shop-tab-none">None owned.</p>
            ) : (
              <div className="shop-toggle-list">
                {owned.editorExt.map((item) => {
                  const on = equipped.ext?.[item.id] === true;
                  return (
                    <label key={item.id} className={`shop-toggle ${item.supported ? '' : 'disabled'}`}>
                      <span className="shop-toggle-text">
                        <strong>{item.name}</strong>
                        <span className="muted">{item.supported ? item.desc : 'Not available in this version'}</span>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        className="shop-switch"
                        checked={on}
                        disabled={busy === item.id || !item.supported}
                        onChange={(e) => run(item.id, () => toggleExt(uid, item.id, e.target.checked))}
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {owned.missing.length > 0 && (
            <p className="muted shop-tab-note">
              {owned.missing.length} owned item{owned.missing.length === 1 ? ' was' : 's were'} removed from the catalog and no longer apply.
            </p>
          )}

          <div className="shop-tab-card shop-tab-row">
            <div>
              <h3>Reset look</h3>
              <p className="muted">Unequip everything and go back to the default theme. You keep everything you own.</p>
            </div>
            <button className="btn sm" disabled={!!busy || !anyEquipped} onClick={() => run('reset', () => unequipAll(uid))}>
              Reset to default
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// The add-on shop: wallet header with daily claim + countdown, catalog grid filterable by kind,
// Buy / Get / Equip / Unequip. Coins are free and have no real-money value. Everything here is
// plaintext by design (see src/lib/shop.js).
import { useEffect, useMemo, useState } from 'react';
import { KINDS, KIND_LABELS, KIND_PLURAL, slotForKind } from '../../lib/addons/registry.js';
import {
  DAILY_COINS,
  buy,
  claimDaily,
  equip,
  formatCountdown,
  msUntilClaim,
  serverNow,
  toggleExt,
  useCatalog,
  useEquipped,
  useInventory,
  useWallet,
} from '../../lib/shop.js';
import { ConfirmButton, Icon, useToast } from '../layout/ui.jsx';
import ReportButton from '../admin/ReportButton.jsx'; // WS6 agreed export (spec 0.8)
import ItemPreview from './ItemPreview.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

export function Coin({ size = 14 }) {
  return <span className="shop-coin" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Price({ price }) {
  if (price === 0) return <span className="shop-price free">Free</span>;
  return (
    <span className="shop-price">
      <Coin size={13} />
      {price.toLocaleString()}
    </span>
  );
}

/** Re-renders every `ms` while `active`; returns the server-corrected clock. */
function useServerClock(active, ms = 1000) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (!active) return undefined;
    setNow(serverNow());
    const t = setInterval(() => setNow(serverNow()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** Wallet balance + daily claim with countdown. Props: { uid, compact? } */
export function WalletBar({ uid, compact = false }) {
  const toast = useToast();
  const { wallet, loading } = useWallet(uid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = wallet ? msUntilClaim(wallet) > 0 : false;
  const now = useServerClock(pending);
  const wait = wallet ? msUntilClaim(wallet, now) : 0;

  const claim = async () => {
    setBusy(true);
    setError('');
    try {
      const bal = await claimDaily(uid);
      toast(`+${DAILY_COINS} coins. Balance: ${bal.toLocaleString()}`, 'success');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`shop-wallet ${compact ? 'compact' : ''}`}>
      <div className="shop-wallet-balance" aria-live="polite">
        <Coin size={compact ? 16 : 20} />
        <strong>{loading ? '…' : (wallet?.balance ?? 0).toLocaleString()}</strong>
        <span className="muted">coins</span>
      </div>
      <div className="shop-wallet-claim">
        <button className="btn primary sm" onClick={claim} disabled={busy || loading || wait > 0}>
          {busy ? <span className="spinner shop-spinner-sm" /> : wait > 0 ? <>Next claim in {formatCountdown(wait)}</> : wallet ? `Claim daily coins (+${DAILY_COINS})` : `Claim ${DAILY_COINS} starter coins`}
        </button>
        {error && <span className="error-text shop-wallet-error">{error}</span>}
      </div>
    </div>
  );
}

function ItemCard({ item, me, owned, equippedOn, wallet, onBuy, onEquip, busy }) {
  const isExt = item.kind === 'editorExt';
  const short = item.price > 0 && (!wallet || wallet.balance < item.price);

  let action;
  if (!item.supported) {
    action = <span className="shop-tag muted">Unavailable</span>;
  } else if (owned) {
    action = (
      <button className={`btn sm ${equippedOn ? '' : 'primary'}`} disabled={busy} onClick={() => onEquip(item, !equippedOn)}>
        {busy ? <span className="spinner shop-spinner-sm" /> : isExt ? (equippedOn ? 'Disable' : 'Enable') : equippedOn ? 'Unequip' : 'Equip'}
      </button>
    );
  } else if (!item.active) {
    action = <span className="shop-tag muted">Retired</span>;
  } else if (item.price === 0) {
    action = (
      <button className="btn primary sm" disabled={busy} onClick={() => onBuy(item)}>
        {busy ? <span className="spinner shop-spinner-sm" /> : 'Get'}
      </button>
    );
  } else {
    action = (
      <ConfirmButton
        className="btn primary sm"
        confirmLabel={`Pay ${item.price.toLocaleString()}?`}
        disabled={busy || short}
        onConfirm={() => onBuy(item)}
      >
        Buy
      </ConfirmButton>
    );
  }

  return (
    <article className={`shop-card ${owned ? 'owned' : ''} ${equippedOn ? 'equipped' : ''}`}>
      <div className="shop-card-preview">
        <ItemPreview item={item} me={me} />
        {equippedOn && <span className="shop-card-flag on"><Icon name="check" size={12} stroke={2.4} /> {isExt ? 'Enabled' : 'Equipped'}</span>}
        {owned && !equippedOn && <span className="shop-card-flag">Owned</span>}
      </div>
      <div className="shop-card-body">
        <div className="shop-card-head">
          <h3 className="shop-card-name" title={item.name}>{item.name}</h3>
          {!owned && <Price price={item.price} />}
        </div>
        {item.desc && <p className="shop-card-desc">{item.desc}</p>}
        <div className="shop-card-foot">
          <span className="shop-card-kind">
            {KIND_LABELS[item.kind]}
            <ReportButton kind="shopItem" target={item.id} iconOnly label="Report item" className="btn ghost sm shop-report-btn" />
          </span>
          <div className="shop-card-actions">
            {!owned && short && item.supported && item.active && (
              <span className="shop-need">{wallet ? `Need ${(item.price - wallet.balance).toLocaleString()} more` : 'Claim coins first'}</span>
            )}
            {action}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * Props: { me: {uid, name, ...}, onClose?(), onMenu?() (mobile nav button) }
 */
export default function ShopView({ me, onClose, onMenu }) {
  const uid = me?.uid;
  const toast = useToast();
  const { items, loading, error } = useCatalog();
  const { wallet } = useWallet(uid);
  const { inventory } = useInventory(uid);
  const { equipped } = useEquipped(uid);
  const [kind, setKind] = useState('all');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);

  const isOwned = (id) => Object.prototype.hasOwnProperty.call(inventory, id);
  const isOn = (item) =>
    item.kind === 'editorExt' ? equipped.ext?.[item.id] === true : equipped[slotForKind(item.kind)] === item.id;

  // Inactive items stay listed only for people who own them.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (i.active || isOwned(i.id)) &&
        (kind === 'all' || i.kind === kind) &&
        (!ownedOnly || isOwned(i.id)) &&
        (!q || i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)),
    );
  }, [items, inventory, kind, ownedOnly, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { all: 0 };
    for (const i of items) {
      if (!i.active && !isOwned(i.id)) continue;
      c.all += 1;
      c[i.kind] = (c[i.kind] || 0) + 1;
    }
    return c;
  }, [items, inventory]); // eslint-disable-line react-hooks/exhaustive-deps

  const sections = useMemo(
    () => KINDS.map((k) => ({ kind: k, list: visible.filter((i) => i.kind === k) })).filter((s) => s.list.length),
    [visible],
  );

  const run = async (item, fn, okMsg) => {
    setBusyId(item.id);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const onBuy = (item) =>
    run(item, () => buy(uid, item), item.price === 0 ? `Added ${item.name} to your add-ons` : `Bought ${item.name}. Equip it any time`);

  const onEquip = (item, on) =>
    run(item, () =>
      item.kind === 'editorExt' ? toggleExt(uid, item.id, on) : equip(uid, slotForKind(item.kind), on ? item.id : null),
    );

  return (
    <section className="shop-view" aria-label="Add-on shop">
      <header className="shop-head">
        {onMenu && (
          <button className="btn ghost sm shop-icon-btn" onClick={onMenu} aria-label="Open navigation">
            <Icon name="menu" size={18} />
          </button>
        )}
        <div className="shop-head-title">
          <h2>Add-on shop</h2>
          <span className="muted">Themes, editor add-ons and cosmetics. Coins are free and have no real-money value.</span>
        </div>
        <WalletBar uid={uid} />
        {onClose && (
          <button className="btn ghost sm shop-icon-btn" onClick={onClose} aria-label="Close shop">
            <Icon name="x" size={18} />
          </button>
        )}
      </header>

      <div className="shop-toolbar">
        <div className="shop-chips" role="tablist" aria-label="Filter by kind">
          {['all', ...KINDS].map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={`shop-chip ${kind === k ? 'on' : ''}`}
              onClick={() => setKind(k)}
            >
              {k === 'all' ? 'All' : KIND_PLURAL[k]}
              <span className="shop-chip-count">{counts[k] || 0}</span>
            </button>
          ))}
        </div>
        <div className="shop-toolbar-right">
          <label className="shop-check">
            <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} />
            Owned only
          </label>
          <div className="shop-search">
            <Icon name="search" size={15} />
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search add-ons" aria-label="Search add-ons" />
          </div>
        </div>
      </div>

      <div className="shop-scroll">
        {loading ? (
          <div className="shop-empty"><span className="spinner" /></div>
        ) : error ? (
          <div className="shop-empty">
            <h3>Couldn't load the shop</h3>
            <p className="muted">{errText(error)}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="shop-empty">
            <div className="shop-empty-icon"><Coin size={30} /></div>
            <h3>The shop is empty</h3>
            <p className="muted">An app admin can stock it from Admin panel → Shop catalog → Seed defaults.</p>
          </div>
        ) : sections.length === 0 ? (
          <div className="shop-empty">
            <h3>Nothing matches</h3>
            <p className="muted">Try another filter.</p>
          </div>
        ) : (
          sections.map((s) => (
            <section key={s.kind} className="shop-section">
              {kind === 'all' && <h3 className="shop-section-title">{KIND_PLURAL[s.kind]}</h3>}
              <div className="shop-grid">
                {s.list.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    me={me}
                    owned={isOwned(item.id)}
                    equippedOn={isOn(item)}
                    wallet={wallet}
                    busy={busyId === item.id}
                    onBuy={onBuy}
                    onEquip={onEquip}
                  />
                ))}
              </div>
            </section>
          ))
        )}
        <p className="shop-footnote muted">
          Purchases are final: no refunds or transfers. Your wallet, inventory and equipped cosmetics are stored unencrypted;
          equipped badges and name colors are visible to other signed-in users.
        </p>
      </div>
    </section>
  );
}

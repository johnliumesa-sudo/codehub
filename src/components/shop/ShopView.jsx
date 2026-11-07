// The add-on shop: wallet header with daily claim + countdown and three tabs:
//  - Browse: official and community items (filter by kind or creator, search, sort), Buy / Get / Equip,
//    report, and quick take-down / delete for app admins;
//  - My items: create, edit, switch off and delete your own community items, with sales counts;
//  - Earnings: coins buyers paid for your items, collected one sale at a time.
// Coins are free and have no real-money value. Everything here is plaintext by design (see src/lib/shop.js).
import { useMemo, useRef, useState } from 'react';
import { KINDS, KIND_LABELS, KIND_PLURAL, slotForKind } from '../../lib/addons/registry.js';
import {
  buy,
  deleteItem,
  equip,
  setItemActive,
  toggleExt,
  useCatalog,
  useEarnings,
  useEquipped,
  useInventory,
  useWallet,
} from '../../lib/shop.js';
import { useIsAppAdmin } from '../../lib/admin.js';
import { useProfiles } from '../../lib/profiles.js';
import { ConfirmButton, Icon, useToast } from '../layout/ui.jsx';
import ReportButton from '../admin/ReportButton.jsx'; // WS6 agreed export (spec 0.8)
import ItemPreview from './ItemPreview.jsx';
import MyItems from './MyItems.jsx';
import Earnings from './Earnings.jsx';
import { Coin, Price, WalletBar } from './Wallet.jsx';
import { usePremium } from '../../features/premium/lib/status.js';
import { DiamondIcon } from '../../features/premium/components/PremiumBits.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

export { Coin, Price, WalletBar };

export const SORTS = [
  ['featured', 'Featured'],
  ['newest', 'Newest'],
  ['priceAsc', 'Price: low to high'],
  ['priceDesc', 'Price: high to low'],
];

/** Sort a filtered item list. 'featured' keeps the catalog order (kind, price, name). */
export function sortItems(list, sort) {
  const out = [...list];
  if (sort === 'newest') out.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
  else if (sort === 'priceAsc') out.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  else if (sort === 'priceDesc') out.sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));
  return out;
}

const nameOf = (profiles, uid) => profiles[uid]?.name || 'a member';

function ItemCard({ item, me, owned, equippedOn, wallet, onBuy, onEquip, busy, creatorName, onCreator, isAdmin, onModerate, premium }) {
  const isExt = item.kind === 'editorExt';
  const mine = !!item.by && item.by === me?.uid;
  const short = item.price > 0 && (!wallet || wallet.balance < item.price);
  const membersOnly = !!item.premium && !premium;

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
    action = <span className="shop-tag muted">{item.heldByAdmin ? 'Taken down' : 'Retired'}</span>;
  } else if (membersOnly) {
    action = <span className="shop-tag muted" title="Redeem a premium code in Settings → Premium">Premium only</span>;
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
        confirmLabel={mine ? `Pay ${item.price.toLocaleString()}? (no earnings)` : `Pay ${item.price.toLocaleString()}?`}
        disabled={busy || short}
        onConfirm={() => onBuy(item)}
      >
        Buy
      </ConfirmButton>
    );
  }

  return (
    <article className={`shop-card ${owned ? 'owned' : ''} ${equippedOn ? 'equipped' : ''}`} aria-label={item.name}>
      <div className="shop-card-preview">
        <ItemPreview item={item} me={me} />
        {equippedOn && <span className="shop-card-flag on"><Icon name="check" size={12} stroke={2.4} /> {isExt ? 'Enabled' : 'Equipped'}</span>}
        {owned && !equippedOn && <span className="shop-card-flag">Owned</span>}
        {mine && !owned && <span className="shop-card-flag">Yours</span>}
      </div>
      <div className="shop-card-body">
        <div className="shop-card-head">
          <h3 className="shop-card-name" title={item.name}>{item.name}</h3>
          {!owned && <Price price={item.price} />}
        </div>
        {item.desc && <p className="shop-card-desc">{item.desc}</p>}
        <div className="shop-card-by">
          {item.by ? (
            <button type="button" className="shop-by-link" onClick={() => onCreator(item.by)} title={`Show every item by ${mine ? 'you' : creatorName}`}>
              by {mine ? 'you' : creatorName}
            </button>
          ) : (
            <span className="shop-tag official">Official</span>
          )}
          {item.premium && <span className="shop-tag shop-tag-premium" title="Only premium members can buy this item"><DiamondIcon size={11} /> Premium</span>}
        </div>
        <div className="shop-card-foot">
          <span className="shop-card-kind">
            {KIND_LABELS[item.kind]}
            <ReportButton kind="shopItem" target={item.id} iconOnly label="Report item" className="btn ghost sm shop-report-btn" />
          </span>
          <div className="shop-card-actions">
            {!owned && short && item.supported && item.active && !membersOnly && (
              <span className="shop-need">{wallet ? `Need ${(item.price - wallet.balance).toLocaleString()} more` : 'Claim coins first'}</span>
            )}
            {action}
          </div>
        </div>
        {isAdmin && item.by && (
          <div className="shop-card-admin" role="group" aria-label={`Admin actions for ${item.name}`}>
            <span className="muted">Admin</span>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onModerate(item, item.active ? 'off' : 'on')}>
              {item.active ? 'Take down' : 'Restore'}
            </button>
            <ConfirmButton confirmLabel="Delete for everyone?" disabled={busy} onConfirm={() => onModerate(item, 'delete')}>
              Delete
            </ConfirmButton>
          </div>
        )}
      </div>
    </article>
  );
}

const TABS = [
  ['browse', 'Browse'],
  ['mine', 'My items'],
  ['earnings', 'Earnings'],
];

/**
 * Props: { me: {uid, name, ...}, onClose?(), onMenu?() (mobile nav button) }
 */
export default function ShopView({ me, onClose, onMenu }) {
  const uid = me?.uid;
  const toast = useToast();
  const isAdmin = useIsAppAdmin();
  const { items, byId, loading, error } = useCatalog();
  const { wallet } = useWallet(uid);
  const { active: premium } = usePremium(uid);
  const { inventory } = useInventory(uid);
  const { equipped } = useEquipped(uid);
  const { entries: earnings, total: earned } = useEarnings(uid);
  const [tab, setTab] = useState('browse');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('featured');
  const [creator, setCreator] = useState(null);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);
  const tabRefs = useRef({});

  const isOwned = (id) => Object.prototype.hasOwnProperty.call(inventory, id);
  const isOn = (item) =>
    item.kind === 'editorExt' ? equipped.ext?.[item.id] === true : equipped[slotForKind(item.kind)] === item.id;

  const creators = useMemo(() => [...new Set(items.map((i) => i.by).filter(Boolean))], [items]);
  const profiles = useProfiles(creators);
  const myCount = useMemo(() => items.filter((i) => i.by === uid).length, [items, uid]);

  // Inactive items, and items whose creator deleted their account (nobody could ever collect the coins),
  // stay listed only for people who own them.
  const listed = (i) => isOwned(i.id) || (i.active && !(i.by && profiles[i.by]?.deleted));
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        listed(i) &&
        (kind === 'all' || i.kind === kind) &&
        (!creator || i.by === creator) &&
        (!ownedOnly || isOwned(i.id)) &&
        (!q ||
          i.name.toLowerCase().includes(q) ||
          i.desc.toLowerCase().includes(q) ||
          (i.by && (profiles[i.by]?.name || '').toLowerCase().includes(q))),
    );
  }, [items, inventory, kind, creator, ownedOnly, query, profiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { all: 0 };
    for (const i of items) {
      if (!listed(i) || (creator && i.by !== creator)) continue;
      c.all += 1;
      c[i.kind] = (c[i.kind] || 0) + 1;
    }
    return c;
  }, [items, inventory, creator, profiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const sections = useMemo(() => {
    if (sort !== 'featured') return [{ kind: null, list: sortItems(visible, sort) }];
    return KINDS.map((k) => ({ kind: k, list: visible.filter((i) => i.kind === k) })).filter((s) => s.list.length);
  }, [visible, sort]);

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

  const onModerate = (item, action) =>
    run(
      item,
      () => (action === 'delete' ? deleteItem(item.id) : setItemActive(item.id, action === 'on')),
      action === 'delete' ? `Deleted ${item.name}` : action === 'on' ? `Restored ${item.name}` : `Took down ${item.name}. Only an admin can restore it`,
    );

  const pickCreator = (by) => {
    setCreator(by);
    setTab('browse');
  };

  const onTabKey = (e) => {
    const i = TABS.findIndex(([id]) => id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length
      : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? TABS.length - 1
            : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next][0]);
    tabRefs.current[TABS[next][0]]?.focus();
  };

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
          <span className="muted">Themes, editor add-ons and cosmetics by Codehub and by members. Coins are free and have no real-money value.</span>
        </div>
        <WalletBar uid={uid} />
        {onClose && (
          <button className="btn ghost sm shop-icon-btn" onClick={onClose} aria-label="Close shop">
            <Icon name="x" size={18} />
          </button>
        )}
      </header>

      <div className="shop-tabs" role="tablist" aria-label="Shop sections" onKeyDown={onTabKey}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            ref={(el) => { tabRefs.current[id] = el; }}
            type="button"
            role="tab"
            id={`shop-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`shop-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`shop-tab-btn ${tab === id ? 'on' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'mine' && myCount > 0 && <span className="shop-chip-count">{myCount}</span>}
            {id === 'earnings' && earned > 0 && (
              <span className="shop-tab-earned">
                <Coin size={11} />
                {earned.toLocaleString()}
                <span className="shop-sr-only"> coins to collect</span>
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'browse' && (
        <div className="shop-panel" role="tabpanel" id="shop-panel-browse" aria-labelledby="shop-tab-browse">
          <div className="shop-toolbar">
            <div className="shop-chips" role="group" aria-label="Filter by kind">
              {['all', ...KINDS].map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} className={`shop-chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
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
              <select className="input shop-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort items">
                {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <div className="shop-search">
                <Icon name="search" size={15} />
                <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search items or creators" aria-label="Search items or creators" />
              </div>
            </div>
          </div>
          {creator && (
            <div className="shop-filter-bar" role="status">
              <span>
                Items by <strong>{creator === uid ? 'you' : nameOf(profiles, creator)}</strong>
              </span>
              <button type="button" className="btn ghost sm" onClick={() => setCreator(null)}>
                <Icon name="x" size={14} /> Show everyone's
              </button>
            </div>
          )}

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
                <p className="muted">Be the first: publish a theme, badge or name color from <strong>My items</strong>.</p>
                <button type="button" className="btn primary sm" onClick={() => setTab('mine')}>Create an item</button>
              </div>
            ) : sections.length === 0 ? (
              <div className="shop-empty">
                <h3>Nothing matches</h3>
                <p className="muted">Try another filter.</p>
              </div>
            ) : (
              sections.map((s) => (
                <section key={s.kind || 'all'} className="shop-section" aria-label={s.kind ? KIND_PLURAL[s.kind] : 'Items'}>
                  {s.kind && kind === 'all' && <h3 className="shop-section-title">{KIND_PLURAL[s.kind]}</h3>}
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
                        creatorName={nameOf(profiles, item.by)}
                        onCreator={pickCreator}
                        isAdmin={isAdmin}
                        onModerate={onModerate}
                        premium={premium}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
            <p className="shop-footnote muted">
              Purchases are final: no refunds or transfers. When you buy a member's item, the coins you pay go to its creator, who
              can see that you bought it. Your wallet, inventory and equipped cosmetics are stored unencrypted; equipped badges and
              name colors are visible to other signed-in users.
            </p>
          </div>
        </div>
      )}

      {tab === 'mine' && (
        <div className="shop-panel" role="tabpanel" id="shop-panel-mine" aria-labelledby="shop-tab-mine">
          <div className="shop-scroll">
            <MyItems me={me} items={items} earnings={earnings} onShowInShop={() => pickCreator(uid)} />
          </div>
        </div>
      )}

      {tab === 'earnings' && (
        <div className="shop-panel" role="tabpanel" id="shop-panel-earnings" aria-labelledby="shop-tab-earnings">
          <div className="shop-scroll">
            <Earnings me={me} byId={byId} wallet={wallet} />
          </div>
        </div>
      )}
    </section>
  );
}

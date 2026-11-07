// Shop → My items: the signed-in user's community items. Create (live immediately), edit, switch off or on,
// delete, with sales counts (collected sales from udata history + uncollected earnings).
import { useMemo, useState } from 'react';
import { KIND_LABELS } from '../../lib/addons/registry.js';
import {
  MAX_ITEMS_PER_CREATOR,
  createCooldownLeft,
  deleteItem,
  formatCountdown,
  setItemActive,
  useCreatorHiddenItems,
  useSalesHistory,
} from '../../lib/shop.js';
import { ConfirmButton, Icon, useToast } from '../layout/ui.jsx';
import ItemForm, { blankForm, formFromItem } from './ItemForm.jsx';
import ItemPreview from './ItemPreview.jsx';
import { Price } from './Wallet.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

function Status({ item }) {
  if (item.heldByAdmin) return <span className="shop-tag danger" title="An app admin took this item down. Only an admin can restore it; you can still delete it.">Taken down by an admin</span>;
  if (!item.active) return <span className="shop-tag">Off</span>;
  return <span className="shop-tag ok">Live</span>;
}

/** Props: { me: {uid, name}, items: [normalized catalog items], earnings: [uncollected], onShowInShop() } */
export default function MyItems({ me, items, earnings, onShowInShop }) {
  const uid = me?.uid;
  const toast = useToast();
  const history = useSalesHistory(uid);
  const hidden = useCreatorHiddenItems(uid);
  const [editing, setEditing] = useState(null); // { form, current } | null
  const [busyId, setBusyId] = useState(null);

  const mine = useMemo(
    () => items.filter((i) => i.by === uid).sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name)),
    [items, uid],
  );
  const sales = useMemo(() => {
    const out = { ...history.byItem };
    for (const e of earnings) out[e.itemId] = (out[e.itemId] || 0) + 1;
    return out;
  }, [history.byItem, earnings]);

  const total = mine.length + hidden.length;
  const atCap = total >= MAX_ITEMS_PER_CREATOR;

  const startCreate = () => {
    const wait = createCooldownLeft();
    if (wait > 0) toast(`You can publish your next item in ${formatCountdown(wait)} (one per minute)`, 'info');
    setEditing({ form: blankForm({ creator: true }), current: null });
  };

  const act = async (item, fn, okMsg) => {
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

  return (
    <div className="shop-mine">
      <div className="shop-mine-head">
        <div>
          <h3>Your items</h3>
          <p className="muted">
            Publish themes, editor themes, badges and name colors. They go live right away, and the coins buyers pay become your
            earnings. {total} of {MAX_ITEMS_PER_CREATOR} used.
          </p>
        </div>
        <div className="shop-mine-actions">
          {mine.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={onShowInShop}>See them in the shop</button>
          )}
          <button type="button" className="btn primary sm" onClick={startCreate} disabled={!!editing || atCap} title={atCap ? `You can have at most ${MAX_ITEMS_PER_CREATOR} items` : undefined}>
            <Icon name="plus" size={14} /> Create item
          </button>
        </div>
      </div>

      {editing && (
        <ItemForm
          key={editing.current?.id || 'new'}
          initial={editing.form}
          current={editing.current}
          me={me}
          mode="creator"
          onCancel={() => setEditing(null)}
          onDone={() => setEditing(null)}
        />
      )}

      {mine.length === 0 && hidden.length === 0 ? (
        !editing && (
          <div className="shop-empty small">
            <h3>You haven't published anything yet</h3>
            <p className="muted">Pick colors for a theme or an emoji for a badge, set a price, and you're selling.</p>
          </div>
        )
      ) : (
        <ul className="shop-admin-list shop-mine-list" aria-label="Your items">
          {mine.map((item) => (
            <li key={item.id} className={`shop-admin-row ${item.active ? '' : 'inactive'}`}>
              <div className="shop-admin-thumb"><ItemPreview item={item} me={me} /></div>
              <div className="shop-admin-info">
                <strong>{item.name}</strong>
                <span className="muted">
                  {KIND_LABELS[item.kind]} · {sales[item.id] || 0} sale{sales[item.id] === 1 ? '' : 's'}
                </span>
              </div>
              <Price price={item.price} />
              <Status item={item} />
              <div className="shop-admin-actions">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setEditing({ form: formFromItem(item), current: item })}
                  disabled={busyId === item.id || !!editing || item.heldByAdmin}
                  aria-label={`Edit ${item.name}`}
                  title="Edit"
                >
                  <Icon name="pencil" size={14} />
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busyId === item.id || item.heldByAdmin}
                  onClick={() => act(item, () => setItemActive(item.id, !item.active), item.active ? `${item.name} is off: nobody new can buy it` : `${item.name} is live again`)}
                >
                  {item.active ? 'Switch off' : 'Switch on'}
                </button>
                <ConfirmButton confirmLabel="Delete? Buyers lose it" disabled={busyId === item.id} onConfirm={() => act(item, () => deleteItem(item.id), `Deleted ${item.name}`)}>
                  <Icon name="trash" size={14} />
                  <span className="shop-sr-only">Delete {item.name}</span>
                </ConfirmButton>
              </div>
            </li>
          ))}
          {hidden.map((h) => (
            <li key={h.id} className="shop-admin-row inactive">
              <div className="shop-admin-thumb" aria-hidden="true" />
              <div className="shop-admin-info">
                <strong>{h.name || 'Hidden item'}</strong>
                <span className="muted">Hidden: it no longer passes the shop's content or readability checks</span>
              </div>
              <span />
              <span className="shop-tag danger">Hidden</span>
              <div className="shop-admin-actions">
                <ConfirmButton confirmLabel="Delete?" disabled={busyId === h.id} onConfirm={() => act(h, () => deleteItem(h.id), 'Deleted')}>
                  <Icon name="trash" size={14} />
                  <span className="shop-sr-only">Delete {h.name || 'hidden item'}</span>
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted shop-footnote">
        Switching an item off stops new sales; people who bought it keep it. Deleting removes it for everyone, buyers included.
        Prices and names are public, and buyers' coins reach you only as earnings you collect.
      </p>
    </div>
  );
}

// Admin panel → Shop catalog. Create / edit / deactivate / delete official items, seed the bundled
// defaults, and moderate community items (take down, restore, delete). Write access is enforced by the
// database rules (`admins/{uid}`; creators only for their own items); a non-admin just gets "permission
// denied". Items are data only: no URLs, CSS, HTML or JS can be entered.
import { useMemo, useState } from 'react';
import { KINDS, KIND_LABELS } from '../../lib/addons/registry.js';
import { deleteItem, seedDefaultCatalog, setItemActive, useCatalog } from '../../lib/shop.js';
import { useProfiles } from '../../lib/profiles.js';
import { ConfirmButton, Icon, useToast } from '../layout/ui.jsx';
import ItemForm, { blankForm, formFromItem } from './ItemForm.jsx';
import ItemPreview from './ItemPreview.jsx';
import { Price } from './Wallet.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const SOURCES = [
  ['all', 'All'],
  ['official', 'Official'],
  ['community', 'Community'],
];

/** Props: { me: {uid, name?} } */
export default function CatalogEditor({ me }) {
  const toast = useToast();
  const { items, loading, error } = useCatalog();
  const [editing, setEditing] = useState(null); // { form, current } | null
  const [overwrite, setOverwrite] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [kind, setKind] = useState('all');
  const [source, setSource] = useState('all');
  const [msg, setMsg] = useState('');

  const list = useMemo(
    () =>
      items.filter(
        (i) => (kind === 'all' || i.kind === kind) && (source === 'all' || (source === 'official' ? !i.by : !!i.by)),
      ),
    [items, kind, source],
  );
  const profiles = useProfiles(list.map((i) => i.by).filter(Boolean));

  const seed = async () => {
    setSeeding(true);
    setMsg('');
    try {
      const r = await seedDefaultCatalog({ overwrite });
      const text = `Seeded: ${r.added} added, ${r.updated} reset, ${r.skipped} kept`;
      setMsg(text);
      toast(text, 'success');
    } catch (e) {
      setMsg(errText(e));
      toast(errText(e), 'error');
    } finally {
      setSeeding(false);
    }
  };

  const act = async (id, fn) => {
    setBusyId(id);
    try {
      await fn();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="shop-admin">
      <div className="shop-admin-head">
        <div>
          <h3>Shop catalog</h3>
          <p className="muted">
            Items are plain data. Behavior comes only from modules bundled with the app, so no links, CSS, HTML or code can be
            stored. Members publish their own themes, editor themes, badges and name colors; a community item you take down
            stays down until an admin restores it. Catalog, wallets and inventory are not end-to-end encrypted.
          </p>
        </div>
        <button className="btn primary sm" onClick={() => setEditing({ form: blankForm(), current: null })} disabled={!!editing}>
          <Icon name="plus" size={14} /> New item
        </button>
      </div>

      <div className="shop-admin-seed">
        <button className="btn sm" onClick={seed} disabled={seeding}>
          {seeding ? <span className="spinner shop-spinner-sm" /> : 'Seed defaults'}
        </button>
        <label className="shop-check">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          Reset existing default items to bundled values
        </label>
        {msg && <span className="muted shop-admin-msg">{msg}</span>}
      </div>

      {editing && (
        <ItemForm
          key={editing.current?.id || 'new'}
          initial={editing.form}
          current={editing.current}
          me={me}
          mode="admin"
          onCancel={() => setEditing(null)}
          onDone={() => setEditing(null)}
        />
      )}

      <div className="shop-chips small" role="group" aria-label="Filter by source">
        {SOURCES.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={source === id} className={`shop-chip ${source === id ? 'on' : ''}`} onClick={() => setSource(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="shop-chips small" role="group" aria-label="Filter by kind">
        {['all', ...KINDS].map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} className={`shop-chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
            {k === 'all' ? 'All' : KIND_LABELS[k]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="shop-empty small"><span className="spinner" /></div>
      ) : error ? (
        <p className="error-text">{errText(error)}</p>
      ) : list.length === 0 ? (
        <p className="muted">No items here. Use <strong>Seed defaults</strong> or create one.</p>
      ) : (
        <div className="shop-admin-list">
          {list.map((item) => (
            <div key={item.id} className={`shop-admin-row ${item.active ? '' : 'inactive'}`}>
              <div className="shop-admin-thumb"><ItemPreview item={item} me={me} /></div>
              <div className="shop-admin-info">
                <strong>{item.name}</strong>
                <span className="muted">
                  {KIND_LABELS[item.kind]} · {item.by ? `by ${profiles[item.by]?.name || 'a member'}` : 'official'} · <code>{item.id}</code>
                  {!item.supported && ' · unsupported builtin (ignored)'}
                </span>
              </div>
              <Price price={item.price} />
              <span className={`shop-tag ${item.active ? 'ok' : item.heldByAdmin ? 'danger' : ''}`}>
                {item.active ? 'Active' : item.heldByAdmin ? 'Taken down' : 'Inactive'}
              </span>
              <div className="shop-admin-actions">
                <button
                  className="btn ghost sm"
                  onClick={() => setEditing({ form: formFromItem(item), current: item })}
                  disabled={busyId === item.id || !!editing}
                  title="Edit"
                  aria-label={`Edit ${item.name}`}
                >
                  <Icon name="pencil" size={14} />
                </button>
                <button className="btn sm" disabled={busyId === item.id} onClick={() => act(item.id, () => setItemActive(item.id, !item.active))}>
                  {item.active ? (item.by ? 'Take down' : 'Deactivate') : item.by ? 'Restore' : 'Activate'}
                </button>
                <ConfirmButton confirmLabel="Delete?" onConfirm={() => act(item.id, () => deleteItem(item.id))} disabled={busyId === item.id}>
                  <Icon name="trash" size={14} />
                  <span className="shop-sr-only">Delete {item.name}</span>
                </ConfirmButton>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted shop-footnote">
        Prefer <strong>Deactivate</strong> over delete: deactivated items disappear from the shop but keep working for people who
        own them. Deleted items stop applying for everyone.
      </p>
    </div>
  );
}

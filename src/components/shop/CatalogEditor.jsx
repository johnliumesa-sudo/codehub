// Admin panel → Shop catalog. Create / edit / deactivate / delete items and seed the bundled defaults.
// Write access is enforced by the database rules (`admins/{uid}` only); a non-admin just gets
// "permission denied". Items are data only: no URLs, CSS, HTML or JS can be entered.
import { useMemo, useState } from 'react';
import {
  BASE_TOKENS,
  DESC_MAX,
  EDITOR_EXT_INFO,
  EDITOR_THEME_INFO,
  GLYPH_MAX,
  HEX_RE,
  KINDS,
  KIND_LABELS,
  NAME_MAX,
  PRICE_MAX,
  TOKEN_KEYS,
  TOKEN_LABELS,
  sanitizeItemInput,
} from '../../lib/addons/registry.js';
import { deleteItem, saveItem, seedDefaultCatalog, setItemActive, useCatalog } from '../../lib/shop.js';
import { ConfirmButton, Icon, useToast } from '../layout/ui.jsx';
import ItemPreview from './ItemPreview.jsx';
import { Price } from './ShopView.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const FIRST_THEME = Object.keys(EDITOR_THEME_INFO)[0];
const FIRST_EXT = Object.keys(EDITOR_EXT_INFO)[0];

function blankForm() {
  return {
    id: null,
    name: '',
    desc: '',
    kind: 'badge',
    price: '100',
    active: true,
    tokens: { ...BASE_TOKENS },
    themeId: FIRST_THEME,
    extId: FIRST_EXT,
    glyph: '',
    color: '#5b8cff',
  };
}

function formFromItem(item) {
  const f = blankForm();
  return {
    ...f,
    id: item.id,
    name: item.name,
    desc: item.desc,
    kind: item.kind,
    price: String(item.price),
    active: item.active,
    tokens: item.kind === 'theme' ? { ...BASE_TOKENS, ...item.data.tokens } : f.tokens,
    themeId: item.kind === 'editorTheme' ? item.data.builtinId : f.themeId,
    extId: item.kind === 'editorExt' ? item.data.builtinId : f.extId,
    glyph: item.kind === 'badge' ? item.data.glyph : '',
    color: item.kind === 'nameColor' ? item.data.color : f.color,
  };
}

function dataFor(f) {
  switch (f.kind) {
    case 'theme':
      return { tokens: f.tokens };
    case 'editorTheme':
      return { builtinId: f.themeId };
    case 'editorExt':
      return { builtinId: f.extId };
    case 'badge':
      return { glyph: f.glyph };
    case 'nameColor':
      return { color: f.color };
    default:
      return {};
  }
}

function toInput(f) {
  return { name: f.name, desc: f.desc, kind: f.kind, price: f.price === '' ? NaN : Number(f.price), active: f.active, data: dataFor(f) };
}

function ColorField({ label, value, onChange }) {
  const [text, setText] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(value);
  }
  return (
    <label className="shop-color-field">
      <input
        type="color"
        value={HEX_RE.test(value) ? value.toLowerCase() : '#000000'}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        aria-label={`${label} color picker`}
      />
      <span className="shop-color-label">{label}</span>
      <input
        className="input shop-color-hex"
        value={text}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          if (HEX_RE.test(v)) onChange(v.toLowerCase());
        }}
        aria-label={`${label} hex`}
      />
    </label>
  );
}

function ItemForm({ initial, me, onDone, onCancel }) {
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  // Live validation (same function the save path uses).
  const check = useMemo(() => {
    try {
      return { item: sanitizeItemInput(toInput(f)), error: '' };
    } catch (e) {
      return { item: null, error: errText(e) };
    }
  }, [f]);

  const previewItem = check.item ? { id: f.id || 'preview', ...check.item, supported: true } : { id: 'preview', kind: f.kind, data: dataFor(f), price: 0 };

  const submit = async (e) => {
    e.preventDefault();
    if (check.error) return setError(check.error);
    setBusy(true);
    setError('');
    try {
      const id = await saveItem(f.id, toInput(f));
      toast(f.id ? 'Item saved' : 'Item created', 'success');
      onDone(id);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="shop-form" onSubmit={submit}>
      <div className="shop-form-grid">
        <div className="shop-form-fields">
          <label className="field">
            Name
            <input className="input" value={f.name} maxLength={NAME_MAX} onChange={(e) => set({ name: e.target.value })} required />
          </label>
          <label className="field">
            Description
            <textarea className="input shop-textarea" value={f.desc} maxLength={DESC_MAX} rows={3} onChange={(e) => set({ desc: e.target.value })} />
            <span className="shop-counter">{f.desc.length}/{DESC_MAX}</span>
          </label>
          <div className="shop-form-row">
            <label className="field">
              Kind
              <select className="input" value={f.kind} onChange={(e) => set({ kind: e.target.value })} disabled={!!f.id}>
                {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </label>
            <label className="field">
              Price (coins)
              <input className="input" type="number" min={0} max={PRICE_MAX} step={1} value={f.price} onChange={(e) => set({ price: e.target.value })} />
            </label>
          </div>
          <label className="shop-check">
            <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />
            Active (listed in the shop)
          </label>

          {f.kind === 'theme' && (
            <fieldset className="shop-fieldset">
              <legend>Colors</legend>
              <div className="shop-token-grid">
                {TOKEN_KEYS.map((k) => (
                  <ColorField key={k} label={TOKEN_LABELS[k]} value={f.tokens[k]} onChange={(v) => set({ tokens: { ...f.tokens, [k]: v } })} />
                ))}
              </div>
              <button type="button" className="btn ghost sm" onClick={() => set({ tokens: { ...BASE_TOKENS } })}>Reset to app defaults</button>
            </fieldset>
          )}
          {f.kind === 'editorTheme' && (
            <label className="field">
              Bundled editor theme
              <select className="input" value={f.themeId} onChange={(e) => set({ themeId: e.target.value })}>
                {Object.entries(EDITOR_THEME_INFO).map(([id, info]) => <option key={id} value={id}>{info.label} ({id})</option>)}
              </select>
            </label>
          )}
          {f.kind === 'editorExt' && (
            <label className="field">
              Bundled editor add-on
              <select className="input" value={f.extId} onChange={(e) => set({ extId: e.target.value })}>
                {Object.entries(EDITOR_EXT_INFO).map(([id, info]) => <option key={id} value={id}>{info.label} ({id})</option>)}
              </select>
            </label>
          )}
          {f.kind === 'badge' && (
            <label className="field">
              Glyph (emoji, 1–{GLYPH_MAX} characters)
              <input className="input shop-glyph-input" value={f.glyph} maxLength={GLYPH_MAX} onChange={(e) => set({ glyph: e.target.value })} />
            </label>
          )}
          {f.kind === 'nameColor' && <ColorField label="Name color" value={f.color} onChange={(v) => set({ color: v })} />}
        </div>

        <div className="shop-form-preview">
          <span className="shop-form-preview-label">Preview</span>
          <div className="shop-card preview-only">
            <div className="shop-card-preview"><ItemPreview item={previewItem} me={me} /></div>
            <div className="shop-card-body">
              <div className="shop-card-head">
                <h3 className="shop-card-name">{f.name || 'Untitled'}</h3>
                {check.item && <Price price={check.item.price} />}
              </div>
              {f.desc && <p className="shop-card-desc">{f.desc}</p>}
            </div>
          </div>
        </div>
      </div>

      {(error || check.error) && <p className="error-text">{error || check.error}</p>}
      <div className="shop-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !!check.error}>
          {busy ? <span className="spinner shop-spinner-sm" /> : f.id ? 'Save changes' : 'Create item'}
        </button>
      </div>
    </form>
  );
}

/** Props: { me: {uid, name?} } */
export default function CatalogEditor({ me }) {
  const toast = useToast();
  const { items, loading, error } = useCatalog();
  const [editing, setEditing] = useState(null); // form initial state | null
  const [overwrite, setOverwrite] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [kind, setKind] = useState('all');
  const [msg, setMsg] = useState('');

  const list = useMemo(() => (kind === 'all' ? items : items.filter((i) => i.kind === kind)), [items, kind]);

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
            stored. Catalog, wallets and inventory are not end-to-end encrypted.
          </p>
        </div>
        <button className="btn primary sm" onClick={() => setEditing(blankForm())} disabled={!!editing}>
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
          key={editing.id || 'new'}
          initial={editing}
          me={me}
          onCancel={() => setEditing(null)}
          onDone={() => setEditing(null)}
        />
      )}

      <div className="shop-chips small">
        {['all', ...KINDS].map((k) => (
          <button key={k} className={`shop-chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
            {k === 'all' ? 'All' : KIND_LABELS[k]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="shop-empty small"><span className="spinner" /></div>
      ) : error ? (
        <p className="error-text">{errText(error)}</p>
      ) : list.length === 0 ? (
        <p className="muted">No items yet. Use <strong>Seed defaults</strong> or create one.</p>
      ) : (
        <div className="shop-admin-list">
          {list.map((item) => (
            <div key={item.id} className={`shop-admin-row ${item.active ? '' : 'inactive'}`}>
              <div className="shop-admin-thumb"><ItemPreview item={item} me={me} /></div>
              <div className="shop-admin-info">
                <strong>{item.name}</strong>
                <span className="muted">
                  {KIND_LABELS[item.kind]} · <code>{item.id}</code>
                  {!item.supported && ' · unsupported builtin (ignored)'}
                </span>
              </div>
              <Price price={item.price} />
              <span className={`shop-tag ${item.active ? 'ok' : ''}`}>{item.active ? 'Active' : 'Inactive'}</span>
              <div className="shop-admin-actions">
                <button className="btn ghost sm" onClick={() => setEditing(formFromItem(item))} disabled={busyId === item.id} title="Edit">
                  <Icon name="pencil" size={14} />
                </button>
                <button className="btn sm" disabled={busyId === item.id} onClick={() => act(item.id, () => setItemActive(item.id, !item.active))}>
                  {item.active ? 'Deactivate' : 'Activate'}
                </button>
                <ConfirmButton confirmLabel="Delete?" onConfirm={() => act(item.id, () => deleteItem(item.id))} disabled={busyId === item.id}>
                  <Icon name="trash" size={14} />
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

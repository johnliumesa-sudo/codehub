// Create / edit a shop item with a live preview. Used by creators (Shop → My items, community limits:
// themes, badges, name colors and color-token editor themes) and by app admins (Admin panel → Shop
// catalog, which may also pick bundled editor themes and editor add-ons). Items are data only: the same
// sanitizeItemInput the save path runs validates every keystroke, and the rules re-check the shape.
import { useMemo, useState } from 'react';
import {
  BASE_TOKENS,
  CREATOR_KINDS,
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
import { BASE_EDITOR_TOKENS, EDITOR_TOKEN_KEYS, EDITOR_TOKEN_LABELS } from '../../lib/addons/editorPalette.js';
import { createItem, saveItem } from '../../lib/shop.js';
import { useToast } from '../layout/ui.jsx';
import ItemPreview from './ItemPreview.jsx';
import { Price } from './Wallet.jsx';
import './shop.css';

const errText = (e) => String(e?.message || e).replace(/^Error:\s*/, '');

const FIRST_THEME = Object.keys(EDITOR_THEME_INFO)[0];
const FIRST_EXT = Object.keys(EDITOR_EXT_INFO)[0];

/** Empty form. `creator` forms start on a badge with a modest price. */
export function blankForm({ creator = false } = {}) {
  return {
    id: null,
    name: '',
    desc: '',
    kind: 'badge',
    price: creator ? '50' : '100',
    active: true,
    tokens: { ...BASE_TOKENS },
    editorSource: creator ? 'tokens' : 'bundled',
    editorTokens: { ...BASE_EDITOR_TOKENS },
    themeId: FIRST_THEME,
    extId: FIRST_EXT,
    glyph: '',
    color: '#5b8cff',
    premium: false,
  };
}

/** Form state for editing `item`. */
export function formFromItem(item) {
  const f = blankForm({ creator: !!item.by });
  const tokenEditor = item.kind === 'editorTheme' && !!item.data.tokens;
  return {
    ...f,
    id: item.id,
    name: item.name,
    desc: item.desc,
    kind: item.kind,
    price: String(item.price),
    active: item.active,
    tokens: item.kind === 'theme' ? { ...BASE_TOKENS, ...item.data.tokens } : f.tokens,
    editorSource: tokenEditor ? 'tokens' : item.kind === 'editorTheme' ? 'bundled' : f.editorSource,
    editorTokens: tokenEditor ? { ...item.data.tokens } : f.editorTokens,
    themeId: item.kind === 'editorTheme' && !tokenEditor ? item.data.builtinId : f.themeId,
    extId: item.kind === 'editorExt' ? item.data.builtinId : f.extId,
    glyph: item.kind === 'badge' ? item.data.glyph : '',
    color: item.kind === 'nameColor' ? item.data.color : f.color,
    premium: !!item.premium,
  };
}

function dataFor(f) {
  switch (f.kind) {
    case 'theme':
      return { tokens: f.tokens };
    case 'editorTheme':
      return f.editorSource === 'tokens' ? { tokens: f.editorTokens } : { builtinId: f.themeId };
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
  return { name: f.name, desc: f.desc, kind: f.kind, price: f.price === '' ? NaN : Number(f.price), active: f.active, premium: f.premium, data: dataFor(f) };
}

export function ColorField({ label, value, onChange }) {
  const [text, setText] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(value);
  }
  return (
    <div className="shop-color-field">
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
        aria-invalid={!HEX_RE.test(text)}
      />
    </div>
  );
}

/**
 * Props: { initial (form state), me: {uid, name}, mode: 'admin' | 'creator', current? (the item being
 * edited), onDone(id), onCancel() }
 */
export default function ItemForm({ initial, me, mode = 'creator', current = null, onDone, onCancel }) {
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false); // live validation starts with the first edit
  const set = (patch) => {
    setTouched(true);
    setF((x) => ({ ...x, ...patch }));
  };
  const editing = !!f.id;
  // Community limits for creators and for any item that has a creator (also when an admin edits it).
  const creator = mode === 'creator' || !!current?.by;
  const kinds = creator ? CREATOR_KINDS : KINDS;

  const check = useMemo(() => {
    try {
      return { item: sanitizeItemInput(toInput(f), { creator }), error: '' };
    } catch (e) {
      return { item: null, error: errText(e) };
    }
  }, [f, creator]);

  const previewItem = check.item
    ? { id: f.id || 'preview', ...check.item, supported: true }
    : { id: 'preview', kind: f.kind, data: dataFor(f), price: 0 };

  const submit = async (e) => {
    e.preventDefault();
    if (check.error) return setError(check.error);
    setBusy(true);
    setError('');
    try {
      const id = editing ? await saveItem(f.id, toInput(f), current) : mode === 'creator' ? await createItem(me.uid, toInput(f)) : await saveItem(null, toInput(f));
      toast(editing ? 'Item saved' : mode === 'creator' ? `${check.item.name} is live in the shop` : 'Item created', 'success');
      onDone?.(id);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const formId = `shop-form-${f.id || 'new'}`;
  return (
    <form className="shop-form" onSubmit={submit} aria-labelledby={`${formId}-title`} noValidate>
      <h3 id={`${formId}-title`} className="shop-form-title">{editing ? `Edit “${initial.name}”` : mode === 'creator' ? 'Create an item' : 'New catalog item'}</h3>
      <div className="shop-form-grid">
        <div className="shop-form-fields">
          <label className="field">
            Name
            <input className="input" value={f.name} maxLength={NAME_MAX} onChange={(e) => set({ name: e.target.value })} required />
          </label>
          <label className="field">
            Description
            <textarea className="input shop-textarea" value={f.desc} maxLength={DESC_MAX} rows={3} onChange={(e) => set({ desc: e.target.value })} />
            <span className="shop-counter" aria-hidden="true">{f.desc.length}/{DESC_MAX}</span>
          </label>
          <div className="shop-form-row">
            <label className="field">
              Kind
              <select className="input" value={f.kind} onChange={(e) => set({ kind: e.target.value })} disabled={editing}>
                {kinds.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </label>
            <label className="field">
              Price (coins)
              <input className="input" type="number" inputMode="numeric" min={0} max={PRICE_MAX} step={1} value={f.price} onChange={(e) => set({ price: e.target.value })} />
            </label>
          </div>
          <label className="shop-check">
            <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />
            Active (listed in the shop)
          </label>
          <label className="shop-check">
            <input type="checkbox" checked={!!f.premium} onChange={(e) => set({ premium: e.target.checked })} />
            Premium members only (only active premium members can buy or get it)
          </label>

          {f.kind === 'theme' && (
            <fieldset className="shop-fieldset">
              <legend>App colors</legend>
              <div className="shop-token-grid">
                {TOKEN_KEYS.map((k) => (
                  <ColorField key={k} label={TOKEN_LABELS[k]} value={f.tokens[k]} onChange={(v) => set({ tokens: { ...f.tokens, [k]: v } })} />
                ))}
              </div>
              <button type="button" className="btn ghost sm" onClick={() => set({ tokens: { ...BASE_TOKENS } })}>Reset to app defaults</button>
            </fieldset>
          )}
          {f.kind === 'editorTheme' && !creator && (
            <fieldset className="shop-fieldset shop-radio-row">
              <legend>Editor theme source</legend>
              <label className="shop-check">
                <input type="radio" name={`${formId}-src`} checked={f.editorSource === 'tokens'} disabled={editing} onChange={() => set({ editorSource: 'tokens' })} />
                Custom colors
              </label>
              <label className="shop-check">
                <input type="radio" name={`${formId}-src`} checked={f.editorSource === 'bundled'} disabled={editing} onChange={() => set({ editorSource: 'bundled' })} />
                Bundled theme
              </label>
            </fieldset>
          )}
          {f.kind === 'editorTheme' && (creator || f.editorSource === 'tokens') && (
            <fieldset className="shop-fieldset">
              <legend>Editor colors</legend>
              <div className="shop-token-grid">
                {EDITOR_TOKEN_KEYS.map((k) => (
                  <ColorField
                    key={k}
                    label={EDITOR_TOKEN_LABELS[k]}
                    value={f.editorTokens[k]}
                    onChange={(v) => set({ editorTokens: { ...f.editorTokens, [k]: v } })}
                  />
                ))}
              </div>
              <button type="button" className="btn ghost sm" onClick={() => set({ editorTokens: { ...BASE_EDITOR_TOKENS } })}>Reset to One Dark</button>
            </fieldset>
          )}
          {f.kind === 'editorTheme' && !creator && f.editorSource === 'bundled' && (
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
          <span className="shop-form-preview-label" id={`${formId}-pv`}>Live preview</span>
          <div className="shop-card preview-only" role="group" aria-labelledby={`${formId}-pv`}>
            <div className="shop-card-preview"><ItemPreview item={previewItem} me={me} /></div>
            <div className="shop-card-body">
              <div className="shop-card-head">
                <h4 className="shop-card-name">{f.name || 'Untitled'}</h4>
                {check.item && <Price price={check.item.price} />}
              </div>
              {f.desc && <p className="shop-card-desc">{f.desc}</p>}
              {creator && <span className="shop-card-by muted">by {current?.by && current.by !== me?.uid ? 'its creator' : 'you'}</span>}
            </div>
          </div>
          {mode === 'creator' && !editing && (
            <p className="muted shop-form-note">
              Your item goes live as soon as you create it. Buyers pay the listed price and the coins become your earnings.
              Items are public and not encrypted.
            </p>
          )}
        </div>
      </div>

      {(error || (touched && check.error)) && <p className="error-text" role="alert">{error || check.error}</p>}
      <div className="shop-form-actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !!check.error}>
          {busy ? <span className="spinner shop-spinner-sm" /> : editing ? 'Save changes' : mode === 'creator' ? 'Publish item' : 'Create item'}
        </button>
      </div>
    </form>
  );
}

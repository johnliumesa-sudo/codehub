// Create / rename / reorder / delete categories and assign channels (manageChannels holders).
import { useState } from 'react';
import {
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME,
  createCategory,
  deleteCategory,
  moveCategory,
  renameCategory,
  setChannelCategory,
  useCategories,
} from '../../lib/serverx/categories.js';
import { ConfirmButton, Icon, Modal, useToast } from '../layout/ui.jsx';
import './serverx.css';

/** Props: { sid, channels (useChannels output, with `cat`), onClose } */
export function CategoryManager({ sid, channels, onClose }) {
  const cats = useCategories(sid);
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast?.(e?.message || 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };
  const add = (e) => {
    e.preventDefault();
    if (!name.trim() || cats.length >= MAX_CATEGORIES) return;
    run(async () => {
      await createCategory(sid, name, (cats.at(-1)?.position ?? 0) + 1);
      setName('');
    });
  };
  const swap = (i, d) => {
    const a = cats[i];
    const b = cats[i + d];
    if (!a || !b) return;
    // Distinct positions even when equal (normalise to indices).
    run(async () => {
      await Promise.all(cats.map((c, idx) => {
        const to = idx === i ? i + d : idx === i + d ? i : idx;
        return c.position === to ? null : moveCategory(sid, c.id, to);
      }));
    });
  };
  const rename = (c) => {
    const next = window.prompt('Category name', c.name);
    if (next && next.trim() && next.trim() !== c.name) run(() => renameCategory(sid, c.id, next));
  };
  return (
    <Modal title="Channel categories" onClose={onClose} wide>
      <form className="sx-row" onSubmit={add}>
        <input className="input" value={name} maxLength={MAX_CATEGORY_NAME} onChange={(e) => setName(e.target.value)} placeholder="New category name" aria-label="New category name" />
        <button className="btn primary" disabled={busy || !name.trim() || cats.length >= MAX_CATEGORIES}>Add</button>
      </form>
      {!cats.length && <p className="sx-hint">No categories yet. Channels without one appear at the top.</p>}
      <ul className="sx-list">
        {cats.map((c, i) => (
          <li key={c.id} className="sx-list-item">
            <div className="sx-row">
              <strong className="sx-grow">{c.name}</strong>
              <button className="btn ghost sm" disabled={busy || i === 0} onClick={() => swap(i, -1)} aria-label={`Move ${c.name} up`}><Icon name="chevron" size={14} className="sx-up" /></button>
              <button className="btn ghost sm" disabled={busy || i === cats.length - 1} onClick={() => swap(i, 1)} aria-label={`Move ${c.name} down`}><Icon name="chevron" size={14} /></button>
              <button className="btn ghost sm" disabled={busy} onClick={() => rename(c)} aria-label={`Rename ${c.name}`}><Icon name="pencil" size={14} /></button>
              <ConfirmButton disabled={busy} onConfirm={() => run(() => deleteCategory(sid, c.id, channels.filter((ch) => ch.cat === c.id).map((ch) => ch.cid)))}>Delete</ConfirmButton>
            </div>
          </li>
        ))}
      </ul>
      {!!cats.length && !!channels.length && (
        <>
          <h3 className="sx-h">Assign channels</h3>
          <ul className="sx-list">
            {channels.map((ch) => (
              <li key={ch.cid} className="sx-row">
                <span className="sx-grow"># {ch.name ?? '…'}</span>
                <select
                  className="input sx-select"
                  value={cats.some((c) => c.id === ch.cat) ? ch.cat : ''}
                  disabled={busy}
                  onChange={(e) => run(() => setChannelCategory(sid, ch.cid, e.target.value || null))}
                  aria-label={`Category for ${ch.name}`}
                >
                  <option value="">None</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

// Server settings tab for custom emotes (feature 8). Caller gates on can(me, roles, 'manageEmotes'); rules enforce it too.
import { useRef, useState } from 'react';
import { addEmote, deleteEmote, useEmotes } from '../../lib/media/emotes.js';
import { ConfirmButton, useToast } from '../layout/ui.jsx';
import { ACCEPT_IMAGES, EMOTE_MAX_PER_SERVER, EMOTE_NAME_RE, errMsg, isRasterImage, normalizeEmotes } from './util.js';

export function EmoteManager({ sid, canManage = true }) {
  const toast = useToast();
  const emotes = normalizeEmotes(useEmotes(sid));
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  const full = emotes.length >= EMOTE_MAX_PER_SERVER;
  const nameOk = EMOTE_NAME_RE.test(name);
  const taken = emotes.some((e) => e.name === name);

  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!isRasterImage(f)) return setError('Choose a PNG, JPEG, WebP or GIF image.');
    setError('');
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32));
  };

  const add = async (e) => {
    e.preventDefault();
    if (!file || !nameOk || taken || full) return;
    setBusy(true);
    setError('');
    try {
      await addEmote(sid, name, file);
      setFile(null);
      setName('');
      toast?.(`Added :${name}:`, 'ok');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const del = async (em) => {
    try {
      await deleteEmote(sid, em.id);
    } catch (err) {
      toast?.(errMsg(err), 'error');
    }
  };

  return (
    <div className="md-emotes">
      <h3 className="md-h">Custom emotes</h3>
      <p className="md-hint">
        {emotes.length}/{EMOTE_MAX_PER_SERVER} used. Images are resized to 128 px (max 64 KB) and encrypted with the server key. Use them as <code>:name:</code>.
      </p>
      {canManage && (
        <form className="md-emote-form" onSubmit={add}>
          <button type="button" className="btn sm" onClick={() => input.current?.click()} disabled={busy || full}>
            {file ? file.name.slice(0, 24) : 'Choose image'}
          </button>
          <input ref={input} type="file" accept={ACCEPT_IMAGES} hidden onChange={pick} />
          <input
            className="md-emote-name"
            value={name}
            maxLength={32}
            placeholder="emote_name"
            aria-label="Emote name"
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <button className="btn primary sm" disabled={busy || !file || !nameOk || taken || full}>
            {busy ? 'Adding…' : 'Add emote'}
          </button>
          {name && !nameOk && <span className="md-error">2 to 32 chars: a-z, 0-9, _</span>}
          {taken && <span className="md-error">Name already used</span>}
          {full && <span className="md-error">Emote limit reached</span>}
        </form>
      )}
      {error && <p className="md-error" role="alert">{error}</p>}
      {emotes.length === 0 ? (
        <p className="md-hint">No custom emotes yet.</p>
      ) : (
        <ul className="md-emote-list">
          {emotes.map((em) => (
            <li key={em.id} className="md-emote-row">
              <img className="md-emote-big" src={em.src} alt={`:${em.name}:`} loading="lazy" />
              <code className="md-emote-label">:{em.name}:</code>
              {canManage && <ConfirmButton onConfirm={() => del(em)}>Delete</ConfirmButton>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

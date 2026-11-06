// Admin panel form for appConfig/{giphyKey, turn}. Rules: any signed-in user reads, only admins write.
// Both values are visible to every signed-in user by nature; the form says so.
import { useEffect, useState } from 'react';
import { onValue, ref, set } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import { errMsg } from './util.js';

const MAX_TURN = 4;
const blank = () => ({ urls: '', username: '', credential: '' });

export function AdminMediaConfig() {
  const [key, setKey] = useState('');
  const [turn, setTurn] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(
    () =>
      onValue(
        ref(db, 'appConfig'),
        (s) => {
          const v = s.val() || {};
          setKey(typeof v.giphyKey === 'string' ? v.giphyKey : '');
          const t = Array.isArray(v.turn) ? v.turn : v.turn ? Object.values(v.turn) : [];
          setTurn(t.slice(0, MAX_TURN).map((x) => ({ urls: Array.isArray(x.urls) ? x.urls.join(', ') : x.urls || '', username: x.username || '', credential: x.credential || '' })));
          setLoaded(true);
        },
        () => setLoaded(true),
      ),
    [],
  );

  const patch = (i, f) => setTurn((t) => t.map((r, j) => (j === i ? { ...r, ...f } : r)));

  const save = async (e) => {
    e.preventDefault();
    setMsg(null);
    const k = key.trim();
    if (k.length > 64) return setMsg({ err: true, text: 'GIPHY key must be 64 characters or fewer.' });
    const rows = [];
    for (const r of turn) {
      const urls = r.urls.split(/[\s,]+/).filter(Boolean);
      if (!urls.length) continue;
      if (!urls.every((u) => /^(turns?|stuns?):[^\s]+$/i.test(u))) return setMsg({ err: true, text: 'TURN URLs must start with turn:, turns: or stun:.' });
      const row = { urls: urls.length === 1 ? urls[0] : urls };
      if (r.username.trim()) row.username = r.username.trim();
      if (r.credential) row.credential = r.credential;
      rows.push(row);
    }
    setBusy(true);
    try {
      const cfg = {};
      if (k) cfg.giphyKey = k;
      if (rows.length) cfg.turn = rows;
      await set(ref(db, 'appConfig'), Object.keys(cfg).length ? cfg : null);
      setMsg({ err: false, text: 'Saved.' });
    } catch (err) {
      setMsg({ err: true, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <p className="md-hint">Loading…</p>;
  return (
    <form className="md-admin" onSubmit={save}>
      <h3 className="md-h">GIFs and call relay</h3>
      <p className="md-hint">
        Both values are readable by every signed-in user (the browser needs them). Use a restricted GIPHY key and short-lived or low-privilege TURN credentials. GIPHY sees users' IP addresses and search terms. Leave the key empty to hide the GIF picker.
      </p>
      <label className="field">
        GIPHY API key
        <input value={key} maxLength={64} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div className="md-turn">
        <span className="md-sub">TURN / STUN servers ({turn.length}/{MAX_TURN})</span>
        {turn.map((r, i) => (
          <div key={i} className="md-turn-row">
            <input placeholder="turn:host:3478, turns:host:443" value={r.urls} onChange={(e) => patch(i, { urls: e.target.value })} aria-label="URLs" spellCheck={false} />
            <input placeholder="username" value={r.username} onChange={(e) => patch(i, { username: e.target.value })} aria-label="Username" autoComplete="off" />
            <input placeholder="credential" value={r.credential} onChange={(e) => patch(i, { credential: e.target.value })} aria-label="Credential" autoComplete="off" />
            <button type="button" className="btn ghost sm" onClick={() => setTurn((t) => t.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        {turn.length < MAX_TURN && (
          <button type="button" className="btn sm" onClick={() => setTurn((t) => [...t, blank()])}>Add server</button>
        )}
      </div>
      <div className="md-admin-foot">
        <button className="btn primary sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        {msg && <span className={msg.err ? 'md-error' : 'md-ok'} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}

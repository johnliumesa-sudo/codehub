// Admin panel → "Add-ons" (app admins): publish the first-party example add-ons to the directory
// and remove any published add-on.
import { useEffect, useMemo, useState } from 'react';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { EXAMPLES } from '../examples/index.js';
import { sha256Hex } from '../lib/hash.js';
import { isCurrentRuntime, validateDraft } from '../lib/manifest.js';
import { publishAddon, unpublishAddon, useDirectory, usePublishedBy } from '../lib/store.js';
import { AddonIcon, OldRuntimeChip, PermChips, Publisher, errText, fmtDate } from './bits.jsx';
import '../addons.css';

export default function AdminAddonsTab({ me }) {
  const mine = usePublishedBy(me?.uid);
  const dir = useDirectory(300);
  const [shas, setShas] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({ text: '', kind: '' });
  const [q, setQ] = useState('');

  useEffect(() => {
    let off = false;
    Promise.all(EXAMPLES.map(async (x) => [x.seed, await sha256Hex(x.code)])).then((pairs) => !off && setShas(Object.fromEntries(pairs)));
    return () => {
      off = true;
    };
  }, []);

  const seed = async (ex, existing) => {
    setBusy(ex.seed);
    setMsg({ text: '', kind: '' });
    try {
      const v = validateDraft(ex);
      if (!v.ok) throw new Error(Object.values(v.errors)[0]);
      await publishAddon(existing?.id || null, v.value, { seed: ex.seed, stamp: false }); // app admins: no publish window
      setMsg({ text: `“${ex.name}” is in the directory.`, kind: 'ok' });
    } catch (e) {
      setMsg({ text: errText(e), kind: 'error' });
    } finally {
      setBusy('');
    }
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? dir.list.filter((m) => `${m.name} ${m.desc} ${m.id}`.toLowerCase().includes(needle)) : dir.list;
  }, [dir.list, q]);

  return (
    <div className="adm-section ad-admin">
      <p className="adm-note">
        Add-ons are public apps anyone can publish; their code runs in a sandboxed worker with no network access. Removing
        one deletes its listing and code, and Codehub stops running it for everyone who installed it.
      </p>

      <h3 className="ad-h3">First-party examples</h3>
      <ul className="ad-list">
        {EXAMPLES.map((ex) => {
          const existing = mine.list.find((m) => m.seed === ex.seed);
          const current = existing && shas[ex.seed] && existing.sha === shas[ex.seed];
          return (
            <li key={ex.seed} className="ad-row wrap">
              <AddonIcon icon={ex.icon} />
              <div className="ad-row-main">
                <span className="ad-row-name">{ex.name} <span className="muted">v{ex.version}</span></span>
                <span className="ad-row-chips"><PermChips perms={ex.perms} /></span>
              </div>
              {current ? (
                <span className="ad-chip ok">Published</span>
              ) : (
                <button type="button" className="btn sm primary" disabled={!!busy || mine.loading} onClick={() => seed(ex, existing)}>
                  {busy === ex.seed ? 'Publishing…' : existing ? 'Update in directory' : 'Publish to directory'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {msg.text && <p className={msg.kind === 'error' ? 'error-text' : 'ad-ok-text'} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}

      <h3 className="ad-h3">Published add-ons ({dir.list.length})</h3>
      <input className="input" type="search" placeholder="Filter by name, description or id" aria-label="Filter add-ons" value={q} onChange={(e) => setQ(e.target.value)} />
      {dir.loading ? (
        <div className="ad-center"><div className="spinner" aria-label="Loading" /></div>
      ) : shown.length === 0 ? (
        <p className="muted">{dir.list.length ? 'No add-ons match.' : 'No add-ons published yet.'}</p>
      ) : (
        <ul className="ad-list">
          {shown.map((m) => (
            <li key={m.id} className="ad-row wrap">
              <AddonIcon icon={m.icon} />
              <div className="ad-row-main">
                <span className="ad-row-name">{m.name} <span className="muted">v{m.version}</span>{!isCurrentRuntime(m) && <OldRuntimeChip />}</span>
                <span className="muted ad-hint">by <Publisher uid={m.by} /> · {fmtDate(m.ts)} · <code className="ad-code-inline">{m.id}</code></span>
                <span className="ad-row-chips"><PermChips perms={m.perms} /></span>
              </div>
              <ConfirmButton confirmLabel="Remove for everyone?" onConfirm={() => unpublishAddon(m.id).catch((e) => setMsg({ text: errText(e), kind: 'error' }))}>
                Remove
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

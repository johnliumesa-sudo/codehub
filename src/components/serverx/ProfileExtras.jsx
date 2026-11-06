// Richer profile: editor (Settings) and read-only card (profile popovers / member list).
import { useState } from 'react';
import {
  BANNER_COLORS,
  MAX_BIO,
  MAX_LINKS,
  MAX_PRONOUNS,
  cleanExtras,
  cleanLink,
  hasExtras,
  readExtras,
  saveExtras,
} from '../../lib/serverx/profileExtras.js';
import './serverx.css';

/** Read-only. Props: { profile } (a useProfile() value). Renders nothing when empty. */
export function ProfileExtrasCard({ profile }) {
  const x = readExtras(profile);
  if (!hasExtras(x)) return null;
  return (
    <div className="sx-pcard">
      {x.banner && <div className="sx-banner" style={{ background: x.banner }} aria-hidden="true" />}
      {x.pronouns && <div className="sx-pronouns">{x.pronouns}</div>}
      {x.bio && <p className="sx-bio">{x.bio}</p>}
      {x.links?.length > 0 && (
        <ul className="sx-links">
          {x.links.map((l) => (
            <li key={l}>
              <a href={l} target="_blank" rel="noopener noreferrer nofollow ugc">{l.replace(/^https:\/\//, '').replace(/\/$/, '')}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Editor. Props: { uid, profile (current useProfile value), onSaved?(), onError?(err) } */
export function ProfileExtrasEditor({ uid, profile, onSaved, onError }) {
  const init = readExtras(profile);
  const [bio, setBio] = useState(init.bio || '');
  const [pronouns, setPronouns] = useState(init.pronouns || '');
  const [links, setLinks] = useState(() => Array.from({ length: MAX_LINKS }, (_, i) => init.links?.[i] || ''));
  const [banner, setBanner] = useState(init.banner || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const bad = links.map((l) => l.trim() && !cleanLink(l));
  const save = async (e) => {
    e.preventDefault();
    if (bad.some(Boolean)) return;
    setBusy(true);
    setSaved(false);
    try {
      await saveExtras(uid, cleanExtras({ bio, pronouns, links, banner }));
      setSaved(true);
      onSaved?.();
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="sx-editor" onSubmit={save}>
      <label className="sx-field">
        <span className="sx-label">Bio <small>{bio.length}/{MAX_BIO}</small></span>
        <textarea className="input" rows={3} maxLength={MAX_BIO} value={bio} onChange={(e) => setBio(e.target.value)} />
      </label>
      <label className="sx-field">
        <span className="sx-label">Pronouns</span>
        <input className="input" maxLength={MAX_PRONOUNS} value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="they/them" />
      </label>
      <div className="sx-field">
        <span className="sx-label">Links (https only, up to {MAX_LINKS})</span>
        {links.map((l, i) => (
          <input
            key={i}
            className={`input${bad[i] ? ' sx-bad' : ''}`}
            value={l}
            maxLength={200}
            aria-label={`Link ${i + 1}`}
            aria-invalid={!!bad[i]}
            onChange={(e) => setLinks((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
            placeholder="https://example.com"
          />
        ))}
      </div>
      <div className="sx-field">
        <span className="sx-label">Banner color</span>
        <div className="sx-swatches">
          <button type="button" className={`sx-swatch none${banner ? '' : ' on'}`} onClick={() => setBanner('')} aria-label="No banner" aria-pressed={!banner}>none</button>
          {BANNER_COLORS.map((c) => (
            <button key={c} type="button" className={`sx-swatch${banner === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setBanner(c)} aria-label={`Banner ${c}`} aria-pressed={banner === c} />
          ))}
        </div>
      </div>
      <div className="sx-row">
        <button className="btn primary" disabled={busy || bad.some(Boolean)}>{busy ? 'Saving…' : 'Save profile details'}</button>
        {saved && <span className="sx-hint" role="status">Saved</span>}
      </div>
    </form>
  );
}

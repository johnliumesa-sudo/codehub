// The public add-on directory: search, sort (newest / name), cards with permissions.
import { useMemo, useState } from 'react';
import { filterManifests } from '../lib/manifest.js';
import { useDirectory } from '../lib/store.js';
import { AddonIcon, PermChips, Publisher } from './bits.jsx';

/** Props: onOpen(id), installedIds? (Set), compact? */
export default function Directory({ onOpen, installedIds, compact = false }) {
  const { loading, error, list } = useDirectory();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('new');
  const shown = useMemo(() => filterManifests(list, q, sort), [list, q, sort]);

  return (
    <div className={`ad-directory${compact ? ' compact' : ''}`}>
      <div className="ad-dir-bar">
        <input
          className="input"
          type="search"
          placeholder="Search add-ons"
          aria-label="Search add-ons"
          data-autofocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="ad-sort">
          <span className="ad-visually-hidden">Sort by</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort add-ons">
            <option value="new">Newest</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      {loading ? (
        <div className="ad-center"><div className="spinner" aria-label="Loading the directory" /></div>
      ) : error ? (
        <p className="error-text" role="alert">Could not load the directory.</p>
      ) : shown.length === 0 ? (
        <p className="muted ad-empty-text">{list.length ? 'No add-ons match your search.' : 'No add-ons have been published yet. Be the first: create one!'}</p>
      ) : (
        <ul className="ad-cards" aria-label="Add-ons">
          {shown.map((m) => (
            <li key={m.id}>
              <button type="button" className="ad-card" onClick={() => onOpen(m.id)} aria-label={`${m.name}, version ${m.version}. View details`}>
                <AddonIcon icon={m.icon} />
                <span className="ad-card-main">
                  <span className="ad-card-name">
                    {m.name} <span className="muted">v{m.version}</span>
                    {installedIds?.has(m.id) && <span className="ad-chip ok">installed</span>}
                  </span>
                  {m.desc && <span className="ad-card-desc">{m.desc}</span>}
                  <span className="ad-card-meta">
                    <span className="muted">by <Publisher uid={m.by} /></span>
                    <span className="ad-row-chips"><PermChips perms={m.perms} /></span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

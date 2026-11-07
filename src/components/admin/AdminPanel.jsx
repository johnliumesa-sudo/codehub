import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import { useAppAdminState } from '../../lib/admin.js';
import { useProfile } from '../../lib/profiles.js';
import { deleteGame, useGames } from '../../lib/games.js'; // WS4 export (0.8)
import CatalogEditor from '../shop/CatalogEditor.jsx'; // WS3 export (0.8)
import { ConfirmButton, ErrorBoundary } from '../layout/ui.jsx';
import ReportsQueue from './ReportsQueue.jsx';
import AnnouncementEditor from './AnnouncementEditor.jsx';
import { AdminMediaConfig } from '../media/AdminMediaConfig.jsx';
import { useRegistry } from '../../lib/ext/registry.js'; // Round 3: `adminTabs` { id, label, render({ me }) }
import { ExtRender } from '../ext/ExtRender.jsx';
import './admin.css';

const TABS = [
  ['overview', 'Overview'],
  ['catalog', 'Catalog'],
  ['games', 'Games'],
  ['reports', 'Reports'],
  ['announcement', 'Announcement'],
  ['media', 'GIFs & calls'],
];

const E2EE_STATEMENT = 'Admins cannot read or decrypt private messages, servers, groups, codespaces or vaults.';

function ShieldIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

// ---------------- Overview ----------------

const COUNTS = [
  ['users', 'users', 'Users'],
  ['games', 'games', 'Published games'],
  ['catalog', 'shop/items', 'Catalog items'],
  ['reports', 'reports', 'Open reports'],
  ['badges', 'adminBadges', 'Public admin badges'],
];

function OverviewTab({ onTab }) {
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(
      COUNTS.map(([key, path]) =>
        get(ref(db, path))
          .then((s) => [key, s.exists() ? s.size : 0])
          .catch(() => [key, null]),
      ),
    );
    if (!mounted.current) return;
    setCounts(Object.fromEntries(results));
    setAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const jump = { games: 'games', catalog: 'catalog', reports: 'reports' };

  return (
    <div className="adm-section">
      <div className="adm-e2ee">
        <span className="adm-e2ee-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></svg>
        </span>
        <div>
          <strong>{E2EE_STATEMENT}</strong>
          <p className="muted">
            The database rules give app admins no access to any encrypted path, and admins never receive wrapped keys.
            Admin power covers only public plaintext: the shop catalog, games, reports, the announcement and admin badges.
          </p>
        </div>
      </div>

      <div className="adm-stats">
        {COUNTS.map(([key, , label]) => {
          const v = counts[key];
          const target = jump[key];
          const body = (
            <>
              <span className="adm-stat-n">{loading && v === undefined ? '…' : v === null || v === undefined ? '—' : v.toLocaleString()}</span>
              <span className="adm-stat-label">{label}</span>
            </>
          );
          return target ? (
            <button key={key} type="button" className="adm-stat link" onClick={() => onTab(target)}>{body}</button>
          ) : (
            <div key={key} className="adm-stat">{body}</div>
          );
        })}
      </div>
      <div className="adm-actions left">
        <button type="button" className="btn sm" disabled={loading} onClick={load}>{loading ? 'Counting…' : 'Refresh'}</button>
        {at && <span className="muted adm-small">Counted at {new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' })}</span>}
      </div>
    </div>
  );
}

// ---------------- Games ----------------

function normalizeGames(res) {
  const raw = Array.isArray(res) ? res : Array.isArray(res?.games) ? res.games : [];
  return raw
    .map((g) => ({ ...g, id: g.id || g.gameId || g.key }))
    .filter((g) => g.id);
}

function OwnerName({ uid }) {
  const p = useProfile(uid);
  return <span style={{ color: p?.color }}>{p?.name || '…'}</span>;
}

function GamesTab({ onOpenGame }) {
  const res = useGames({ sort: 'new', limit: 100 });
  const loading = !Array.isArray(res) && !!res?.loading;
  const games = useMemo(() => normalizeGames(res), [res]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return games;
    return games.filter((g) => `${g.title || ''} ${g.desc || ''} ${g.id}`.toLowerCase().includes(needle));
  }, [games, q]);

  return (
    <div className="adm-section">
      <p className="adm-note">Published games are public plaintext. Unpublishing deletes the game, its code and its likes for everyone.</p>
      <input className="input" type="search" placeholder="Filter by title, description or id" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <p className="error-text" role="alert">{err}</p>}
      {loading ? (
        <div className="adm-loading"><div className="spinner" /></div>
      ) : list.length === 0 ? (
        <div className="adm-empty"><span className="muted">{games.length ? 'No games match.' : 'No games published yet.'}</span></div>
      ) : (
        <ul className="adm-game-list">
          {list.map((g) => (
            <li key={g.id} className="adm-game">
              <div className="adm-game-main">
                <strong className="adm-game-title">{g.title || 'Untitled'}</strong>
                {g.desc && <span className="adm-game-desc muted">{g.desc}</span>}
                <span className="adm-game-meta muted">
                  by <OwnerName uid={g.ownerId} /> · {Number(g.likes) || 0} likes
                  {g.createdAt ? ` · ${new Date(g.createdAt).toLocaleDateString()}` : ''}
                  {g.size ? ` · ${Math.ceil(g.size / 1024)} KB` : ''}
                </span>
              </div>
              <div className="adm-game-actions">
                {onOpenGame && <button type="button" className="btn sm" onClick={() => onOpenGame(g.id)}>Open</button>}
                <ConfirmButton
                  confirmLabel="Unpublish?"
                  onConfirm={async () => {
                    setErr('');
                    try {
                      await deleteGame(g.id);
                    } catch (e) {
                      setErr(e?.message || 'Could not unpublish the game.');
                    }
                  }}
                >
                  Unpublish
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- Panel ----------------

/**
 * App-admin panel. Props: me ({uid, ...}), onClose(), onOpenGame?(gameId), initialTab?.
 * Renders a notice instead of the tools for non-admins (the rules would refuse them anyway).
 */
export default function AdminPanel({ me, onClose, onOpenGame, initialTab = 'overview' }) {
  const { isAdmin, loading } = useAppAdminState();
  const extTabs = useRegistry('adminTabs').filter((e) => e.label && typeof e.render === 'function' && !TABS.some(([id]) => id === e.id));
  const allTabs = [...TABS, ...extTabs.map((e) => [e.id, String(e.label)])];
  const [tab, setTab] = useState(allTabs.some(([id]) => id === initialTab) ? initialTab : 'overview');
  const extTab = extTabs.find((e) => e.id === tab);
  const boxRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement;
    boxRef.current?.querySelector('.adm-nav-item.on')?.focus?.();
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  const openGame = onOpenGame
    ? (id) => {
        onOpenGame(id);
        onClose?.();
      }
    : null;

  return (
    <div className="modal-backdrop adm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div ref={boxRef} className="modal adm-panel" role="dialog" aria-modal="true" aria-label="Admin panel">
        <nav className="adm-nav" aria-label="Admin sections">
          <div className="adm-nav-head">
            <span className="adm-nav-shield"><ShieldIcon size={20} /></span>
            <div>
              <strong>Admin panel</strong>
              <span className="muted">Codehub app admin</span>
            </div>
          </div>
          {isAdmin &&
            allTabs.map(([id, label]) => (
              <button key={id} type="button" className={`adm-nav-item${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
        </nav>
        <section className="adm-body">
          <header className="adm-head">
            <div className="adm-head-text">
              <h2>{isAdmin ? (allTabs.find(([id]) => id === tab) || TABS[0])[1] : 'Admin panel'}</h2>
              <span className="adm-head-note">{E2EE_STATEMENT}</span>
            </div>
            <button type="button" className="adm-close" onClick={onClose} aria-label="Close admin panel">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
          <div className="adm-scroll">
            {loading ? (
              <div className="adm-loading"><div className="spinner" /></div>
            ) : !isAdmin ? (
              <div className="adm-empty">
                <strong>App admins only</strong>
                <span className="muted">Redeem an admin code in Settings → Codes &amp; admin to use these tools.</span>
              </div>
            ) : (
              <ErrorBoundary resetKey={tab}>
                {tab === 'overview' && <OverviewTab onTab={setTab} />}
                {tab === 'catalog' && <CatalogEditor me={me} />}
                {tab === 'games' && <GamesTab onOpenGame={openGame} />}
                {tab === 'reports' && <ReportsQueue onOpenGame={openGame} />}
                {tab === 'announcement' && <AnnouncementEditor />}
                {tab === 'media' && <AdminMediaConfig />}
                {extTab && <ExtRender entry={extTab} args={[{ me }]} label={extTab.label} notice resetKey={extTab.id} />}
              </ErrorBoundary>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

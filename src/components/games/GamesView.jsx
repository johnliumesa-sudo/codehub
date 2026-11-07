// Arcade: browse, like and play public games.
// Props: { me, openGameId?, onOpenGameHandled? }
//   openGameId: open the player for this game right away (e.g. from the admin panel / reports
//   queue); onOpenGameHandled() is called once it has been taken.
// Games are PUBLIC PLAINTEXT by design. Nothing in a list autoplays: code is fetched on Play.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProfiles } from '../../lib/profiles.js';
import { useIsAppAdmin } from '../../lib/admin.js';
import { DESC_MAX, TITLE_MAX, coverLetter, deleteGame, updateGame, useGames } from '../../lib/games.js';
import { PYTHON_FIRST_LOAD, langLabel } from '../../lib/gameLangs/langs.js';
import ReportButton from '../admin/ReportButton.jsx';
import { Icon } from '../sandbox/icons.jsx';
import GamePlayer, { LikeButton } from './GamePlayer.jsx';
import './games.css';

const TABS = [
  ['new', 'New'],
  ['top', 'Top'],
  ['mine', 'Mine'],
];
const TAB_KEY = 'codehub.arcade.tab';

function hashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function EditGameModal({ game, me, onClose }) {
  const [title, setTitle] = useState(game.title);
  const [desc, setDesc] = useState(game.desc);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    // Capture phase + stopPropagation: Escape closes only this modal, not the player beneath it.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await updateGame({ uid: me.uid, gameId: game.id, title, desc });
      onClose();
    } catch (ex) {
      setErr(ex?.message || 'Could not save');
      setBusy(false);
    }
  };
  return createPortal(
    <div className="modal-backdrop gm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal gm-modal" role="dialog" aria-modal="true" aria-label="Edit game" onSubmit={save}>
        <div className="gm-modal-head">
          <h2>Edit game details</h2>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <label className="field">
          Title
          <input className="input" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} autoFocus dir="auto" />
        </label>
        <label className="field">
          Description
          <textarea className="input gm-textarea" value={desc} maxLength={DESC_MAX} rows={4} onChange={(e) => setDesc(e.target.value)} dir="auto" />
          <span className="gm-counter">{desc.length}/{DESC_MAX}</span>
        </label>
        <p className="muted gm-small">To change the code, open the workspace and use Publish → Update an existing game. Saving counts toward the one-publish-per-minute limit.</p>
        {err && <p className="error-text">{err}</p>}
        <div className="gm-modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function GameCard({ game, owner, me, isAdmin, onPlay, onEdit }) {
  const isOwner = game.ownerId === me.uid;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const unpublish = async () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    setErr('');
    try {
      await deleteGame(game.id);
    } catch (ex) {
      setErr(ex?.message || 'Could not unpublish');
      setBusy(false);
      setArmed(false);
    }
    return undefined;
  };

  const hue = hashHue(game.id);
  return (
    <article className="gm-card">
      <button
        type="button"
        className="gm-cover"
        style={{ '--gm-h1': hue, '--gm-h2': (hue + 50) % 360 }}
        onClick={() => onPlay(game.id)}
        aria-label={`Play ${game.title}`}
      >
        <span className="gm-cover-letter" aria-hidden="true">{coverLetter(game.title)}</span>
        <span className="gm-cover-play">
          <Icon name="play" size={18} fill="currentColor" /> Play
        </span>
      </button>
      <div className="gm-card-body">
        <h3 className="gm-card-title" title={game.title} dir="auto">{game.title}</h3>
        <div className="gm-card-meta">
          <span className="gm-owner" style={{ color: owner?.color }}>{owner?.name || '…'}</span>
          <span className="gm-dot">·</span>
          <span title={game.updatedAt && game.updatedAt !== game.createdAt ? `Updated ${new Date(game.updatedAt).toLocaleString()}` : undefined}>
            {relTime(game.createdAt)}
          </span>
          {game.lang && game.lang !== 'html' && (
            <span className={`gm-lang gm-lang-${game.lang}`} title={game.lang === 'py' ? PYTHON_FIRST_LOAD : `Written in ${langLabel(game.lang)}`}>
              {langLabel(game.lang)}
            </span>
          )}
        </div>
        {game.desc ? <p className="gm-card-desc" dir="auto">{game.desc}</p> : <p className="gm-card-desc empty">No description.</p>}
        {err && <p className="error-text gm-small">{err}</p>}
      </div>
      <footer className="gm-card-foot">
        <LikeButton game={game} me={me} compact />
        <div className="gm-card-actions">
          {!isOwner && <ReportButton kind="game" target={game.id} small iconOnly label="Report" />}
          {isOwner && (
            <button type="button" className="btn ghost sm" onClick={() => onEdit(game)} title="Edit title and description">
              <Icon name="edit" size={13} />
            </button>
          )}
          {(isOwner || isAdmin) && (
            <button
              type="button"
              className={`btn sm danger ${armed ? 'gm-armed' : ''}`}
              onClick={unpublish}
              disabled={busy}
              title={isOwner ? 'Delete this game for everyone' : 'App admin: remove this game'}
            >
              {busy ? '…' : armed ? 'Confirm' : 'Unpublish'}
            </button>
          )}
          <button type="button" className="btn primary sm" onClick={() => onPlay(game.id)}>
            <Icon name="play" size={11} fill="currentColor" /> Play
          </button>
        </div>
      </footer>
    </article>
  );
}

export default function GamesView({ me, openGameId, onOpenGameHandled, onMenu }) {
  const [tab, setTabRaw] = useState(() => {
    try {
      const t = localStorage.getItem(TAB_KEY);
      return TABS.some(([k]) => k === t) ? t : 'new';
    } catch {
      return 'new';
    }
  });
  const setTab = (t) => {
    setTabRaw(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };
  const isAdmin = useIsAppAdmin() === true;
  const { games, loading, error } = useGames(
    tab === 'mine' ? { sort: 'new', ownerId: me.uid, limit: 100 } : { sort: tab, limit: 50 },
  );
  const owners = useProfiles(games.map((g) => g.ownerId).filter(Boolean));
  const [q, setQ] = useState('');
  const [playing, setPlaying] = useState(null);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    if (openGameId) {
      setPlaying(openGameId);
      onOpenGameHandled?.();
    }
  }, [openGameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return games;
    return games.filter((g) => `${g.title} ${g.desc} ${owners[g.ownerId]?.name || ''}`.toLowerCase().includes(needle));
  }, [games, q, owners]);

  return (
    <div className="gm-root">
      <header className="gm-head">
        {onMenu && (
          <button className="btn ghost sm ly-icon-btn" onClick={onMenu} aria-label="Open navigation" data-menu-button>
            <Icon name="menu" size={18} />
          </button>
        )}
        <div className="gm-head-title">
          <span className="gm-head-icon"><Icon name="gamepad" size={20} /></span>
          <div>
            <h1>Arcade</h1>
            <p className="muted">Games people built in Codehub workspaces. Press Play to load one; nothing runs until you do.</p>
          </div>
        </div>
        <span className="gm-public-badge" title="Games, their code and likes are public plaintext. They are not end-to-end encrypted.">
          <Icon name="globe" size={12} /> Public
        </span>
      </header>

      <div className="gm-toolbar">
        <div className="gm-tabs" role="tablist" aria-label="Sort games">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <label className="gm-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Filter games" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter games" />
        </label>
      </div>

      <div className="gm-scroll">
        {error ? (
          <div className="gm-empty">
            <Icon name="alert" size={28} />
            <p>Couldn’t load games: {error}</p>
          </div>
        ) : loading ? (
          <div className="gm-empty"><span className="spinner" /></div>
        ) : list.length === 0 ? (
          <div className="gm-empty">
            <Icon name="gamepad" size={30} />
            {games.length ? (
              <p>No games match “{q}”.</p>
            ) : tab === 'mine' ? (
              <>
                <p>You haven’t published a game yet.</p>
                <p className="muted gm-small">
                  Build one in any workspace (an <code>index.html</code>, or a JavaScript, TypeScript, Python or Lua file), then press{' '}
                  <b>Publish game</b> in the editor toolbar.
                </p>
              </>
            ) : (
              <p>No games yet. Be the first: publish one from a workspace.</p>
            )}
          </div>
        ) : (
          <div className="gm-grid">
            {list.map((g) => (
              <GameCard key={g.id} game={g} owner={owners[g.ownerId]} me={me} isAdmin={isAdmin} onPlay={setPlaying} onEdit={setEditing} />
            ))}
          </div>
        )}
      </div>

      {playing && <GamePlayer key={playing} gameId={playing} me={me} onClose={() => setPlaying(null)} onEdit={(g) => setEditing(g)} />}
      {editing && <EditGameModal game={editing} me={me} onClose={() => setEditing(null)} />}
    </div>
  );
}

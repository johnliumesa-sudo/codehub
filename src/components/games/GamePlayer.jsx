// Full-screen player for one public game.
// Props: { gameId, me, onClose, onEdit? }
// The code is fetched only here, i.e. after the user pressed Play; nothing autoplays from a list.
// The game runs in SandboxFrame mode="game": opaque origin, CSP, no network, every message ignored.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProfile } from '../../lib/profiles.js';
import { useIsAppAdmin } from '../../lib/admin.js';
import { deleteGame, fetchGameCode, likeGame, unlikeGame, useGame, useGameLiked } from '../../lib/games.js';
import { formatSize } from '../../lib/sandbox.js';
import ReportButton from '../admin/ReportButton.jsx';
import SandboxFrame from '../sandbox/SandboxFrame.jsx';
import { Icon } from '../sandbox/icons.jsx';
import './games.css';

export function LikeButton({ game, me, compact = false }) {
  const liked = useGameLiked(game.id, me?.uid);
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState(null); // { liked, likes } while a write is in flight
  const [err, setErr] = useState('');
  const shownLiked = optimistic ? optimistic.liked : !!liked;
  const shownCount = optimistic ? optimistic.likes : game.likes;

  const toggle = async (e) => {
    e.stopPropagation();
    if (busy || liked === null || !me?.uid) return;
    const next = !liked;
    setBusy(true);
    setErr('');
    setOptimistic({ liked: next, likes: Math.max(0, game.likes + (next ? 1 : -1)) });
    try {
      if (next) await likeGame(game.id, me.uid);
      else await unlikeGame(game.id, me.uid);
    } catch (ex) {
      setErr(ex?.message || 'Could not update your like');
    } finally {
      setOptimistic(null);
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`gm-like ${shownLiked ? 'on' : ''} ${compact ? 'compact' : ''}`}
      onClick={toggle}
      disabled={busy || liked === null}
      aria-pressed={shownLiked}
      title={err || (shownLiked ? 'Unlike (likes are public)' : 'Like (likes are public)')}
    >
      <Icon name="heart" size={14} fill={shownLiked ? 'currentColor' : 'none'} />
      <span>{shownCount}</span>
    </button>
  );
}

export default function GamePlayer({ gameId, me, onClose, onEdit }) {
  const { game, loading } = useGame(gameId);
  const owner = useProfile(game?.ownerId || null);
  const isAdmin = useIsAppAdmin() === true;
  const isOwner = !!game && game.ownerId === me?.uid;

  const [code, setCode] = useState({ status: 'loading', html: '', error: null });
  const [run, setRun] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const stageRef = useRef(null);
  const frameRef = useRef(null);

  const load = useCallback(async () => {
    setCode({ status: 'loading', html: '', error: null });
    try {
      const html = await fetchGameCode(gameId);
      setCode({ status: 'ready', html, error: null });
    } catch (ex) {
      setCode({ status: 'error', html: '', error: ex?.message || String(ex) });
    }
  }, [gameId]);
  useEffect(() => {
    load();
  }, [load]);

  // Keyboard focus goes to the game once it's loaded (arrow keys, space…).
  useEffect(() => {
    if (code.status === 'ready') setTimeout(() => frameRef.current?.focus(), 50);
  }, [code.status, run]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  };

  const unpublish = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await deleteGame(gameId);
      onClose?.();
    } catch (ex) {
      setErr(ex?.message || 'Could not unpublish');
      setBusy(false);
    }
  };

  const gone = !loading && !game;

  return createPortal(
    <div className="gm-player-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="gm-player" role="dialog" aria-modal="true" aria-label={game ? `Playing ${game.title}` : 'Game'}>
        <header className="gm-player-head">
          <div className="gm-player-title">
            <Icon name="gamepad" size={18} />
            <div>
              <h2>{game?.title || (gone ? 'Game not found' : '…')}</h2>
              {game && (
                <span className="gm-player-sub">
                  by <b style={{ color: owner?.color }}>{owner?.name || '…'}</b>
                  {game.size ? ` · ${formatSize(game.size)}` : ''}
                </span>
              )}
            </div>
          </div>
          <div className="gm-player-actions">
            {game && <LikeButton game={game} me={me} />}
            <button className="btn sm ghost" onClick={() => setRun((n) => n + 1)} disabled={code.status !== 'ready'} title="Restart the game">
              <Icon name="refresh" size={14} /> Restart
            </button>
            <button className="btn sm ghost" onClick={fullscreen} disabled={code.status !== 'ready'} title="Full screen">
              <Icon name="expand" size={14} />
            </button>
            {game && !isOwner && <ReportButton kind="game" target={game.id} small label="Report" />}
            {isOwner && onEdit && (
              <button className="btn sm ghost" onClick={() => onEdit(game)} title="Edit title and description">
                <Icon name="edit" size={14} /> Edit
              </button>
            )}
            {game && (isOwner || isAdmin) && (
              <button className={`btn sm danger ${confirmDelete ? 'gm-armed' : ''}`} onClick={unpublish} disabled={busy}>
                {busy ? 'Removing…' : confirmDelete ? 'Click to confirm' : isOwner ? 'Unpublish' : 'Unpublish (admin)'}
              </button>
            )}
            <button className="btn sm ghost" onClick={onClose} aria-label="Close player">
              <Icon name="close" size={16} />
            </button>
          </div>
        </header>
        {game?.desc && <p className="gm-player-desc">{game.desc}</p>}
        {err && <p className="error-text gm-player-err">{err}</p>}
        <div className="gm-stage" ref={stageRef}>
          {gone ? (
            <div className="gm-stage-msg">
              <Icon name="alert" size={26} />
              <p>This game was unpublished.</p>
            </div>
          ) : code.status === 'loading' ? (
            <div className="gm-stage-msg">
              <span className="spinner" />
            </div>
          ) : code.status === 'error' ? (
            <div className="gm-stage-msg">
              <Icon name="alert" size={26} />
              <p>{code.error}</p>
              <button className="btn sm" onClick={load}>Try again</button>
            </div>
          ) : (
            <SandboxFrame key={run} ref={frameRef} html={code.html} mode="game" title={game ? `Game: ${game.title}` : 'Game'} className="gm-frame" />
          )}
        </div>
        <footer className="gm-player-foot">
          <Icon name="lock" size={11} /> Runs in a locked-down sandbox with no network and no access to your account, messages or keys.
          Treat anything you type into a game as public.
        </footer>
      </div>
    </div>,
    document.body,
  );
}

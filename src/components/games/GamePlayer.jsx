// Full-screen player for one public game.
// Props: { gameId, me, onClose, onEdit? }
// The code is fetched only here, i.e. after the user pressed Play; nothing autoplays from a list.
// The game runs in SandboxFrame profile="play" mode="game" (opaque origin, play CSP: public CDNs only).
// What it keeps in localStorage is saved per game on this device (lib/gameSaves.js), so a restart, a
// reload or the next visit continue from it. Errors and blocked loads the frame reports are shown
// as text in an error panel; keyboard focus goes to the game on load, with a hint when it's lost.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProfile } from '../../lib/profiles.js';
import { useIsAppAdmin } from '../../lib/admin.js';
import { deleteGame, fetchGameCode, likeGame, unlikeGame, useGame, useGameLiked } from '../../lib/games.js';
import { clearGameSave, loadGameSave, peekGameSave, storeGameSave } from '../../lib/gameSaves.js';
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

const MAX_ISSUES = 6;
const CDN_HELP =
  'Games can load scripts, styles and fonts only from cdn.jsdelivr.net/npm, cdnjs.cloudflare.com, unpkg.com and Google Fonts, and have no other network access.';

export default function GamePlayer({ gameId, me, onClose, onEdit }) {
  const { game, loading } = useGame(gameId);
  const owner = useProfile(game?.ownerId || null);
  const isAdmin = useIsAppAdmin() === true;
  const isOwner = !!game && game.ownerId === me?.uid;
  const uid = me?.uid || null;

  const [code, setCode] = useState({ status: 'loading', html: '', error: null });
  const [run, setRun] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [issues, setIssues] = useState([]);
  const [issuesHidden, setIssuesHidden] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [focused, setFocused] = useState(true);
  const [isFs, setIsFs] = useState(false);
  const stageRef = useRef(null);
  const frameRef = useRef(null);

  const load = useCallback(async () => {
    setCode({ status: 'loading', html: '', error: null });
    try {
      // The saved data is read before the first frame renders, so the game starts with it.
      const [html] = await Promise.all([fetchGameCode(gameId), loadGameSave(uid, gameId)]);
      setCode({ status: 'ready', html, error: null });
    } catch (ex) {
      setCode({ status: 'error', html: '', error: ex?.message || String(ex) });
    }
  }, [gameId, uid]);
  useEffect(() => {
    load();
  }, [load]);

  // localStorage/sessionStorage of this game, per account, on this device.
  const storage = useMemo(
    () => (uid ? { load: () => peekGameSave(uid, gameId), save: (area, data) => storeGameSave(uid, gameId, area, data) } : null),
    [uid, gameId],
  );

  const onRuntime = useCallback((ev) => {
    if (ev.kind === 'start') return;
    setIssues((list) => (list.length >= MAX_ISSUES || list.some((x) => x.message === ev.message) ? list : [...list, ev]));
  }, []);

  const focusGame = useCallback(() => frameRef.current?.focus(), []);

  const restart = () => {
    setIssues([]);
    setIssuesHidden(false);
    setLoaded(false);
    setRun((n) => n + 1);
  };

  // Keyboard focus goes to the game once it's loaded (arrow keys, space…), and after a restart.
  useEffect(() => {
    if (code.status === 'ready') {
      const t = setTimeout(focusGame, 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [code.status, run, focusGame]);

  // "Click to play" hint whenever keyboard focus is somewhere else.
  useEffect(() => {
    if (code.status !== 'ready') return undefined;
    const check = () => {
      const el = frameRef.current?.element;
      setFocused(!!el && document.activeElement === el && document.hasFocus());
    };
    check();
    const t = setInterval(check, 400);
    window.addEventListener('blur', check);
    window.addEventListener('focus', check);
    document.addEventListener('focusin', check);
    return () => {
      clearInterval(t);
      window.removeEventListener('blur', check);
      window.removeEventListener('focus', check);
      document.removeEventListener('focusin', check);
    };
  }, [code.status, run]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onChange = () => {
      setIsFs(!!stageRef.current && document.fullscreenElement === stageRef.current);
      setTimeout(focusGame, 60);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [focusGame]);

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
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

  const resetSave = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    setConfirmReset(false);
    await clearGameSave(uid, gameId);
    restart();
  };

  const gone = !loading && !game;
  const errors = issues.filter((x) => x.kind === 'error');
  const blocked = issues.filter((x) => x.kind === 'blocked');
  const showIssues = issues.length > 0 && !issuesHidden;

  return createPortal(
    <div className="gm-player-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="gm-player" role="dialog" aria-modal="true" aria-label={game ? `Playing ${game.title}` : 'Game'}>
        <header className="gm-player-head">
          <div className="gm-player-title">
            <Icon name="gamepad" size={18} />
            <div>
              <h2 dir="auto">{game?.title || (gone ? 'Game not found' : '…')}</h2>
              {game && (
                <span className="gm-player-sub">
                  by <b style={{ color: owner?.color }} dir="auto">{owner?.name || '…'}</b>
                  {game.size ? ` · ${formatSize(game.size)}` : ''}
                </span>
              )}
            </div>
          </div>
          <div className="gm-player-actions">
            {game && <LikeButton game={game} me={me} />}
            <button className="btn sm ghost" onClick={restart} disabled={code.status !== 'ready'} title="Restart the game (keeps its saved data)">
              <Icon name="refresh" size={14} /> Restart
            </button>
            <button
              className="btn sm ghost"
              onClick={fullscreen}
              disabled={code.status !== 'ready'}
              aria-pressed={isFs}
              aria-label={isFs ? 'Exit full screen' : 'Full screen'}
              title={isFs ? 'Exit full screen (Esc)' : 'Full screen'}
            >
              <Icon name={isFs ? 'shrink' : 'expand'} size={14} />
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
        {game?.desc && <p className="gm-player-desc" dir="auto">{game.desc}</p>}
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
            <div className="gm-stage-msg" role="alert">
              <Icon name="alert" size={26} />
              <p>Couldn’t load this game: {code.error}</p>
              <button className="btn sm" onClick={load}>Try again</button>
            </div>
          ) : (
            <>
              <SandboxFrame
                key={run}
                ref={frameRef}
                html={code.html}
                profile="play"
                mode="game"
                storage={storage}
                onRuntime={onRuntime}
                onLoad={() => {
                  setLoaded(true);
                  focusGame();
                }}
                title={game ? `Game: ${game.title}` : 'Game'}
                className="gm-frame"
              />
              {isFs && (
                <button type="button" className="gm-fs-exit" onClick={fullscreen} aria-label="Exit full screen" title="Exit full screen (Esc)">
                  <Icon name="shrink" size={16} />
                </button>
              )}
              {loaded && !focused && !showIssues && (
                <button type="button" className="gm-focus-hint" onClick={focusGame}>
                  <Icon name="keyboard" size={15} /> Click the game to play with the keyboard
                </button>
              )}
              {showIssues && (
                <div className="gm-issues" role="alert">
                  <div className="gm-issues-head">
                    <Icon name="alert" size={16} />
                    <strong>{errors.length ? 'This game stopped with an error' : 'The sandbox blocked part of this game'}</strong>
                  </div>
                  <ul className="gm-issues-list">
                    {issues.map((x, i) => (
                      <li key={i} className={x.kind}>
                        <code>{x.message}</code>
                      </li>
                    ))}
                  </ul>
                  {blocked.length > 0 && <p className="gm-small">{CDN_HELP}</p>}
                  <div className="gm-issues-actions">
                    <button type="button" className="btn sm" onClick={restart}>
                      <Icon name="refresh" size={13} /> Restart
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        setIssuesHidden(true);
                        focusGame();
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="gm-player-foot">
          <Icon name="lock" size={11} />
          <span className="gm-player-foot-text">
            Sandboxed: no access to your account, messages or keys, and no network except public code CDNs. Saved progress stays on this
            device. Treat anything you type into a game as public.
          </span>
          {uid && code.status === 'ready' && (
            <button type="button" className={`gm-foot-btn ${confirmReset ? 'armed' : ''}`} onClick={resetSave} title="Delete what this game saved on this device">
              {confirmReset ? 'Click again to clear' : 'Clear saved data'}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// Public games (Arcade). PUBLIC PLAINTEXT BY DESIGN: game metadata, game code, who liked what and
// the publish log are readable by every signed-in user. Nothing here is end-to-end encrypted.
//
// DB:
//   games/{gameId}           { ownerId, title<=80, desc<=500, createdAt, updatedAt, likes, size }
//   gameCode/{gameId}        { html <= 262144 chars }      (fetched only when someone presses Play)
//   gameLikes/{gameId}/{uid} true
//   publishLog/{uid}         ts   (rules: one publish/update per 60 s; write-only)
// Every publish/update is ONE multi-path update that also sets publishLog/{me} = serverTimestamp();
// the rules accept games/gameCode writes only when publishLog/{me} === now in the same write.
import { useEffect, useState } from 'react';
import {
  equalTo,
  get,
  limitToLast,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  serverTimestamp,
  update,
} from 'firebase/database';
import { db } from './firebase.js';
import { MAX_GAME_CHARS } from './sandbox.js';
import { deliverNotif } from './notifSend.js';
import { clearGameSaves } from './gameSaves.js';

import { DESC_MAX, PUBLISH_COOLDOWN_MS, TITLE_MAX, isDenied, publishRefusal } from './gameText.js';

export { DESC_MAX, PUBLISH_COOLDOWN_MS, TITLE_MAX, clipChars, coverLetter, titleFromHtml } from './gameText.js';
export const CODE_MAX = MAX_GAME_CHARS;

// Last successful publish from this tab (publishLog is write-only, so we can't read the server's).
let lastPublishAt = 0;

/** Milliseconds until this tab may publish again (best effort; the rules are authoritative). */
export function publishCooldownLeft() {
  return Math.max(0, lastPublishAt + PUBLISH_COOLDOWN_MS - Date.now());
}

function cleanMeta({ title, desc }) {
  const t = String(title || '').trim().replace(/\s+/g, ' ');
  const d = String(desc || '').trim();
  if (!t) throw new Error('Give your game a title');
  if (t.length > TITLE_MAX) throw new Error(`Title is too long (max ${TITLE_MAX} characters)`);
  if (d.length > DESC_MAX) throw new Error(`Description is too long (max ${DESC_MAX} characters)`);
  return { title: t, desc: d };
}

function checkHtml(html) {
  const s = String(html ?? '');
  if (!s.trim()) throw new Error('The game is empty');
  if (s.length > CODE_MAX) throw new Error(`The bundled game is ${s.length.toLocaleString()} characters; the limit is ${CODE_MAX.toLocaleString()}`);
  return s;
}

function publishError(err) {
  return publishRefusal(err, { lastAt: lastPublishAt });
}

/**
 * Publish a new public game. Returns the new gameId.
 * ONE update: games/{id} (likes 0) + gameCode/{id} + publishLog/{me}.
 */
export async function publishGame({ uid, title, desc, html }) {
  if (!uid) throw new Error('Not signed in');
  const meta = cleanMeta({ title, desc });
  const code = checkHtml(html);
  const gameId = push(ref(db, 'games')).key;
  try {
    await update(ref(db), {
      [`games/${gameId}`]: {
        ownerId: uid,
        title: meta.title,
        desc: meta.desc,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        likes: 0,
        size: code.length,
      },
      [`gameCode/${gameId}`]: { html: code },
      [`publishLog/${uid}`]: serverTimestamp(),
    });
  } catch (err) {
    throw publishError(err);
  }
  lastPublishAt = Date.now();
  return gameId;
}

/**
 * Update a game I own: title/desc, and the code when `html` is given. ONE update that leaves
 * ownerId, createdAt and likes untouched and stamps updatedAt + publishLog/{me}.
 */
export async function updateGame({ uid, gameId, title, desc, html }) {
  if (!uid) throw new Error('Not signed in');
  if (!gameId) throw new Error('No game selected');
  const meta = cleanMeta({ title, desc });
  const patch = {
    [`games/${gameId}/title`]: meta.title,
    [`games/${gameId}/desc`]: meta.desc,
    [`games/${gameId}/updatedAt`]: serverTimestamp(),
    [`publishLog/${uid}`]: serverTimestamp(),
  };
  if (html !== undefined && html !== null) {
    const code = checkHtml(html);
    patch[`games/${gameId}/size`] = code.length;
    patch[`gameCode/${gameId}/html`] = code;
  }
  try {
    await update(ref(db), patch);
  } catch (err) {
    throw publishError(err);
  }
  lastPublishAt = Date.now();
}

/**
 * Remove a game with its code and likes in one update. Allowed for the owner and for app admins.
 */
export async function deleteGame(gameId) {
  if (!gameId) throw new Error('No game selected');
  await update(ref(db), {
    [`games/${gameId}`]: null,
    [`gameCode/${gameId}`]: null,
    [`gameLikes/${gameId}`]: null,
  });
}

/** Fetch the game's HTML (only on Play). */
export async function fetchGameCode(gameId) {
  const snap = await get(ref(db, `gameCode/${gameId}/html`));
  if (!snap.exists()) throw new Error('This game has no code (it may have been unpublished)');
  return String(snap.val());
}

// ---------- likes ----------

const MAX_LIKE_TRIES = 6;

/**
 * Like / unlike: ONE update writing gameLikes/{id}/{me} and games/{id}/likes = n ± 1. The rules
 * require the count to move by exactly one together with my like entry, so a concurrent like makes
 * our stale count fail with PERMISSION_DENIED; re-read and retry.
 */
async function setLike(gameId, uid, liked) {
  if (!uid) throw new Error('Not signed in');
  for (let attempt = 0; attempt < MAX_LIKE_TRIES; attempt++) {
    const [likeSnap, countSnap] = await Promise.all([
      get(ref(db, `gameLikes/${gameId}/${uid}`)),
      get(ref(db, `games/${gameId}/likes`)),
    ]);
    if (!countSnap.exists()) throw new Error('This game no longer exists');
    if (likeSnap.exists() === liked) return; // already in the wanted state
    const n = Number(countSnap.val()) || 0;
    if (!liked && n <= 0) return; // can't go below zero; nothing sane to do
    try {
      await update(ref(db), {
        [`gameLikes/${gameId}/${uid}`]: liked ? true : null,
        [`games/${gameId}/likes`]: liked ? n + 1 : n - 1,
      });
      if (liked) {
        // Bell entry for the author ("liked your game"); skipped for my own games.
        get(ref(db, `games/${gameId}/ownerId`))
          .then((s) => s.val() && deliverNotif({ to: s.val(), kind: 'gameLike', ref: { gameId } }))
          .catch(() => {});
      }
      return;
    } catch (err) {
      if (!isDenied(err) || attempt === MAX_LIKE_TRIES - 1) throw err;
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 220 * (attempt + 1)));
    }
  }
}

export const likeGame = (gameId, uid) => setLike(gameId, uid, true);
export const unlikeGame = (gameId, uid) => setLike(gameId, uid, false);

/** Live: has `uid` liked `gameId`? null while loading. */
export function useGameLiked(gameId, uid) {
  const [liked, setLiked] = useState(null);
  useEffect(() => {
    if (!gameId || !uid) {
      setLiked(null);
      return undefined;
    }
    setLiked(null);
    return onValue(
      ref(db, `gameLikes/${gameId}/${uid}`),
      (s) => setLiked(s.exists()),
      () => setLiked(false),
    );
  }, [gameId, uid]);
  return liked;
}

// ---------- lists ----------

function toGame(id, v) {
  if (!v || typeof v !== 'object') return null;
  return {
    id,
    ownerId: v.ownerId || null,
    title: String(v.title || 'Untitled'),
    desc: String(v.desc || ''),
    createdAt: Number(v.createdAt) || 0,
    updatedAt: Number(v.updatedAt) || 0,
    likes: Number(v.likes) || 0,
    size: Number(v.size) || 0,
  };
}

/**
 * Live list of games.
 *   sort 'new' : orderByChild('createdAt') limitToLast(limit), newest first
 *   sort 'top' : orderByChild('likes')     limitToLast(limit), most liked first
 *   ownerId    : orderByChild('ownerId').equalTo(ownerId) (sorted client-side by `sort`)
 * Returns { games, loading, error }.
 */
export function useGames({ sort = 'new', ownerId = null, limit = 50 } = {}) {
  const [state, setState] = useState({ games: [], loading: true, error: null });
  useEffect(() => {
    setState({ games: [], loading: true, error: null });
    const base = ref(db, 'games');
    const q = ownerId
      ? query(base, orderByChild('ownerId'), equalTo(ownerId))
      : query(base, orderByChild(sort === 'top' ? 'likes' : 'createdAt'), limitToLast(limit));
    return onValue(
      q,
      (snap) => {
        const list = [];
        snap.forEach((child) => {
          const g = toGame(child.key, child.val());
          if (g) list.push(g);
        });
        if (sort === 'top') list.sort((a, b) => b.likes - a.likes || b.createdAt - a.createdAt);
        else list.sort((a, b) => b.createdAt - a.createdAt);
        setState({ games: ownerId ? list.slice(0, limit) : list, loading: false, error: null });
      },
      (err) => setState({ games: [], loading: false, error: err?.message || String(err) }),
    );
  }, [sort, ownerId, limit]);
  return state;
}

/** Live single game (metadata only). { game, loading } — game is null when missing. */
export function useGame(gameId) {
  const [state, setState] = useState({ game: null, loading: !!gameId });
  useEffect(() => {
    if (!gameId) {
      setState({ game: null, loading: false });
      return undefined;
    }
    setState({ game: null, loading: true });
    return onValue(
      ref(db, `games/${gameId}`),
      (s) => setState({ game: toGame(gameId, s.val()), loading: false }),
      () => setState({ game: null, loading: false }),
    );
  }, [gameId]);
  return state;
}

// ---------- account deletion ----------

/**
 * Cleanup for deleteAccount (src/lib/account.js): deletes every game I own (meta + code + likes)
 * and, best effort, withdraws my likes on other games so their counts stay right.
 * publishLog/{uid} is write-only by design and stays (a bare timestamp).
 */
export async function deleteMyGames(uid, onStep) {
  if (!uid) return;
  onStep?.('Removing your public games…');
  await clearGameSaves(uid).catch(() => {}); // saved game data on this device
  const mine = await get(query(ref(db, 'games'), orderByChild('ownerId'), equalTo(uid)));
  const ids = Object.keys(mine.val() || {});
  for (const id of ids) await deleteGame(id);

  onStep?.('Withdrawing your game likes…');
  let all = {};
  try {
    all = (await get(ref(db, 'games'))).val() || {};
  } catch {
    all = {};
  }
  for (const id of Object.keys(all)) {
    try {
      const liked = await get(ref(db, `gameLikes/${id}/${uid}`));
      if (liked.exists()) await unlikeGame(id, uid);
    } catch {
      /* best effort: a game deleted meanwhile, or a lost race */
    }
  }
}

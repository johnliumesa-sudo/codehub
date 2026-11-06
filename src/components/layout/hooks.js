// Live data hooks for the app frame. Every listener is unsubscribed on change/unmount.
import { useEffect, useMemo, useState } from 'react';
import { limitToLast, onValue, query, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import {
  channelCacheKey,
  decryptChannel,
  decryptServerName,
  peekPlain,
  serverNameCacheKey,
} from '../../lib/servers.js';

const EMPTY = { loading: false, value: null, error: null };

/**
 * onValue wrapper: { loading, value, error }. `path` falsy -> idle.
 * RTDB cancels a listener for good on permission_denied (e.g. after a kick). Changing `nonce`
 * (e.g. the membership's joinedAt after a re-join) re-subscribes; the last value is kept meanwhile.
 */
export function useDbValue(path, nonce) {
  const [st, setSt] = useState(() => ({ path, ...(path ? { loading: true, value: null, error: null } : EMPTY) }));
  useEffect(() => {
    if (!path) return undefined;
    return onValue(
      ref(db, path),
      (s) => setSt({ path, loading: false, value: s.val(), error: null }),
      (error) => setSt({ path, loading: false, value: null, error }),
    );
  }, [path, nonce]);
  if (!path) return EMPTY;
  if (st.path !== path) return { loading: true, value: null, error: null };
  return st;
}

export const isPermissionDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e || ''));

/** userServers/{uid} -> [{ sid, joinedAt }] oldest first. */
export function useUserServers(uid) {
  const { loading, value, error } = useDbValue(uid ? `userServers/${uid}` : null);
  const servers = useMemo(
    () =>
      Object.entries(value || {})
        .map(([sid, v]) => ({ sid, joinedAt: (v && v.joinedAt) || 0 }))
        .sort((a, b) => a.joinedAt - b.joinedAt || a.sid.localeCompare(b.sid)),
    [value],
  );
  return { loading, servers, error };
}

/** servers/{sid}/meta with decrypted name. status: loading | ready | denied | missing | error */
export function useServerMeta(sid, nonce) {
  const { loading, value, error } = useDbValue(sid ? `servers/${sid}/meta` : null, nonce);
  const box = value?.nameEnc;
  const plainKey = box ? serverNameCacheKey(sid, box) : null;
  // A new nonce (re-join / re-wrapped key) retries a decryption that failed before.
  const cacheKey = plainKey ? `${nonce ?? ''}#${plainKey}` : null;
  const [dec, setDec] = useState({ key: null, name: null, error: null });

  useEffect(() => {
    if (!cacheKey || peekPlain(plainKey) !== undefined) return undefined;
    let alive = true;
    decryptServerName(sid, box).then(
      (name) => alive && setDec({ key: cacheKey, name, error: null }),
      (e) => alive && setDec({ key: cacheKey, name: null, error: e }),
    );
    return () => {
      alive = false;
    };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sid) return { status: 'missing' };
  if (loading) return { status: 'loading' };
  if (error) return { status: isPermissionDenied(error) ? 'denied' : 'error', error };
  if (!value) return { status: 'missing' };
  const cached = plainKey ? peekPlain(plainKey) : undefined;
  const decFailed = dec.key === cacheKey && dec.error;
  return {
    status: 'ready',
    ownerId: value.ownerId,
    color: value.color || '#5b8cff',
    createdAt: value.createdAt,
    name: cached ?? (dec.key === cacheKey ? dec.name : null),
    nameFailed: !!decFailed,
  };
}

const NO_DEC = Object.freeze({});

/** servers/{sid}/channels decrypted & sorted. */
export function useChannels(sid, nonce) {
  const { loading, value, error } = useDbValue(sid ? `servers/${sid}/channels` : null, nonce);
  // cacheKey -> {name, topic} | {failed:true}; scoped to the nonce so failures are retried after a re-join.
  const [decSt, setDecSt] = useState({ nonce, map: {} });
  const dec = decSt.nonce === nonce ? decSt.map : NO_DEC;

  useEffect(() => {
    if (!value) return undefined;
    let alive = true;
    const put = (k, v) => setDecSt((d) => ({ nonce, map: { ...(d.nonce === nonce ? d.map : {}), [k]: v } }));
    Object.entries(value).forEach(([cid, ch]) => {
      if (!ch?.enc) return;
      const k = channelCacheKey(sid, cid, ch.enc);
      if (peekPlain(k) !== undefined) return;
      decryptChannel(sid, cid, ch.enc).then(
        (v) => alive && put(k, v),
        () => alive && put(k, { failed: true }),
      );
    });
    return () => {
      alive = false;
    };
  }, [sid, value, nonce]);

  const channels = useMemo(() => {
    if (!value) return [];
    return Object.entries(value)
      .filter(([, ch]) => ch && typeof ch === 'object')
      .map(([cid, ch]) => {
        const k = ch.enc ? channelCacheKey(sid, cid, ch.enc) : null;
        const p = (k && peekPlain(k)) || (k && dec[k]) || null;
        return {
          cid,
          type: ch.type === 'code' ? 'code' : 'text',
          position: typeof ch.position === 'number' ? ch.position : 0,
          createdAt: typeof ch.createdAt === 'number' ? ch.createdAt : 0,
          name: p && !p.failed ? p.name : null,
          topic: p && !p.failed ? p.topic : '',
          pending: !p,
          failed: !!p?.failed,
        };
      })
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.cid.localeCompare(b.cid));
  }, [sid, value, dec]);

  return { loading, channels, error };
}

/** Raw channel ids (no decryption) — cheap, for server-rail unread dots. */
export function useChannelIds(sid, nonce) {
  const { value } = useDbValue(sid ? `servers/${sid}/channels` : null, nonce);
  return useMemo(() => Object.keys(value || {}).sort(), [value]);
}

/** Last message {ts, uid} per channel, via limitToLast(1) listeners. */
export function useLastMessages(basePath, ids, nonce) {
  const key = ids.join(',');
  const [map, setMap] = useState({});
  useEffect(() => {
    setMap({});
    if (!basePath || !key) return undefined;
    const unsubs = key.split(',').map((id) =>
      onValue(
        query(ref(db, `${basePath}/${id}`), limitToLast(1)),
        (s) => {
          let last = null;
          s.forEach((c) => {
            const v = c.val() || {};
            last = { ts: typeof v.ts === 'number' ? v.ts : 0, uid: v.uid || null };
          });
          setMap((m) => ({ ...m, [id]: last }));
        },
        () => setMap((m) => ({ ...m, [id]: null })),
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [basePath, key, nonce]);
  return map;
}

/** servers/{sid}/members -> [{uid, role, joinedAt, roleId?}] */
export function useMembers(sid, nonce) {
  const { loading, value, error } = useDbValue(sid ? `servers/${sid}/members` : null, nonce);
  const members = useMemo(
    () =>
      Object.entries(value || {}).map(([uid, m]) => ({
        uid,
        role: m?.role === 'owner' || m?.role === 'admin' ? m.role : 'member',
        joinedAt: m?.joinedAt || 0,
        ...(typeof m?.roleId === 'string' && m.roleId ? { roleId: m.roleId } : {}),
      })),
    [value],
  );
  return { loading, members, error };
}

/** userDms/{uid} -> [{dmId, peer, lastTs}] newest first */
export function useUserDms(uid, peerFromId) {
  const { loading, value, error } = useDbValue(uid ? `userDms/${uid}` : null);
  const dms = useMemo(
    () =>
      Object.entries(value || {})
        .map(([dmId, v]) => ({ dmId, peer: v?.peer || peerFromId(dmId), lastTs: v?.lastTs || 0 }))
        .filter((d) => d.peer)
        .sort((a, b) => b.lastTs - a.lastTs),
    [value], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return { loading, dms, error };
}

export function useMediaQuery(q) {
  const get = () => typeof window !== 'undefined' && window.matchMedia(q).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    const mql = window.matchMedia(q);
    const on = () => setM(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [q]);
  return m;
}

export function isUnread(last, readTs, myUid) {
  return !!last && last.uid !== myUid && last.ts > (readTs || 0);
}

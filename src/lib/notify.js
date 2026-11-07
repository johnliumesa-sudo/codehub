// Desktop notifications & per-conversation mute (F19).
//
// notifPrefs/{uid}/settings          = { desktop: bool, preview: bool, mentionsOnly: bool }   (owner only)
// notifPrefs/{uid}/scopes/{scope}    = { level: 'all'|'mentions'|'none', until?: number }     (owner only)
//
// Scopes: '{sid}_{cid}' (channel), 'dm_{dmId}', 'grp_{gid}', and 'srv_{sid}' which mutes every channel
// of a server. A channel's own pref (if active) wins over its server's pref. `until` is a client
// timestamp; once passed, the pref is ignored (and may be cleaned up lazily).
//
// Notifications are generated in the open tab only (no push server, no Cloud Functions): the Notifier
// listens to limitToLast(1) of each conversation, decrypts locally and calls the Notification API.
// Message previews are OFF by default so plaintext never lands on a lock screen unless the user opts in.
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, limitToLast, onChildAdded, onValue, query, ref, remove, set, update } from 'firebase/database';
import { db } from './firebase.js';
import { decryptMessage, getConvKey, messagesPath, serverNow } from './messages.js';
import { mentionsName } from './markdown.js';
import { channelScope, decryptChannel, decryptServerName, dmScope } from './servers.js';
import { setTitleCount } from './title.js';
import { isDoNotDisturb } from './presence.js';

export const DEFAULT_SETTINGS = Object.freeze({ desktop: false, preview: false, mentionsOnly: false });
export const LEVELS = ['all', 'mentions', 'none'];
export const serverScope = (sid) => `srv_${sid}`;

/** Options for MuteMenu. `ms` = duration; `level` = what to store. */
export const MUTE_OPTIONS = [
  { id: '15m', label: 'For 15 minutes', level: 'none', ms: 15 * 60_000 },
  { id: '1h', label: 'For 1 hour', level: 'none', ms: 3_600_000 },
  { id: '8h', label: 'For 8 hours', level: 'none', ms: 8 * 3_600_000 },
  { id: 'forever', label: 'Until I turn it back on', level: 'none' },
];

const uidOf = (me) => (typeof me === 'string' ? me : me?.uid) || null;
const EMPTY_PREFS = Object.freeze({ loading: true, settings: DEFAULT_SETTINGS, scopes: Object.freeze({}) });

// ---------- Shared live subscription of notifPrefs/{uid} ----------

const stores = new Map(); // uid -> { value, listeners, unsub, idle }
const IDLE_MS = 30_000;

function normalize(v) {
  const s = (v && v.settings) || {};
  const scopes = {};
  Object.entries((v && v.scopes) || {}).forEach(([k, p]) => {
    if (p && LEVELS.includes(p.level)) scopes[k] = { level: p.level, ...(typeof p.until === 'number' ? { until: p.until } : {}) };
  });
  return {
    loading: false,
    settings: { desktop: s.desktop === true, preview: s.preview === true, mentionsOnly: s.mentionsOnly === true },
    scopes,
  };
}

function subscribe(uid, fn) {
  let st = stores.get(uid);
  if (!st) {
    const entry = { value: null, listeners: new Set(), unsub: null, idle: null };
    st = entry;
    stores.set(uid, entry);
    entry.unsub = onValue(
      ref(db, `notifPrefs/${uid}`),
      (snap) => {
        entry.value = normalize(snap.val());
        entry.listeners.forEach((l) => l(entry.value));
      },
      () => {
        if (stores.get(uid) === entry) stores.delete(uid);
        entry.value = { ...normalize(null) };
        entry.listeners.forEach((l) => l(entry.value));
      },
    );
  }
  const e = st;
  clearTimeout(e.idle);
  e.idle = null;
  e.listeners.add(fn);
  if (e.value) fn(e.value);
  return () => {
    e.listeners.delete(fn);
    if (e.listeners.size === 0 && stores.get(uid) === e) {
      e.idle = setTimeout(() => {
        if (e.listeners.size === 0 && stores.get(uid) === e) {
          stores.delete(uid);
          e.unsub?.();
        }
      }, IDLE_MS);
    }
  };
}

/**
 * Live prefs `{ loading, settings, scopes }`. Re-renders when a timed mute expires, so
 * `isMuted(prefs, scope)` stays correct without callers polling.
 */
export function useNotifPrefs(me) {
  const uid = uidOf(me);
  const [prefs, setPrefs] = useState(() => (uid && stores.get(uid)?.value) || EMPTY_PREFS);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!uid) {
      setPrefs(EMPTY_PREFS);
      return undefined;
    }
    return subscribe(uid, setPrefs);
  }, [uid]);

  useEffect(() => {
    const now = Date.now();
    const next = Object.values(prefs.scopes || {})
      .map((p) => p.until)
      .filter((u) => typeof u === 'number' && u > now)
      .sort((a, b) => a - b)[0];
    if (!next) return undefined;
    const t = setTimeout(() => setTick((x) => x + 1), Math.min(next - now + 250, 2_147_000_000));
    return () => clearTimeout(t);
  }, [prefs]);

  return uid ? prefs : EMPTY_PREFS;
}

// ---------- Writes ----------

export function setNotifSettings(me, patch) {
  const uid = uidOf(me);
  if (!uid) return Promise.reject(new Error('Not signed in'));
  const out = {};
  ['desktop', 'preview', 'mentionsOnly'].forEach((k) => {
    if (typeof patch?.[k] === 'boolean') out[`notifPrefs/${uid}/settings/${k}`] = patch[k];
  });
  return update(ref(db), out);
}

/**
 * Set or clear a scope's pref. `pref` = { level, until? } or null (back to default "all").
 * `{ level: 'all' }` with no `until` is stored only when overriding a muted server for one channel.
 */
export function setScopePref(me, scope, pref) {
  const uid = uidOf(me);
  if (!uid) return Promise.reject(new Error('Not signed in'));
  if (!scope || scope.length > 200 || /[.#$[\]/]/.test(scope)) return Promise.reject(new Error('Invalid scope'));
  const r = ref(db, `notifPrefs/${uid}/scopes/${scope}`);
  if (!pref) return remove(r);
  if (!LEVELS.includes(pref.level)) return Promise.reject(new Error('Invalid level'));
  const val = { level: pref.level };
  if (typeof pref.until === 'number' && pref.until > 0) val.until = Math.round(pref.until);
  return set(r, val);
}

/** Drop expired timed prefs (housekeeping; optional). */
export function pruneExpired(me, prefs, now = Date.now()) {
  const uid = uidOf(me);
  if (!uid) return Promise.resolve();
  const out = {};
  Object.entries(prefs?.scopes || {}).forEach(([k, p]) => {
    if (typeof p.until === 'number' && p.until <= now) out[`notifPrefs/${uid}/scopes/${k}`] = null;
  });
  return Object.keys(out).length ? update(ref(db), out) : Promise.resolve();
}

// ---------- Evaluation ----------

/** The scope's own pref if present and not expired, else null. */
export function activePref(prefs, scope, now = Date.now()) {
  const p = prefs?.scopes?.[scope];
  if (!p || !LEVELS.includes(p.level)) return null;
  if (typeof p.until === 'number' && p.until <= now) return null;
  return p;
}

// Server/channel ids are RTDB push keys (20 chars of [-0-9A-Za-z_]), so '{sid}_{cid}' is split by length.
const CHANNEL_SCOPE_RE = /^([-0-9A-Za-z_]{20})_([-0-9A-Za-z_]{20})$/;
export function sidOfScope(scope) {
  if (!scope || /^(dm|grp|cs|srv)_/.test(scope)) return null;
  const m = CHANNEL_SCOPE_RE.exec(scope);
  return m ? m[1] : null;
}

/** 'all' | 'mentions' | 'none' — channel pref, else server pref, else 'all'. */
export function effectiveLevel(prefs, scope, now = Date.now(), { sid } = {}) {
  const own = activePref(prefs, scope, now);
  if (own) return own.level;
  const s = sid || sidOfScope(scope);
  if (s) {
    const sp = activePref(prefs, serverScope(s), now);
    if (sp) return sp.level;
  }
  return 'all';
}

/**
 * True when activity in `scope` should be silenced. Without `mention` (e.g. for unread badges) a
 * "mentions only" scope counts as muted. Pass `{ sid }` for channel scopes when known.
 */
export function isMuted(prefs, scope, now = Date.now(), { sid, mention = false } = {}) {
  const level = effectiveLevel(prefs, scope, now, { sid });
  return level === 'none' || (level === 'mentions' && !mention);
}

/** Short human label for a scope's current state, e.g. "Muted · 42 min left". */
export function describePref(pref, now = Date.now()) {
  if (!pref) return 'All messages';
  if (pref.level === 'all') return 'All messages';
  if (pref.level === 'mentions') return 'Mentions only';
  if (typeof pref.until === 'number') {
    const left = Math.max(0, pref.until - now);
    if (left < 3_600_000) return `Muted · ${Math.max(1, Math.ceil(left / 60_000))} min left`;
    if (left < 86_400_000) return `Muted · ${Math.ceil(left / 3_600_000)} h left`;
    return `Muted until ${new Date(pref.until).toLocaleString()}`;
  }
  return 'Muted';
}

// ---------- Desktop notifications ----------

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    // Old Safari: callback form only.
    return new Promise((resolve) => Notification.requestPermission(resolve));
  }
}

/** Shows a notification; returns it, or null if the platform refused (e.g. Android needs a SW). */
export function showNotification(title, { body = '', tag, onClick } = {}) {
  if (notificationPermission() !== 'granted') return null;
  try {
    const n = new Notification(String(title).slice(0, 120), { body: String(body).slice(0, 240), tag, silent: false });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      onClick?.();
      n.close();
    };
    return n;
  } catch {
    return null;
  }
}

const isFocused = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();

function previewOf(body) {
  if (!body) return '';
  const t = String(body.text || '')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t) return t.length > 140 ? `${t.slice(0, 139)}…` : t;
  if (body.code) return `[code snippet${body.code.filename ? `: ${body.code.filename}` : ''}]`;
  return '';
}

const nameCache = new Map(); // uid -> Promise<string>
function senderName(uid) {
  if (!nameCache.has(uid)) {
    const p = get(ref(db, `users/${uid}/name`))
      .then((s) => (typeof s.val() === 'string' && s.val()) || 'Someone')
      .catch(() => 'Someone');
    nameCache.set(uid, p);
    if (nameCache.size > 500) nameCache.delete(nameCache.keys().next().value);
  }
  return nameCache.get(uid);
}

/** RTDB path of a source's messages (groups are handled here so this works before messages.js knows them). */
export function sourcePath(conv) {
  if (conv.kind === 'group') return `groupMessages/${conv.gid}`;
  return messagesPath(conv);
}

/**
 * Core of <Notifier/>.
 *  me          { uid, name }
 *  sources     [{ scope, path?, conv, title, serverName? }]
 *  activeScope scope of the conversation on screen (or null)
 *  prefs       from useNotifPrefs(me)
 *  reads       reads/{uid} map (scope -> ts) — clears the title count when read anywhere
 *  blocked     Set of blocked uids (never notify for them)
 *  onOpen      (source) => void — clicking a notification navigates there
 * Returns { unread } (the count shown in the page title).
 */
export function useNotifier({ me, sources, activeScope, prefs, reads, blocked, onOpen }) {
  const startedAt = useRef(0);
  if (!startedAt.current) startedAt.current = serverNow();
  const latest = useRef({});
  latest.current = { me, prefs, activeScope, blocked, onOpen };
  const seen = useRef(new Set());
  const subs = useRef(new Map()); // path -> { unsub, source }
  const [pending, setPending] = useState({}); // scope -> [ts, ...]

  const byPath = useMemo(() => {
    const m = new Map();
    (sources || []).forEach((s) => {
      if (!s?.conv || !s.scope) return;
      const path = s.path || sourcePath(s.conv);
      if (path && !path.includes('undefined')) m.set(path, { ...s, path });
    });
    return m;
  }, [sources]);

  useEffect(() => {
    const cur = subs.current;
    // Drop listeners for sources that went away (left server, hidden DM, …).
    for (const [path, entry] of cur) {
      if (!byPath.has(path)) {
        entry.unsub();
        cur.delete(path);
      }
    }
    for (const [path, source] of byPath) {
      const existing = cur.get(path);
      if (existing) {
        existing.source = source; // fresher title/conv, same listener
        continue;
      }
      const entry = { source, unsub: () => {} };
      cur.set(path, entry);
      entry.unsub = onChildAdded(
        query(ref(db, path), limitToLast(1)),
        (snap) => handle(entry, snap.key, snap.val()),
        () => {
          // permission_denied (kicked, left): RTDB cancels the listener for good.
          if (cur.get(path) === entry) cur.delete(path);
        },
      );
    }
  }, [byPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    for (const entry of subs.current.values()) entry.unsub();
    subs.current.clear();
  }, []);

  async function handle(entry, mid, raw) {
    const L = latest.current;
    const myUid = L.me?.uid;
    if (!myUid || !raw || typeof raw !== 'object' || raw.deleted) return;
    if (raw.uid === myUid || typeof raw.uid !== 'string') return;
    if (typeof raw.ts !== 'number' || raw.ts < startedAt.current) return;
    const { source } = entry;
    const seenKey = `${source.path}/${mid}`;
    if (seen.current.has(seenKey)) return;
    seen.current.add(seenKey);
    if (seen.current.size > 5000) seen.current.delete(seen.current.values().next().value);
    if (L.blocked?.has?.(raw.uid)) return;

    const scope = source.scope;
    const conv = source.conv;
    const sid = conv.kind === 'channel' ? conv.sid : undefined;
    const level = effectiveLevel(L.prefs, scope, Date.now(), { sid });
    if (level === 'none') return;
    if (scope === L.activeScope && isFocused()) return;

    let body = null;
    try {
      const key = await getConvKey(conv);
      body = await decryptMessage(key, conv, mid, raw);
    } catch {
      body = null; // undecryptable: still worth a generic ping unless the scope needs a mention
    }
    const isDm = conv.kind === 'dm';
    const L2 = latest.current;
    const mentioned = !!body && mentionsName(body.text || '', L2.me?.name || '');
    if (level === 'mentions' && !mentioned) return;
    if (scope === L2.activeScope && isFocused()) return;

    setPending((p) => ({ ...p, [scope]: [...(p[scope] || []).slice(-98), raw.ts] }));

    const settings = L2.prefs?.settings || DEFAULT_SETTINGS;
    if (!settings.desktop || notificationPermission() !== 'granted' || isDoNotDisturb()) return; // DND: counts only
    if (settings.mentionsOnly && !mentioned && !isDm) return;

    const who = await senderName(raw.uid);
    let title;
    let text;
    if (settings.preview) {
      const where = conv.kind === 'channel'
        ? ` in #${source.title || 'channel'}${source.serverName ? ` (${source.serverName})` : ''}`
        : conv.kind === 'group' ? ` in ${source.title || 'a group'}` : '';
      title = `${who}${where}`;
      text = previewOf(body) || (body ? 'Sent a message' : 'Sent a message (could not decrypt)');
    } else {
      // No plaintext: channel and group names are encrypted content too, so they stay hidden.
      title = isDm ? who : `${who} · Codehub`;
      text = mentioned ? 'Mentioned you' : isDm ? 'Sent you a message' : conv.kind === 'group' ? 'New message in a group' : 'New message in a channel';
    }
    showNotification(title, { body: text, tag: scope, onClick: () => latest.current.onOpen?.(source) });
  }

  // Forget counts once the conversation is read (here or on another device) or opened while focused.
  useEffect(() => {
    setPending((p) => {
      let changed = false;
      const out = {};
      Object.entries(p).forEach(([scope, list]) => {
        const readTs = reads?.[scope] || 0;
        const keep = scope === activeScope && isFocused() ? [] : list.filter((ts) => ts > readTs);
        if (keep.length !== list.length) changed = true;
        if (keep.length) out[scope] = keep;
      });
      return changed ? out : p;
    });
  }, [reads, activeScope]);

  useEffect(() => {
    const onFocus = () => {
      const scope = latest.current.activeScope;
      if (!scope) return;
      setPending((p) => {
        if (!p[scope]) return p;
        const n = { ...p };
        delete n[scope];
        return n;
      });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const unread = useMemo(() => {
    const now = Date.now();
    return Object.entries(pending).reduce((n, [scope, list]) => {
      const src = [...byPath.values()].find((s) => s.scope === scope);
      if (!src) return n;
      const sid = src.conv.kind === 'channel' ? src.conv.sid : undefined;
      if (effectiveLevel(prefs, scope, now, { sid }) === 'none') return n;
      return n + list.length;
    }, 0);
  }, [pending, prefs, byPath]);

  // "(3) …" in the tab title (lib/title.js owns document.title).
  useEffect(() => setTitleCount('messages', unread), [unread]);
  useEffect(() => () => setTitleCount('messages', 0), []);

  return { unread };
}

// ---------- Source builder for the integrator ----------

/**
 * Builds Notifier sources from what Workspace already has:
 *   servers: [{ sid }]                 (useUserServers)
 *   dms:     [{ dmId, peer }]          (useUserDms)
 *   groups:  [conv]                    (WS1: useMyGroups(uid).groups.map(groupConv))
 * Subscribes servers/{sid}/channels (+ meta name) for every joined server; text channels only.
 */
export function useNotifySources({ servers = [], dms = [], groups = [] }) {
  const sidKey = servers.map((s) => s.sid).filter(Boolean).sort().join(',');
  const [chans, setChans] = useState({}); // sid -> [{ cid, name }]
  const [names, setNames] = useState({}); // sid -> server name

  useEffect(() => {
    const sids = sidKey ? sidKey.split(',') : [];
    setChans((c) => Object.fromEntries(Object.entries(c).filter(([sid]) => sids.includes(sid))));
    let alive = true;
    const unsubs = sids.flatMap((sid) => [
      onValue(
        ref(db, `servers/${sid}/channels`),
        (snap) => {
          const v = snap.val() || {};
          const list = Object.entries(v)
            .filter(([, ch]) => ch && typeof ch === 'object' && ch.type !== 'code')
            .map(([cid, ch]) => ({ cid, enc: ch.enc, type: ch.type === 'voice' ? 'voice' : 'text' }));
          setChans((c) => ({ ...c, [sid]: list.map(({ cid, type }) => ({ cid, type, name: c[sid]?.find((x) => x.cid === cid)?.name || '' })) }));
          list.forEach(({ cid, enc }) => {
            if (!enc) return;
            decryptChannel(sid, cid, enc).then(
              (d) => alive && setChans((c) => ({
                ...c,
                [sid]: (c[sid] || []).map((x) => (x.cid === cid ? { ...x, name: d.name } : x)),
              })),
              () => {},
            );
          });
        },
        () => alive && setChans((c) => ({ ...c, [sid]: [] })),
      ),
      onValue(
        ref(db, `servers/${sid}/meta/nameEnc`),
        (snap) => {
          const box = snap.val();
          if (!box) return;
          decryptServerName(sid, box).then((n) => alive && setNames((m) => ({ ...m, [sid]: n })), () => {});
        },
        () => {},
      ),
    ]);
    return () => {
      alive = false;
      unsubs.forEach((u) => u());
    };
  }, [sidKey]);

  const dmKey = dms.map((d) => `${d.dmId}:${d.peer}`).join(',');
  const groupKey = groups.map((g) => `${g?.gid}:${g?.epoch}:${g?.title || ''}`).join(',');

  return useMemo(() => {
    const out = [];
    Object.entries(chans).forEach(([sid, list]) => {
      list.forEach(({ cid, name, type }) => {
        const scope = channelScope(sid, cid);
        out.push({
          scope,
          path: `messages/${sid}/${cid}`,
          conv: { kind: 'channel', sid, cid, title: name, scope },
          title: name,
          serverName: names[sid] || '',
          type,
        });
      });
    });
    dms.forEach((d) => {
      if (!d?.dmId || !d.peer) return;
      const scope = dmScope(d.dmId);
      out.push({ scope, path: `dmMessages/${d.dmId}`, conv: { kind: 'dm', dmId: d.dmId, peerUid: d.peer, scope, title: '' }, title: '' });
    });
    groups.forEach((g) => {
      if (!g?.gid) return;
      const scope = g.scope || `grp_${g.gid}`;
      out.push({ scope, path: `groupMessages/${g.gid}`, conv: { ...g, kind: 'group', scope }, title: g.title || '' });
    });
    return out;
  }, [chans, names, dmKey, groupKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Paths deleteAccount() must clear for `uid`. */
export const notifyCleanupPaths = (uid) => [`notifPrefs/${uid}`];

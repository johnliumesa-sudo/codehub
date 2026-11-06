// Command palette / quick switcher helpers (F18): fuzzy scoring, ranking, item sources, hotkey.
//
// Everything stays local: names are decrypted with keys this session already holds, nothing is
// sent anywhere, and the only thing persisted is the list of recently chosen item ids
// (localStorage `codehub.paletteRecent`; ids are opaque push keys, never names).
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, ref } from 'firebase/database';
import { db } from './firebase.js';
import { useProfiles } from './profiles.js';
import { decryptChannel, decryptServerName, peerFromDmId } from './servers.js';

// ---------- fuzzy scoring ----------

const isWordStart = (text, i) => i === 0 || /[\s\-_/.#:@()[\]]/.test(text[i - 1]) || (text[i - 1] === text[i - 1].toLowerCase() && text[i] !== text[i].toLowerCase());

function scoreFrom(text, lower, q, start) {
  const indices = [];
  let score = 0;
  let ti = start;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    // Prefer a word-start match for this char if one exists before the next plain match.
    let found = -1;
    let firstPlain = -1;
    for (let j = ti; j < lower.length; j++) {
      if (lower[j] !== ch) continue;
      if (firstPlain < 0) firstPlain = j;
      if (j === prev + 1) {
        found = j;
        break;
      }
      if (isWordStart(text, j)) {
        found = j;
        break;
      }
    }
    if (found < 0) found = firstPlain;
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 6; // consecutive
    if (isWordStart(text, found)) s += 8;
    if (found === 0) s += 6;
    if (text[found] === q[qi]) s += 0.5; // same case (q is lowercase)
    if (prev >= 0 && found > prev + 1) s -= Math.min(4, (found - prev - 1) * 0.5); // gap
    score += s;
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  score -= Math.min(10, (lower.length - q.length) * 0.08); // shorter targets win ties
  if (lower === q) score += 30;
  else if (lower.startsWith(q)) score += 12;
  return { score, indices };
}

/**
 * Fuzzy subsequence match of `query` against `text`.
 * -> { score, indices } (indices = matched character positions in `text`) or null.
 */
export function fuzzyScore(query, text) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  const t = String(text || '');
  if (!q) return { score: 0, indices: [] };
  const lower = t.toLowerCase();
  if (q.length > lower.length) return null;
  let best = null;
  // Try each starting occurrence of the first query char (cheap: strings are short).
  for (let i = lower.indexOf(q[0]); i >= 0 && i <= lower.length - q.length; i = lower.indexOf(q[0], i + 1)) {
    const r = scoreFrom(t, lower, q, i);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

/** Split `text` into [{ text, hit }] runs for rendering highlighted matches. */
export function highlightRuns(text, indices) {
  const s = String(text || '');
  if (!indices?.length) return [{ text: s, hit: false }];
  const set = new Set(indices);
  const runs = [];
  for (let i = 0; i < s.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += s[i];
    else runs.push({ text: s[i], hit });
  }
  return runs;
}

// ---------- recents ----------

export const RECENT_KEY = 'codehub.paletteRecent';
// window event the palette's "Toggle preview" action fires; an open CollabView cancels it.
export const TOGGLE_PREVIEW_EVENT = 'codehub:toggle-preview';
const MAX_RECENT = 12;

export function loadRecents() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function pushRecent(id) {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage disabled */
  }
  return next;
}

// ---------- ranking ----------

const KIND_ORDER = { action: 0, channel: 1, dm: 2, group: 3, codespace: 4, server: 5 };

/**
 * items: [{ id, kind, title, subtitle?, keywords?, target }]
 * -> [{ item, score, indices }] best first. With an empty query: recents first, then by kind.
 */
export function rank(items, query, recents = []) {
  const recentPos = new Map(recents.map((id, i) => [id, i]));
  const q = String(query || '').trim();
  if (!q) {
    return items
      .map((item) => ({ item, score: 0, indices: [] }))
      .sort((a, b) => {
        const ra = recentPos.has(a.item.id) ? recentPos.get(a.item.id) : Infinity;
        const rb = recentPos.has(b.item.id) ? recentPos.get(b.item.id) : Infinity;
        if (ra !== rb) return ra - rb;
        const ka = KIND_ORDER[a.item.kind] ?? 9;
        const kb = KIND_ORDER[b.item.kind] ?? 9;
        if (ka !== kb) return ka - kb;
        return String(a.item.title).localeCompare(String(b.item.title));
      });
  }
  const out = [];
  for (const item of items) {
    const main = fuzzyScore(q, item.title);
    const extraText = [item.subtitle, ...(item.keywords || [])].filter(Boolean).join(' ');
    const extra = extraText ? fuzzyScore(q, extraText) : null;
    // Also match "server channel" style queries against the combined label.
    const combo = item.subtitle ? fuzzyScore(q, `${item.subtitle} ${item.title}`) : null;
    let best = null;
    if (main) best = { score: main.score + 5, indices: main.indices };
    if (extra && (!best || extra.score * 0.6 > best.score)) best = { score: extra.score * 0.6, indices: [] };
    if (combo && (!best || combo.score * 0.8 > best.score)) {
      const off = item.subtitle.length + 1;
      best = { score: combo.score * 0.8, indices: combo.indices.filter((i) => i >= off).map((i) => i - off) };
    }
    if (!best) continue;
    if (recentPos.has(item.id)) best.score += Math.max(0, 6 - recentPos.get(item.id) * 0.5);
    out.push({ item, ...best });
  }
  out.sort((a, b) => b.score - a.score || String(a.item.title).localeCompare(String(b.item.title)));
  return out;
}

// ---------- sources ----------

const errMsg = (e) => String(e?.message || e || '').replace(/^Error:\s*/, '');

/**
 * Servers, channels and DMs the user can already decrypt, loaded each time the palette opens
 * (the previous result stays visible while refreshing). Undecryptable entries are left out.
 * -> { items, loading, error }
 */
export function usePaletteSources(me, open) {
  const uid = me?.uid;
  const [state, setState] = useState({ servers: [], channels: [], dms: [], loading: false, error: null });
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open || !uid) return undefined;
    const my = ++seqRef.current;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const [serversSnap, dmsSnap] = await Promise.all([
        get(ref(db, `userServers/${uid}`)).catch(() => null),
        get(ref(db, `userDms/${uid}`)).catch(() => null),
      ]);
      const sids = Object.keys(serversSnap?.val() || {});
      const servers = [];
      const channels = [];
      await Promise.all(
        sids.map(async (sid) => {
          try {
            const meta = (await get(ref(db, `servers/${sid}/meta`))).val();
            if (!meta?.nameEnc) return;
            const name = await decryptServerName(sid, meta.nameEnc);
            servers.push({ sid, name });
            const chs = (await get(ref(db, `servers/${sid}/channels`))).val() || {};
            await Promise.all(
              Object.entries(chs).map(async ([cid, c]) => {
                if (!c?.enc) return;
                try {
                  const { name: chName, topic } = await decryptChannel(sid, cid, c.enc);
                  channels.push({
                    sid,
                    cid,
                    serverName: name,
                    name: chName,
                    topic,
                    type: c.type === 'code' || c.type === 'voice' ? c.type : 'text',
                    position: typeof c.position === 'number' ? c.position : 0,
                  });
                } catch {
                  /* undecryptable channel: skip */
                }
              }),
            );
          } catch {
            /* no access / no key: skip this server */
          }
        }),
      );
      const dms = Object.entries(dmsSnap?.val() || {})
        .map(([dmId, v]) => ({ dmId, peer: v?.peer || peerFromDmId(dmId, uid), lastTs: v?.lastTs || 0 }))
        .filter((d) => d.peer);
      if (!alive || my !== seqRef.current) return;
      servers.sort((a, b) => a.name.localeCompare(b.name));
      channels.sort((a, b) => a.serverName.localeCompare(b.serverName) || a.position - b.position);
      dms.sort((a, b) => b.lastTs - a.lastTs);
      setState({ servers, channels, dms, loading: false, error: null });
    })().catch((e) => {
      if (alive && my === seqRef.current) setState((s) => ({ ...s, loading: false, error: errMsg(e) }));
    });
    return () => {
      alive = false;
    };
  }, [open, uid]);

  const peerUids = useMemo(() => state.dms.map((d) => d.peer), [state.dms]);
  const profiles = useProfiles(peerUids);

  const items = useMemo(() => {
    const list = [];
    for (const s of state.servers) {
      list.push({
        id: `server:${s.sid}`,
        kind: 'server',
        title: s.name,
        subtitle: 'Server',
        target: { type: 'server', sid: s.sid },
      });
    }
    for (const c of state.channels) {
      list.push({
        id: `channel:${c.sid}/${c.cid}`,
        kind: 'channel',
        channelType: c.type,
        title: c.name,
        subtitle: c.serverName,
        keywords: [c.type === 'code' ? 'workspace code collab' : 'channel chat', c.topic].filter(Boolean),
        target: { type: 'channel', sid: c.sid, cid: c.cid, channelType: c.type },
      });
    }
    for (const d of state.dms) {
      const p = profiles[d.peer];
      if (!p?.name) continue;
      list.push({
        id: `dm:${d.dmId}`,
        kind: 'dm',
        title: p.name,
        subtitle: 'Direct message',
        color: p.color,
        keywords: ['dm', 'message'],
        target: { type: 'dm', dmId: d.dmId },
      });
    }
    return list;
  }, [state.servers, state.channels, state.dms, profiles]);

  return { items, loading: state.loading, error: state.error };
}

// ---------- hotkey ----------

/** True when a modal (other than the palette itself) is open. */
export function isModalOpen() {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('.modal-backdrop:not(.pd-palette-backdrop), [role="dialog"][aria-modal="true"]:not(.pd-palette)');
}

/**
 * Ctrl/Cmd+K and Ctrl/Cmd+Shift+P call `onTrigger(event)`. Listens in the capture phase so it
 * also works inside CodeMirror (CM6 has no default Mod-K binding). Ignored while another modal
 * is open, unless `opts.whileModal` is true.
 */
export function useHotkey(onTrigger, { enabled = true, whileModal = false } = {}) {
  const fnRef = useRef(onTrigger);
  fnRef.current = onTrigger;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.isComposing || e.altKey) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = String(e.key || '').toLowerCase();
      const hit = (k === 'k' && !e.shiftKey) || (k === 'p' && e.shiftKey);
      if (!hit) return;
      if (!whileModal && isModalOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      fnRef.current?.(e);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, whileModal]);
}

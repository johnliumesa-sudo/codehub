// Channel categories. servers/{sid}/categories/{catId} = { enc:{iv,ct}, position }, enc = encrypted
// { name } under the server key, AAD `category:{sid}/{catId}`. A channel opts in via channels/{cid}/cat.
// A dangling `cat` (category deleted) renders as uncategorized.
import { useEffect, useMemo, useState } from 'react';
import { onValue, push, ref, remove, set, update } from 'firebase/database';
import { db } from '../firebase.js';
import { decryptJSON, encryptJSON } from '../crypto.js';
import { getServerKey } from '../keystore.js';

export const MAX_CATEGORY_NAME = 32;
export const MAX_CATEGORIES = 20;
export const categoryAad = (sid, catId) => `category:${sid}/${catId}`;
export const cleanCategoryName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY_NAME);

const plain = new Map(); // `${sid}/${catId}|iv|ct` -> name
const ck = (sid, id, b) => `${sid}/${id}|${b?.iv}|${b?.ct}`;
export const clearCategoryCache = () => plain.clear();

export async function createCategory(sid, name, position) {
  const clean = cleanCategoryName(name);
  if (!clean) throw new Error('Category name cannot be empty');
  const catId = push(ref(db, `servers/${sid}/categories`)).key;
  const enc = await encryptJSON(await getServerKey(sid), { name: clean }, categoryAad(sid, catId));
  await set(ref(db, `servers/${sid}/categories/${catId}`), { enc, position: Number.isFinite(position) ? position : Date.now() });
  return catId;
}

export async function renameCategory(sid, catId, name) {
  const clean = cleanCategoryName(name);
  if (!clean) throw new Error('Category name cannot be empty');
  const enc = await encryptJSON(await getServerKey(sid), { name: clean }, categoryAad(sid, catId));
  await set(ref(db, `servers/${sid}/categories/${catId}/enc`), enc);
}

export const moveCategory = (sid, catId, position) => set(ref(db, `servers/${sid}/categories/${catId}/position`), position);

/** Delete a category and un-categorize its channels in one update. */
export function deleteCategory(sid, catId, channelIds = []) {
  const up = { [`servers/${sid}/categories/${catId}`]: null };
  channelIds.forEach((cid) => {
    up[`servers/${sid}/channels/${cid}/cat`] = null;
  });
  return update(ref(db), up);
}

/** Put a channel in a category (catId) or back to uncategorized (null). */
export const setChannelCategory = (sid, cid, catId) =>
  catId ? set(ref(db, `servers/${sid}/channels/${cid}/cat`), catId) : remove(ref(db, `servers/${sid}/channels/${cid}/cat`));

/** Decrypted, sorted categories: [{ id, name, position }]. */
export function useCategories(sid) {
  const [raw, setRaw] = useState(null);
  const [names, setNames] = useState({});
  useEffect(() => {
    setRaw(null);
    if (!sid) return undefined;
    return onValue(ref(db, `servers/${sid}/categories`), (s) => setRaw(s.val() || {}), () => setRaw({}));
  }, [sid]);
  useEffect(() => {
    if (!raw) return undefined;
    let alive = true;
    Object.entries(raw).forEach(([id, c]) => {
      if (!c?.enc) return;
      const k = ck(sid, id, c.enc);
      if (plain.has(k)) return;
      getServerKey(sid)
        .then((key) => decryptJSON(key, c.enc, categoryAad(sid, id)))
        .then((v) => {
          plain.set(k, cleanCategoryName(v?.name) || 'category');
          if (alive) setNames((n) => ({ ...n }));
        })
        .catch(() => {
          plain.set(k, '(unreadable)');
          if (alive) setNames((n) => ({ ...n }));
        });
    });
    return () => {
      alive = false;
    };
  }, [sid, raw]);
  return useMemo(
    () =>
      Object.entries(raw || {})
        .filter(([, c]) => c && typeof c === 'object')
        .map(([id, c]) => ({ id, name: plain.get(ck(sid, id, c.enc)) ?? '…', position: typeof c.position === 'number' ? c.position : 0 }))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    [sid, raw, names], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/**
 * Pure grouping. channels: [{cid, cat?, position...}] already sorted; categories from useCategories.
 * Returns [{ id:null|catId, name:null|string, channels:[] }] — uncategorized first (if any), then each
 * category in order (empty categories included so they can be managed).
 */
export function groupByCategory(channels, categories) {
  const known = new Set(categories.map((c) => c.id));
  const loose = channels.filter((c) => !c.cat || !known.has(c.cat));
  const groups = categories.map((cat) => ({ id: cat.id, name: cat.name, channels: channels.filter((c) => c.cat === cat.id) }));
  return loose.length || !groups.length ? [{ id: null, name: null, channels: loose }, ...groups] : groups;
}

const COLLAPSE_KEY = 'codehub.collapsedCats';
export function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
export function saveCollapsed(map) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

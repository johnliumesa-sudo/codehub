// Add-on shop: official catalog (app admins) + community items (any signed-in user), wallet + daily
// coins, purchases, creator earnings, inventory, equip.
//
// Everything here is PLAINTEXT BY DESIGN (no E2EE): the catalog is public to signed-in users,
// `equipped/{uid}` is public so others can render your badge/name color, and `wallets/{uid}`,
// `inventory/{uid}` and `earnings/{uid}` are readable only by their owner. No real money is involved, ever.
// Every economic rule (claim interval, prices, balance, no double-buy, ownership before equip, earnings
// that never mint coins) is enforced by database.rules.json; the client only mirrors it for a friendly UI.
// See docs/features/shop.md.
//
// DB:
//   shop/items/{itemId}       { name, desc, kind, price, data, active, updatedAt, updatedBy, by?, createdAt? }
//   wallets/{uid}             { balance, lastClaim, lastItem?, lastEarn? }   (never deletable)
//   inventory/{uid}/{itemId}  { at, price }                                  (never deletable)
//   earnings/{creator}/{buyerUid}_{itemId}  { price, ts }                    (creator reads; collect deletes)
//   equipped/{uid}            { theme?, editorTheme?, badge?, nameColor?: itemId, ext?: {itemId: true} }
//   udata/{uid}/shop/last     id of the item being created (binds one item to one publishLog stamp)
//   udata/{uid}/shopSales/{earningKey}  { item, price, at }  collected sales (history for sales counts)
//   publishLog/{uid}          shared 60 s publish window (games and shop items)
import { useEffect, useMemo, useState } from 'react';
import { get, onValue, push, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { auth, db } from './firebase.js';
import { DEFAULT_CATALOG, ITEM_ID_RE, NAME_MAX, SLOTS, normalizeItem, sanitizeItemInput } from './addons/registry.js';
import { countCreatorItems, earningKey, earningsFrom, isPrice, parseEarningKey, salesFrom } from './addons/earnings.js';

export { countCreatorItems, earningKey, earningsFrom, parseEarningKey, salesFrom };

export const DAILY_COINS = 100;
export const CLAIM_INTERVAL_MS = 20 * 60 * 60 * 1000; // 72000000, same constant as the rules
/** Community items one creator may have (client cap: the rules can't count children). */
export const MAX_ITEMS_PER_CREATOR = 50;
/** One new item per minute per user: the rules' shared publishLog window (games use it too). */
export const CREATE_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------------------------
// Shared, ref-counted live values (one RTDB listener per path, however many components use it)
// ---------------------------------------------------------------------------------------------

const shared = new Map(); // path -> { loaded, value, error, listeners:Set, unsub, idleTimer }
const IDLE_MS = 30_000;

function dropShared(path, e) {
  if (shared.get(path) === e) shared.delete(path);
  clearTimeout(e.idleTimer);
  e.unsub?.();
  e.unsub = null;
}

function subscribeShared(path, fn) {
  let entry = shared.get(path);
  if (!entry) {
    const e = { loaded: false, value: null, error: null, listeners: new Set(), unsub: null, idleTimer: null };
    entry = e;
    shared.set(path, e);
    e.unsub = onValue(
      ref(db, path),
      (s) => {
        e.loaded = true;
        e.value = s.val();
        e.error = null;
        e.listeners.forEach((l) => l(e));
      },
      (error) => {
        // RTDB cancels a denied listener for good; forget it so a later subscriber retries.
        e.loaded = true;
        e.value = null;
        e.error = error;
        e.listeners.forEach((l) => l(e));
        dropShared(path, e);
      },
    );
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.listeners.add(fn);
  if (entry.loaded) fn(entry);
  const e = entry;
  return () => {
    e.listeners.delete(fn);
    if (e.listeners.size === 0 && shared.get(path) === e) {
      clearTimeout(e.idleTimer);
      e.idleTimer = setTimeout(() => {
        if (e.listeners.size === 0) dropShared(path, e);
      }, IDLE_MS);
    }
  };
}

const IDLE = { loading: false, value: null, error: null };

function useShared(path) {
  const [st, setSt] = useState(() => {
    const e = path && shared.get(path);
    return e && e.loaded ? { path, loading: false, value: e.value, error: e.error } : { path, loading: !!path, value: null, error: null };
  });
  useEffect(() => {
    if (!path) return undefined;
    return subscribeShared(path, (e) => setSt({ path, loading: false, value: e.value, error: e.error }));
  }, [path]);
  if (!path) return IDLE;
  if (st.path !== path) return { loading: true, value: null, error: null };
  return st;
}

/** Drop every shop listener (e.g. on sign-out). Live hooks resubscribe on their next mount. */
export function resetShopCache() {
  for (const [path, e] of [...shared]) dropShared(path, e);
}

// ---------------------------------------------------------------------------------------------
// Server clock (claims are timed by the server's `now`)
// ---------------------------------------------------------------------------------------------

let serverOffset = 0;
let offsetUnsub = null;
function watchOffset() {
  if (offsetUnsub) return;
  offsetUnsub = onValue(
    ref(db, '.info/serverTimeOffset'),
    (s) => { serverOffset = Number(s.val()) || 0; },
    () => { offsetUnsub = null; },
  );
}

export function serverNow() {
  watchOffset();
  return Date.now() + serverOffset;
}

/** Milliseconds until `wallet` may claim again (0 = now; also 0 when there's no wallet yet). */
export function msUntilClaim(wallet, now = serverNow()) {
  if (!wallet || typeof wallet.lastClaim !== 'number') return 0;
  return Math.max(0, wallet.lastClaim + CLAIM_INTERVAL_MS - now);
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const isDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e || ''));

function friendly(e, deniedMsg) {
  if (isDenied(e)) return new Error(deniedMsg);
  return e instanceof Error ? e : new Error(String(e));
}

function requireUid(uid) {
  const me = auth.currentUser?.uid;
  if (!uid || !me || uid !== me) throw new Error('You must be signed in');
  return uid;
}

// ---------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------

const catalogCache = new WeakMap(); // raw snapshot object -> { list, byId }
const EMPTY_CATALOG = { list: [], byId: {} };

// A creator's items beyond the cap (oldest first) are not listed, so a modified client that ignores the
// cap can't flood the shop. Official items are never capped.
function capPerCreator(list) {
  const seen = new Map();
  const out = [];
  for (const item of [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (item.by) {
      const n = (seen.get(item.by) || 0) + 1;
      seen.set(item.by, n);
      if (n > MAX_ITEMS_PER_CREATOR) continue;
    }
    out.push(item);
  }
  return out;
}

function catalogFrom(raw) {
  if (!raw || typeof raw !== 'object') return EMPTY_CATALOG;
  let c = catalogCache.get(raw);
  if (!c) {
    const list = capPerCreator(Object.entries(raw).map(([id, v]) => normalizeItem(id, v)).filter(Boolean))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.price - b.price || a.name.localeCompare(b.name));
    c = { list, byId: Object.fromEntries(list.map((i) => [i.id, i])) };
    catalogCache.set(raw, c);
  }
  return c;
}

/** Live catalog: { items: [item], byId: {id: item}, loading, error }. Includes inactive items. */
export function useCatalog() {
  const { loading, value, error } = useShared('shop/items');
  return useMemo(() => {
    const c = catalogFrom(value);
    return { items: c.list, byId: c.byId, loading, error };
  }, [value, loading, error]);
}

/**
 * My community items that exist in the database but don't pass the client checks any more (content policy,
 * readability, shape), so they never show in the shop. Listed in My items so their creator can delete them.
 * -> [{ id, name }]
 */
export function useCreatorHiddenItems(uid) {
  const { value } = useShared(uid ? 'shop/items' : null);
  const { byId } = useCatalog();
  return useMemo(() => {
    if (!uid || !value || typeof value !== 'object') return [];
    return Object.entries(value)
      .filter(([id, v]) => v && typeof v === 'object' && v.by === uid && !byId[id] && ITEM_ID_RE.test(id))
      .map(([id, v]) => ({ id, name: typeof v.name === 'string' ? v.name.slice(0, NAME_MAX) : '' }));
  }, [uid, value, byId]);
}

function itemRecord(clean) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('You must be signed in');
  return { ...clean, updatedAt: serverTimestamp(), updatedBy: uid };
}

/** Raw catalog value: the live shared copy when it is loaded, else one read. */
async function rawCatalog() {
  const e = shared.get('shop/items');
  if (e?.loaded && !e.error) return e.value || {};
  return (await get(ref(db, 'shop/items'))).val() || {};
}

/**
 * Save an existing item (any item for an app admin; your own community item for everyone else) or create
 * an official item (itemId = null, app admins only). Updates keep `by` and `createdAt`, which the rules make
 * immutable. `item` is the current normalized item when editing, so community items keep community limits.
 * Returns the item id.
 */
export async function saveItem(itemId, input, current = null) {
  if (itemId != null && !ITEM_ID_RE.test(itemId)) throw new Error('Invalid item id');
  const clean = sanitizeItemInput(current ? { ...input, kind: current.kind } : input, { creator: !!current?.by });
  try {
    if (itemId) {
      await update(ref(db, `shop/items/${itemId}`), itemRecord(clean));
      return itemId;
    }
    const id = push(ref(db, 'shop/items')).key;
    await set(ref(db, `shop/items/${id}`), { ...itemRecord(clean), createdAt: serverTimestamp() });
    return id;
  } catch (e) {
    throw friendly(e, current?.by ? 'You can only edit your own items. An item an app admin switched off can only be deleted' : 'Only app admins can edit the shop catalog');
  }
}

let lastCreateAt = 0;
/** Milliseconds until this tab may create another item (best effort; the rules have the final word). */
export function createCooldownLeft() {
  return Math.max(0, lastCreateAt + CREATE_COOLDOWN_MS - Date.now());
}

/**
 * Publish a community item. ONE update: the item (by = me, createdAt = now), publishLog/{me} = now (the
 * rules' one-publish-per-minute window, shared with games) and udata/{me}/shop/last = id (so one update
 * can only ever create one item). Goes live immediately. Returns the new id.
 */
export async function createItem(uid, input) {
  requireUid(uid);
  const clean = sanitizeItemInput(input, { creator: true });
  const wait = createCooldownLeft();
  if (wait > 0) throw new Error(`You can publish one item per minute. Try again in ${formatCountdown(wait)}`);
  let raw;
  try {
    raw = await rawCatalog();
  } catch (e) {
    throw friendly(e, 'You must be signed in to read the catalog');
  }
  if (countCreatorItems(raw, uid) >= MAX_ITEMS_PER_CREATOR) {
    throw new Error(`You already have ${MAX_ITEMS_PER_CREATOR} items. Delete one to publish another`);
  }
  const id = push(ref(db, 'shop/items')).key;
  try {
    await update(ref(db), {
      [`shop/items/${id}`]: { ...clean, by: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: uid },
      [`publishLog/${uid}`]: serverTimestamp(),
      [`udata/${uid}/shop/last`]: id,
    });
  } catch (e) {
    throw friendly(e, 'You can publish one item (or game) per minute. Wait a moment and try again');
  }
  lastCreateAt = Date.now();
  return id;
}

/** Activate / deactivate without touching anything else. */
export async function setItemActive(itemId, active) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('You must be signed in');
  try {
    await update(ref(db, `shop/items/${itemId}`), { active: !!active, updatedAt: serverTimestamp(), updatedBy: uid });
  } catch (e) {
    throw friendly(e, active ? 'Only an app admin can switch this item back on' : 'You can only change your own items');
  }
}

/** Permanently remove a catalog item. Owners keep their inventory entry; the add-on just stops applying. */
export async function deleteItem(itemId) {
  if (!ITEM_ID_RE.test(String(itemId || ''))) throw new Error('Invalid item id');
  try {
    await remove(ref(db, `shop/items/${itemId}`));
  } catch (e) {
    throw friendly(e, 'You can only delete your own items');
  }
}

/**
 * Write the bundled DEFAULT_CATALOG. Missing items are added; with `overwrite`, existing default
 * ids are reset to their bundled values too. One multi-path update. -> { added, updated, skipped }
 */
export async function seedDefaultCatalog({ overwrite = false } = {}) {
  let existing = {};
  try {
    existing = (await get(ref(db, 'shop/items'))).val() || {};
  } catch (e) {
    throw friendly(e, 'You must be signed in to read the catalog');
  }
  const updates = {};
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const def of DEFAULT_CATALOG) {
    const has = Object.prototype.hasOwnProperty.call(existing, def.id);
    if (has && !overwrite) {
      skipped += 1;
      continue;
    }
    const { id, ...rest } = def;
    const record = itemRecord(sanitizeItemInput({ ...rest, active: has ? existing[id]?.active !== false : true }));
    // Re-seeding keeps an existing item's createdAt (immutable in the rules); new ones get one.
    if (has) {
      for (const [k, v] of Object.entries(record)) updates[`shop/items/${id}/${k}`] = v;
    } else {
      updates[`shop/items/${id}`] = { ...record, createdAt: serverTimestamp() };
    }
    if (has) updated += 1;
    else added += 1;
  }
  if (Object.keys(updates).length) {
    try {
      await update(ref(db), updates);
    } catch (e) {
      throw friendly(e, 'Only app admins can seed the shop catalog');
    }
  }
  return { added, updated, skipped };
}

// ---------------------------------------------------------------------------------------------
// Wallet, inventory, equipped (live)
// ---------------------------------------------------------------------------------------------

/** { wallet: {balance,lastClaim,lastItem?} | null, loading, error } */
export function useWallet(uid) {
  const { loading, value, error } = useShared(uid ? `wallets/${uid}` : null);
  return useMemo(() => {
    const ok = value && typeof value.balance === 'number' && typeof value.lastClaim === 'number';
    return { wallet: ok ? value : null, loading, error };
  }, [value, loading, error]);
}

/** { inventory: { [itemId]: {at, price} }, loading, error } */
export function useInventory(uid) {
  const { loading, value, error } = useShared(uid ? `inventory/${uid}` : null);
  return useMemo(() => ({ inventory: value && typeof value === 'object' ? value : {}, loading, error }), [value, loading, error]);
}

const EMPTY_EQUIPPED = Object.freeze({});

/** { equipped: {theme?, editorTheme?, badge?, nameColor?, ext?}, loading, error } */
export function useEquipped(uid) {
  const { loading, value, error } = useShared(uid ? `equipped/${uid}` : null);
  return useMemo(() => ({ equipped: value && typeof value === 'object' ? value : EMPTY_EQUIPPED, loading, error }), [value, loading, error]);
}

/**
 * Another user's (or your own) visible cosmetics, resolved against the catalog.
 * -> { badgeGlyph?, badgeName?, nameColor? }  (unknown / wrong-kind / missing items are ignored)
 */
export function useCosmetics(uid) {
  const { equipped } = useEquipped(uid);
  const { byId } = useCatalog();
  const badgeId = typeof equipped.badge === 'string' ? equipped.badge : null;
  const colorId = typeof equipped.nameColor === 'string' ? equipped.nameColor : null;
  const badge = badgeId && byId[badgeId]?.kind === 'badge' ? byId[badgeId] : null;
  const color = colorId && byId[colorId]?.kind === 'nameColor' ? byId[colorId] : null;
  const badgeGlyph = badge?.data.glyph;
  const badgeName = badge?.name;
  const nameColor = color?.data.color;
  return useMemo(() => {
    const out = {};
    if (badgeGlyph) {
      out.badgeGlyph = badgeGlyph;
      out.badgeName = badgeName;
    }
    if (nameColor) out.nameColor = nameColor;
    return out;
  }, [badgeGlyph, badgeName, nameColor]);
}

// ---------------------------------------------------------------------------------------------
// Economy actions
// ---------------------------------------------------------------------------------------------

/**
 * Claim daily coins. First claim creates the wallet with 100; afterwards +100 at most every 20h.
 * Writes exactly { balance, lastClaim: serverTimestamp() } (lastItem is left untouched).
 * Returns the new balance.
 */
export async function claimDaily(uid) {
  requireUid(uid);
  const wRef = ref(db, `wallets/${uid}`);
  const cur = (await get(wRef)).val();
  const wallet = cur && typeof cur.balance === 'number' ? cur : null;
  const wait = msUntilClaim(wallet);
  if (wait > 0) throw new Error(`Next claim in ${formatCountdown(wait)}`);
  const balance = (wallet ? wallet.balance : 0) + DAILY_COINS;
  try {
    await update(wRef, { balance, lastClaim: serverTimestamp() });
  } catch (e) {
    throw friendly(e, 'Not yet. Your next daily claim isn\'t ready');
  }
  return balance;
}

/** Add a free (price 0) item to your inventory. Inventory-only write. */
export async function getFree(uid, item) {
  requireUid(uid);
  if (!item || item.price !== 0) throw new Error('This item is not free');
  if (!item.active) throw new Error('This item is no longer available');
  try {
    await set(ref(db, `inventory/${uid}/${item.id}`), { at: serverTimestamp(), price: 0 });
  } catch (e) {
    throw friendly(e, 'Couldn\'t add this item. You may already own it, or it changed');
  }
}

/**
 * Buy an item. Paid items are ONE atomic multi-path update:
 *   wallets/{uid}/balance = balance - price, wallets/{uid}/lastItem = itemId,
 *   inventory/{uid}/{itemId} = { at: serverTimestamp(), price }
 * plus, for someone else's community item, the creator's earning:
 *   earnings/{by}/{uid}_{itemId} = { price, ts: serverTimestamp() }
 * Free items go through getFree. No refunds. Buying your own item earns nothing.
 */
export async function buy(uid, item) {
  requireUid(uid);
  if (!item || !ITEM_ID_RE.test(String(item.id || ''))) throw new Error('Unknown item');
  if (!item.active) throw new Error('This item is no longer available');
  if (item.price === 0) return getFree(uid, item);
  const [wSnap, owned] = await Promise.all([get(ref(db, `wallets/${uid}`)), get(ref(db, `inventory/${uid}/${item.id}`))]);
  if (owned.exists()) throw new Error('You already own this');
  const wallet = wSnap.val();
  if (!wallet || typeof wallet.balance !== 'number') throw new Error('Claim your daily coins first to open a wallet');
  if (wallet.balance < item.price) throw new Error(`Not enough coins. You need ${item.price - wallet.balance} more`);
  const updates = {
    [`wallets/${uid}/balance`]: wallet.balance - item.price,
    [`wallets/${uid}/lastItem`]: item.id,
    [`inventory/${uid}/${item.id}`]: { at: serverTimestamp(), price: item.price },
  };
  if (item.by && item.by !== uid) updates[`earnings/${item.by}/${earningKey(uid, item.id)}`] = { price: item.price, ts: serverTimestamp() };
  try {
    await update(ref(db), updates);
  } catch (e) {
    throw friendly(e, 'Purchase rejected. The price may have changed or your balance moved; try again');
  }
}

/** Equip `itemId` into a single-choice slot, or unequip with null. Separate write from buying. */
export async function equip(uid, slot, itemId) {
  requireUid(uid);
  if (!SLOTS.includes(slot)) throw new Error('Unknown slot');
  if (itemId != null && !ITEM_ID_RE.test(itemId)) throw new Error('Invalid item id');
  try {
    await set(ref(db, `equipped/${uid}/${slot}`), itemId || null);
  } catch (e) {
    throw friendly(e, 'You can only equip items you own');
  }
}

/** Enable / disable an owned editor add-on. */
export async function toggleExt(uid, itemId, on) {
  requireUid(uid);
  if (!ITEM_ID_RE.test(String(itemId || ''))) throw new Error('Invalid item id');
  try {
    await set(ref(db, `equipped/${uid}/ext/${itemId}`), on ? true : null);
  } catch (e) {
    throw friendly(e, 'You can only enable add-ons you own');
  }
}

/** Unequip everything (back to the default look). Allowed by the rules: own `equipped` only. */
export async function unequipAll(uid) {
  requireUid(uid);
  await remove(ref(db, `equipped/${uid}`));
}

// ---------------------------------------------------------------------------------------------
// Creator earnings
// ---------------------------------------------------------------------------------------------

/** { entries: [{ key, buyer, itemId, price, ts }], total, loading, error } for my uncollected earnings. */
export function useEarnings(uid) {
  const { loading, value, error } = useShared(uid ? `earnings/${uid}` : null);
  return useMemo(() => {
    const entries = earningsFrom(value);
    return { entries, total: entries.reduce((n, e) => n + e.price, 0), loading, error };
  }, [value, loading, error]);
}

/** { byItem, count, total, loading } of my collected sales (kept in udata when collecting). */
export function useSalesHistory(uid) {
  const { loading, value } = useShared(uid ? `udata/${uid}/shopSales` : null);
  return useMemo(() => ({ ...salesFrom(value), loading }), [value, loading]);
}

/**
 * Collect ONE earning: ONE update that adds exactly its price to my balance, records `lastEarn`, deletes the
 * entry and keeps a history row in udata (sales counts). Re-reads and retries when the balance moved in
 * between (a claim or purchase in another tab). Resolves to the coins added (0 if it was already collected).
 */
export async function collectEarning(uid, key) {
  requireUid(uid);
  const k = parseEarningKey(key);
  if (!k) throw new Error('Unknown sale');
  for (let attempt = 0; ; attempt += 1) {
    const [wSnap, eSnap] = await Promise.all([get(ref(db, `wallets/${uid}`)), get(ref(db, `earnings/${uid}/${key}`))]);
    const entry = eSnap.val();
    if (!entry || !isPrice(entry.price)) return 0;
    const wallet = wSnap.val();
    if (!wallet || typeof wallet.balance !== 'number') throw new Error('Claim your starter coins first to open a wallet');
    try {
      await update(ref(db), {
        [`wallets/${uid}/balance`]: wallet.balance + entry.price,
        [`wallets/${uid}/lastEarn`]: key,
        [`earnings/${uid}/${key}`]: null,
        [`udata/${uid}/shopSales/${key}`]: { item: k.itemId, price: entry.price, at: serverTimestamp() },
      });
      return entry.price;
    } catch (e) {
      if (!isDenied(e) || attempt >= 2) throw friendly(e, 'Couldn\'t collect this sale. Try again');
    }
  }
}

/** "Collect all": one collect per entry, in sequence. -> { coins, collected }. Stops at the first error. */
export async function collectAll(uid, keys, onProgress) {
  let coins = 0;
  let collected = 0;
  for (const key of keys) {
    coins += await collectEarning(uid, key);
    collected += 1;
    onProgress?.(collected, keys.length);
  }
  return { coins, collected };
}

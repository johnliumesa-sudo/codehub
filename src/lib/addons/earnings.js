// Pure helpers for creator earnings (no Firebase import, unit-tested in tests/unit/shop.test.mjs).
//   earnings/{creator}/{buyerUid}_{itemId} = { price, ts }        uncollected sale
//   udata/{creator}/shopSales/{buyerUid}_{itemId} = { item, price, at }   collected sale (history)
import { ITEM_ID_RE, PRICE_MAX, UID_RE } from './registry.js';

/** `{buyerUid}_{itemId}`: uids never contain '_', so the first '_' splits it. */
export const earningKey = (buyer, itemId) => `${buyer}_${itemId}`;

/** -> { buyer, itemId } or null for a malformed key. */
export function parseEarningKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf('_');
  if (i <= 0) return null;
  const buyer = key.slice(0, i);
  const itemId = key.slice(i + 1);
  return UID_RE.test(buyer) && ITEM_ID_RE.test(itemId) ? { buyer, itemId } : null;
}

export const isPrice = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= PRICE_MAX;

/** Uncollected earnings from a raw `earnings/{uid}` value: newest first, malformed entries dropped. */
export function earningsFrom(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  for (const [key, v] of Object.entries(raw)) {
    const k = parseEarningKey(key);
    if (!k || !v || !isPrice(v.price)) continue;
    out.push({ key, ...k, price: v.price, ts: typeof v.ts === 'number' ? v.ts : 0 });
  }
  return out.sort((a, b) => b.ts - a.ts || a.key.localeCompare(b.key));
}

/** Collected sales history from a raw `udata/{uid}/shopSales` value -> { byItem: {id: count}, count, total }. */
export function salesFrom(raw) {
  const byItem = {};
  let count = 0;
  let total = 0;
  if (raw && typeof raw === 'object') {
    for (const v of Object.values(raw)) {
      if (!v || typeof v.item !== 'string' || !isPrice(v.price)) continue;
      byItem[v.item] = (byItem[v.item] || 0) + 1;
      count += 1;
      total += v.price;
    }
  }
  return { byItem, count, total };
}

/** Number of community items `uid` has in a raw `shop/items` value (hidden ones included). */
export function countCreatorItems(raw, uid) {
  if (!raw || typeof raw !== 'object') return 0;
  return Object.values(raw).filter((v) => v && typeof v === 'object' && v.by === uid).length;
}

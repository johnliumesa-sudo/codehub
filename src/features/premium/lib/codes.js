// Monthly premium codes: pure helpers (no Firebase), shared by the owner dashboard, the redeem form
// and the unit tests.
//
// premiumCodes/{YYYYMM} = { c, from, until }: one code per calendar month, valid from the first
// instant of that month (UTC) up to, not including, the first instant of the next month. The rules
// accept a redemption only inside that window, so codes rotate on their own.

/** Code alphabet without look-alikes (no 0/O, 1/I/L, 2/Z, 5/S, 8/B, U/V): 23 symbols. */
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTWXY34679';
export const CODE_GROUPS = 3;
export const CODE_GROUP_LEN = 4;
/** How many months "Generate codes" fills: this month and the next 11. */
export const GENERATE_MONTHS = 12;
/** Near a month boundary (either side), the redeem form also tries the neighbouring month. */
export const BOUNDARY_MS = 36 * 60 * 60 * 1000;

const MONTH_RE = /^(\d{4})(0[1-9]|1[0-2])$/;

function cryptoRandom(n) {
  const out = new Uint32Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * A fresh random code like `HXQ7-K4MW-TN3C` (12 symbols, ~54 bits). `random(n)` returns n random
 * uint32 values (crypto.getRandomValues by default); rejection sampling keeps every symbol uniform.
 */
export function generateCode(random = cryptoRandom) {
  const n = CODE_ALPHABET.length;
  const limit = Math.floor(2 ** 32 / n) * n;
  const chars = [];
  while (chars.length < CODE_GROUPS * CODE_GROUP_LEN) {
    for (const v of random(16)) {
      if (v >= limit) continue;
      chars.push(CODE_ALPHABET[v % n]);
      if (chars.length === CODE_GROUPS * CODE_GROUP_LEN) break;
    }
  }
  const groups = [];
  for (let i = 0; i < CODE_GROUPS; i++) groups.push(chars.slice(i * CODE_GROUP_LEN, (i + 1) * CODE_GROUP_LEN).join(''));
  return groups.join('-');
}

/** Whether `s` has the shape of a generated code. */
export function isCodeShape(s) {
  return typeof s === 'string' && new RegExp(`^[${CODE_ALPHABET}]{4}(-[${CODE_ALPHABET}]{4}){2}$`).test(s);
}

/**
 * What a member typed -> the string compared with the stored code. Generated codes are matched
 * case-insensitively and with or without dashes/spaces; anything else is sent trimmed, unchanged.
 */
export function normalizeCode(input) {
  const raw = String(input ?? '').trim();
  const compact = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (compact.length === CODE_GROUPS * CODE_GROUP_LEN && [...compact].every((c) => CODE_ALPHABET.includes(c))) {
    return compact.match(/.{4}/g).join('-');
  }
  return raw;
}

/** 'YYYYMM' (UTC) of a time in ms. */
export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function isMonthKey(key) {
  return typeof key === 'string' && MONTH_RE.test(key);
}

/** { from, until } in ms: the first instant of the month and of the next month (UTC). */
export function monthWindow(key) {
  const m = MONTH_RE.exec(key);
  if (!m) throw new Error(`Bad month key: ${key}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { from: Date.UTC(y, mo, 1), until: Date.UTC(y, mo + 1, 1) };
}

/** The month key `delta` months after `key` (negative goes back). */
export function addMonths(key, delta) {
  const { from } = monthWindow(key);
  const d = new Date(from);
  return monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}

/** `count` consecutive month keys starting at `key`. */
export function monthsFrom(key, count = GENERATE_MONTHS) {
  return Array.from({ length: count }, (_, i) => addMonths(key, i));
}

/** "November 2026" for a month key. */
export function monthLabel(key, locale) {
  const { from } = monthWindow(key);
  return new Date(from).toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Month keys the redeem form tries, most likely first: the month of `now` and, within BOUNDARY_MS of
 * either edge, the neighbouring month (the member's clock or the owner's may be off, or the code was
 * handed out just before the change).
 */
export function candidateMonths(now) {
  const cur = monthKey(now);
  const { from, until } = monthWindow(cur);
  const out = [cur];
  if (now - from < BOUNDARY_MS) out.push(addMonths(cur, -1));
  if (until - now < BOUNDARY_MS) out.push(addMonths(cur, 1));
  return out;
}

/**
 * The premiumCodes entries "Generate codes" adds: this month and the next 11 that have no code yet.
 * `existing` = the current premiumCodes value. -> { [monthKey]: { c, from, until } }
 */
export function planCodes(existing, now, random = cryptoRandom) {
  const have = existing && typeof existing === 'object' ? existing : {};
  const used = new Set(Object.values(have).map((v) => v?.c).filter(Boolean));
  const out = {};
  for (const key of monthsFrom(monthKey(now))) {
    if (typeof have[key]?.c === 'string') continue;
    let c = generateCode(random);
    while (used.has(c)) c = generateCode(random);
    used.add(c);
    out[key] = { c, ...monthWindow(key) };
  }
  return out;
}

/** A replacement for one month's code (old one stops working). */
export function replacementCode(key, existing, random = cryptoRandom) {
  const old = existing?.[key]?.c;
  let c = generateCode(random);
  while (c === old) c = generateCode(random);
  return { c, ...monthWindow(key) };
}

/** Rows for the dashboard, sorted by month: [{ key, c, from, until, state: 'past'|'current'|'future' }] */
export function codeRows(existing, now) {
  const have = existing && typeof existing === 'object' ? existing : {};
  return Object.entries(have)
    .filter(([key, v]) => isMonthKey(key) && v && typeof v.c === 'string')
    .map(([key, v]) => ({
      key,
      c: v.c,
      from: Number(v.from) || 0,
      until: Number(v.until) || 0,
      state: now >= v.until ? 'past' : now >= v.from ? 'current' : 'future',
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

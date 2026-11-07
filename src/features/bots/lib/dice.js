// Crypto-random numbers and dice for /roll, /flip and the {dice:NdM} / {random:a|b} placeholders.
// Pure (Web Crypto only), so the unit tests run it in Node.

export const DICE_LIMITS = Object.freeze({ maxDice: 100, minSides: 2, maxSides: 1000, maxMod: 1000 });
export const DEFAULT_DICE = '1d6';

/** One uniformly random 32-bit unsigned integer from the Web Crypto API. */
export function cryptoUint32() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0];
}

/**
 * Uniform integer in [0, max) without modulo bias (rejection sampling).
 * `u32` returns uniformly random 32-bit unsigned integers (injectable for tests).
 */
export function randomInt(max, u32 = cryptoUint32) {
  if (!Number.isInteger(max) || max < 1 || max > 2 ** 32) throw new RangeError('randomInt: max must be an integer in 1..2^32');
  if (max === 1) return 0;
  const limit = Math.floor(2 ** 32 / max) * max;
  for (;;) {
    const r = u32();
    if (r < limit) return r % max;
  }
}

/** A random element of a non-empty array (undefined for an empty one). */
export function pick(list, u32 = cryptoUint32) {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list[randomInt(list.length, u32)];
}

/**
 * Parse "NdM", "dM", "M" or "NdM+K" / "NdM-K" (whitespace ignored, case-insensitive).
 * Empty input means DEFAULT_DICE. Returns { n, sides, mod } or null when invalid or out of range.
 */
export function parseDice(spec) {
  const s = String(spec ?? '').replace(/\s+/g, '').toLowerCase() || DEFAULT_DICE;
  const m = /^(?:(\d{1,4})?d)?(\d{1,5})(?:([+-])(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const n = m[1] === undefined ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const mod = m[4] === undefined ? 0 : (m[3] === '-' ? -1 : 1) * Number(m[4]);
  const L = DICE_LIMITS;
  if (n < 1 || n > L.maxDice || sides < L.minSides || sides > L.maxSides || Math.abs(mod) > L.maxMod) return null;
  return { n, sides, mod };
}

/** Canonical label of a parsed spec: "2d6", "1d20+3". */
export function diceLabel({ n, sides, mod }) {
  return `${n}d${sides}${mod > 0 ? `+${mod}` : mod < 0 ? `-${-mod}` : ''}`;
}

/** Roll a spec string. Returns { n, sides, mod, rolls, total, label } or null when the spec is invalid. */
export function rollDice(spec, u32 = cryptoUint32) {
  const p = parseDice(spec);
  if (!p) return null;
  const rolls = [];
  for (let i = 0; i < p.n; i++) rolls.push(randomInt(p.sides, u32) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + p.mod;
  return { ...p, rolls, total, label: diceLabel(p) };
}

/** "rolled 2d6: 3 + 5 = 8", "rolled 1d20: 17", "rolled 2d6+3: 3 + 5 + 3 = 11". */
export function formatRoll(r) {
  const parts = r.rolls.map(String);
  if (r.mod) parts.push(r.mod > 0 ? `+ ${r.mod}` : `- ${-r.mod}`);
  const sum = parts.reduce((acc, p, i) => (i === 0 ? p : p.startsWith('+ ') || p.startsWith('- ') ? `${acc} ${p}` : `${acc} + ${p}`), '');
  if (r.rolls.length === 1 && !r.mod) return `rolled ${r.label}: ${r.total}`;
  return `rolled ${r.label}: ${sum} = ${r.total}`;
}

/** Heads or tails. */
export function flipCoin(u32 = cryptoUint32) {
  return randomInt(2, u32) === 0 ? 'Heads' : 'Tails';
}

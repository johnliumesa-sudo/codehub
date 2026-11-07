#!/usr/bin/env node
// Print database.rules.json minified for pasting into the Firebase console,
// which cuts pastes off at 100 KiB (102,400 bytes).
//   npm run -s rules:min | pbcopy
// Behaviour-preserving rewrites:
//   1. drop whitespace outside quoted strings and regex literals (.read/.write/.validate expressions),
//      except where two identifier characters or two operator characters would fuse into one token
//   2. merge .child() chains: .child('a').child($b) -> .child('a/'+$b)
//      (only literal, $variable and auth.uid segments, which can never hold '/' or be empty)
//   3. rename $wildcards to short names ($a, $b, ... most used first), as keys and inside
//      expressions, never inside quoted strings or regex literals. The mapping is global and
//      injective (same original name -> same short name everywhere), so every rule sees the same
//      variables under new names.
//   4. === -> == and !== -> != outside strings and regex literals. RTDB rules never coerce types:
//      both spellings are the same operator (tests/rules/ext.test.mjs probes this on the emulator
//      for every mix of strings, numbers, booleans and null).
// Check the output with: RULES_PATH=<file> npm run test:rules
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LIMIT = 102400;

const IDENT = /[A-Za-z0-9_$]/;
// Two operator characters that would read as one token if their whitespace went ("- -x", "a = = b").
const JOINS = new Set(['++', '--', '+=', '-=', '==', '!=', '<=', '>=', '&&', '||', '=>', '<<', '>>', '**', '//', '/*', '*/']);
const RULE_KEYS = new Set(['.read', '.write', '.validate']);
const VAR_CHAR = /[A-Za-z0-9_]/;

// Calls fn(kind, text) over an expression: 'str' (quoted string), 're' (regex literal), 'var' ($name)
// and 'ch' (any other single character). Regex literals only occur as matches(/.../), so a '/' right
// after '(' (whitespace allowed in between) starts one.
function scan(expr, fn) {
  let prev = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
      fn('str', expr.slice(i, j + 1));
      prev = c;
      i = j + 1;
      continue;
    }
    if (c === '/' && prev === '(') {
      let j = i + 1;
      let inClass = false;
      while (j < expr.length && (inClass || expr[j] !== '/')) {
        if (expr[j] === '\\') j++;
        else if (expr[j] === '[') inClass = true;
        else if (expr[j] === ']') inClass = false;
        j++;
      }
      j++;
      while (j < expr.length && /[a-z]/.test(expr[j])) j++;
      fn('re', expr.slice(i, j));
      prev = '/';
      i = j;
      continue;
    }
    if (c === '$' && !VAR_CHAR.test(expr[i - 1] || '') && VAR_CHAR.test(expr[i + 1] || '')) {
      let j = i + 1;
      while (j < expr.length && VAR_CHAR.test(expr[j])) j++;
      fn('var', expr.slice(i, j));
      prev = 'a';
      i = j;
      continue;
    }
    fn('ch', c);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
}

/** Drop whitespace outside quoted strings and regex literals. */
export function squeeze(expr) {
  let out = '';
  let pendingSpace = false;
  scan(expr, (kind, text) => {
    if (kind === 'ch' && /\s/.test(text)) {
      pendingSpace = true;
      return;
    }
    if (pendingSpace) {
      const a = out.slice(-1);
      const b = text[0];
      if ((IDENT.test(a) && IDENT.test(b)) || JOINS.has(a + b)) out += ' ';
      pendingSpace = false;
    }
    out += text;
  });
  return out;
}

const SEG = String.raw`'[A-Za-z0-9_-]+'|\$[A-Za-z0-9_]+|auth\.uid`;
const CHAIN = new RegExp(String.raw`(?:\.child\((?:${SEG})\)){2,}`, 'g');
const ONE = new RegExp(String.raw`\.child\((${SEG})\)`, 'g');

/** Merge .child() chains of literal, $variable and auth.uid segments. */
export function mergeChildren(expr) {
  return expr.replace(CHAIN, (chain) => {
    const parts = [];
    const lit = (text) => {
      const last = parts[parts.length - 1];
      if (last && last.lit) last.text += text;
      else parts.push({ lit: true, text });
    };
    [...chain.matchAll(ONE)].forEach((m, k) => {
      if (k > 0) lit('/');
      const seg = m[1];
      if (seg.startsWith("'")) lit(seg.slice(1, -1));
      else parts.push({ lit: false, text: seg });
    });
    return '.child(' + parts.map((p) => (p.lit ? `'${p.text}'` : p.text)).join('+') + ')';
  });
}

/** === -> == and !== -> != outside strings and regex literals. */
export function looseEq(expr) {
  let out = '';
  let code = '';
  const flush = () => {
    out += code.replace(/!==/g, '!=').replace(/===/g, '==');
    code = '';
  };
  scan(expr, (kind, text) => {
    if (kind === 'ch') {
      code += text;
      return;
    }
    flush();
    out += text;
  });
  flush();
  return out;
}

/** $name tokens of an expression (outside strings and regex literals). */
export function exprVars(expr) {
  const out = [];
  scan(expr, (kind, text) => {
    if (kind === 'var') out.push(text);
  });
  return out;
}

/** Replace the $name tokens found in `map` (outside strings and regex literals). */
export function renameVars(expr, map) {
  let out = '';
  scan(expr, (kind, text) => {
    out += kind === 'var' && map.has(text) ? map.get(text) : text;
  });
  return out;
}

function* shortNames() {
  const first = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of first) yield `$${a}`;
  for (const a of first) for (const b of `${first}0123456789_`) yield `$${a}${b}`;
}

/**
 * Map every $wildcard key to a short name: the names that save the most bytes get the shortest.
 * Injective, and a short name never equals a $name that is left unrenamed.
 */
export function wildcardMap(rules) {
  const weight = new Map();
  const keys = new Set();
  const used = new Set();
  const bump = (n) => weight.set(n, (weight.get(n) || 0) + n.length);
  (function visit(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) {
        keys.add(k);
        bump(k);
      }
      if (typeof v === 'string' && RULE_KEYS.has(k)) {
        for (const n of exprVars(v)) {
          used.add(n);
          bump(n);
        }
      } else {
        visit(v);
      }
    }
  })(rules);
  const keep = new Set([...used].filter((n) => !keys.has(n)));
  const order = [...keys].sort((a, b) => weight.get(b) - weight.get(a) || a.localeCompare(b));
  const gen = shortNames();
  const map = new Map();
  for (const name of order) {
    let next = gen.next();
    while (!next.done && keep.has(next.value)) next = gen.next();
    if (next.done) throw new Error('too many wildcards to rename');
    map.set(name, next.value);
  }
  return map;
}

function walk(node, map, loose) {
  if (Array.isArray(node)) return node.map((v) => walk(v, map, loose));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const key = map.has(k) ? map.get(k) : k;
      if (typeof v === 'string' && RULE_KEYS.has(k)) {
        const e = mergeChildren(renameVars(squeeze(v), map));
        out[key] = loose ? looseEq(e) : e;
      } else {
        out[key] = walk(v, map, loose);
      }
    }
    return out;
  }
  return node;
}

/**
 * Minified rules JSON text for a parsed rules object.
 * `rename: false` keeps the $wildcard names; `loose: false` keeps === / !==.
 */
export function minifyRules(rules, { rename = true, loose = true } = {}) {
  return JSON.stringify(walk(rules, rename ? wildcardMap(rules) : new Map(), loose));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2] || new URL('../database.rules.json', import.meta.url);
  const min = minifyRules(JSON.parse(readFileSync(src, 'utf8')));
  const bytes = Buffer.byteLength(min);
  process.stdout.write(min);
  process.stderr.write(
    `minified rules: ${bytes} bytes (console limit ${LIMIT})` +
      (bytes > LIMIT ? ' - TOO BIG to paste, deploy with the Firebase CLI\n' : '\n'),
  );
}

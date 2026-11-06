#!/usr/bin/env node
// Print database.rules.json minified for pasting into the Firebase console,
// which cuts pastes off at 100 KiB (102,400 bytes).
//   npm run -s rules:min | pbcopy
// Behaviour-preserving rewrites of .read/.write/.validate expressions:
//   1. drop whitespace outside quoted strings and regex literals
//   2. merge .child() chains: .child('a').child($b) -> .child('a/'+$b)
//      (only literal, $variable and auth.uid segments, which can never hold '/' or be empty)
// Check the output with: RULES_PATH=<file> npm run test:rules
import { readFileSync } from 'node:fs';

const src = process.argv[2] || new URL('../database.rules.json', import.meta.url);
const LIMIT = 102400;

const IDENT = /[A-Za-z0-9_$]/;
const OPS = /[-+!=<>&|]/;

function squeeze(expr) {
  let out = '';
  let prev = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
      out += expr.slice(i, j + 1);
      prev = c;
      i = j + 1;
      continue;
    }
    if (c === '/' && prev === '(') {
      // regex literal, e.g. matches(/^[0-5]$/)
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
      out += expr.slice(i, j);
      prev = '/';
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < expr.length && /\s/.test(expr[j])) j++;
      const a = out.slice(-1);
      const b = expr[j] ?? '';
      if ((IDENT.test(a) && IDENT.test(b)) || (OPS.test(a) && OPS.test(b))) out += ' ';
      i = j;
      continue;
    }
    out += c;
    prev = c;
    i++;
  }
  return out;
}

const SEG = String.raw`'[A-Za-z0-9_-]+'|\$[A-Za-z0-9_]+|auth\.uid`;
const CHAIN = new RegExp(String.raw`(?:\.child\((?:${SEG})\)){2,}`, 'g');
const ONE = new RegExp(String.raw`\.child\((${SEG})\)`, 'g');

function mergeChildren(expr) {
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

function walk(node) {
  if (Array.isArray(node)) return node.map(walk);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = typeof v === 'string' && (k === '.read' || k === '.write' || k === '.validate')
        ? mergeChildren(squeeze(v))
        : walk(v);
    }
    return out;
  }
  return node;
}

const min = JSON.stringify(walk(JSON.parse(readFileSync(src, 'utf8'))));
const bytes = Buffer.byteLength(min);
process.stdout.write(min);
process.stderr.write(
  `minified rules: ${bytes} bytes (console limit ${LIMIT})` +
    (bytes > LIMIT ? ' - TOO BIG to paste, deploy with the Firebase CLI\n' : '\n'),
);

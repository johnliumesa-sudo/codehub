// Premium: monthly code generation and month windows, the premium look validation, and the rules
// minifier's isString() guard drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOUNDARY_MS, CODE_ALPHABET, GENERATE_MONTHS, addMonths, candidateMonths, codeRows, generateCode, isCodeShape, isMonthKey,
  monthKey, monthWindow, monthsFrom, normalizeCode, planCodes, replacementCode,
} from '../../src/features/premium/lib/codes.js';
import { TAG_MAX, hasLook, lookRecord, normalizeLook, readableOn, tagProblem } from '../../src/features/premium/lib/lookCore.js';
import { dropStringGuards, minifyRules } from '../../scripts/minify-rules.mjs';

const H = 3600 * 1000;

test('codes: shape, alphabet without look-alikes, uniform symbols, crypto randomness', () => {
  for (const ch of '0O1IL2Z5S8BUV') assert.ok(!CODE_ALPHABET.includes(ch), ch);
  assert.equal(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length);
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const c = generateCode();
    assert.ok(isCodeShape(c), c);
    assert.match(c, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 300, 'no repeats');
  // Rejection sampling: values at or above the largest multiple of the alphabet size are skipped.
  const n = CODE_ALPHABET.length;
  const limit = Math.floor(2 ** 32 / n) * n;
  let calls = 0;
  const fake = (k) => {
    calls += 1;
    return Uint32Array.from({ length: k }, (_, i) => (calls === 1 && i % 2 === 0 ? limit + i : i));
  };
  const c = generateCode(fake);
  assert.ok(isCodeShape(c));
  assert.equal(c.replace(/-/g, '').slice(0, 2), CODE_ALPHABET[1] + CODE_ALPHABET[3]);
});

test('codes: what members type is normalized only for generated-code shapes', () => {
  assert.equal(normalizeCode(' hxq7 k4mw-tn3c '), 'HXQ7-K4MW-TN3C');
  assert.equal(normalizeCode('HXQ7K4MWTN3C'), 'HXQ7-K4MW-TN3C');
  assert.equal(normalizeCode('  Some-Other code '), 'Some-Other code');
  assert.equal(normalizeCode('hxq7-k4mw-tn3o'), 'hxq7-k4mw-tn3o', 'O is not in the alphabet: sent as typed');
  assert.equal(normalizeCode(''), '');
});

test('month windows: UTC boundaries, keys, adding months across years', () => {
  assert.equal(monthKey(Date.UTC(2026, 10, 7, 12)), '202611');
  assert.equal(monthKey(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), '202612');
  assert.equal(monthKey(Date.UTC(2027, 0, 1)), '202701');
  assert.deepEqual(monthWindow('202611'), { from: Date.UTC(2026, 10, 1), until: Date.UTC(2026, 11, 1) });
  assert.deepEqual(monthWindow('202612'), { from: Date.UTC(2026, 11, 1), until: Date.UTC(2027, 0, 1) });
  assert.equal(monthWindow('202602').until - monthWindow('202602').from, 28 * 24 * H);
  assert.equal(addMonths('202612', 1), '202701');
  assert.equal(addMonths('202601', -1), '202512');
  assert.equal(addMonths('202611', 11), '202710');
  assert.deepEqual(monthsFrom('202611', 3), ['202611', '202612', '202701']);
  assert.ok(isMonthKey('202611') && !isMonthKey('202613') && !isMonthKey('2026-11') && !isMonthKey(202611));
  assert.throws(() => monthWindow('nope'));
});

test('candidate months: the current month, plus the neighbour near a boundary', () => {
  assert.deepEqual(candidateMonths(Date.UTC(2026, 10, 15)), ['202611']);
  assert.deepEqual(candidateMonths(Date.UTC(2026, 10, 1, 3)), ['202611', '202610']);
  assert.deepEqual(candidateMonths(Date.UTC(2026, 11, 1) - 2 * H), ['202611', '202612']);
  assert.deepEqual(candidateMonths(Date.UTC(2027, 0, 1) - H), ['202612', '202701']);
  assert.deepEqual(candidateMonths(Date.UTC(2026, 10, 1) + BOUNDARY_MS + 1), ['202611']);
});

test('planCodes: this month and the next 11, skipping months that have a code, all distinct', () => {
  const now = Date.UTC(2026, 10, 7);
  const plan = planCodes({}, now);
  assert.deepEqual(Object.keys(plan), monthsFrom('202611', GENERATE_MONTHS));
  assert.equal(Object.keys(plan).length, 12);
  assert.equal(new Set(Object.values(plan).map((v) => v.c)).size, 12);
  for (const [k, v] of Object.entries(plan)) {
    assert.deepEqual({ from: v.from, until: v.until }, monthWindow(k));
    assert.ok(isCodeShape(v.c));
  }
  const existing = { 202611: { c: 'AAAA-AAAA-AAAA', ...monthWindow('202611') }, 202703: { c: 'CCCC-CCCC-CCCC', ...monthWindow('202703') } };
  const more = planCodes(existing, now);
  assert.equal(Object.keys(more).length, 10);
  assert.ok(!('202611' in more) && !('202703' in more));
  assert.deepEqual(planCodes({ ...existing, ...more }, now), {});
  // A month later the plan rolls forward by one.
  assert.deepEqual(Object.keys(planCodes({ ...existing, ...more }, Date.UTC(2026, 11, 2))), ['202711']);
});

test('replacementCode and codeRows', () => {
  const ex = { 202611: { c: 'AAAA-AAAA-AAAA', ...monthWindow('202611') } };
  const r = replacementCode('202611', ex);
  assert.notEqual(r.c, 'AAAA-AAAA-AAAA');
  assert.deepEqual({ from: r.from, until: r.until }, monthWindow('202611'));
  const rows = codeRows({ ...ex, 202612: { c: 'B', ...monthWindow('202612') }, 202610: { c: 'C', ...monthWindow('202610') }, junk: { c: 'x' } }, Date.UTC(2026, 10, 7));
  assert.deepEqual(rows.map((x) => [x.key, x.state]), [['202610', 'past'], ['202611', 'current'], ['202612', 'future']]);
});

test('premium look: normalization drops unknown values and unsafe tags', () => {
  const l = normalizeLook({ tag: '  🚀‮ Rust  ace ', tagA: '#FF0000', nameFx: 'glow', cardFx: 'fireworks', banner: 'aurora', frame: 'gradient', fxA: 'red' });
  assert.equal(l.tag, '🚀 Rust ace');
  assert.equal(l.tagA, '#ff0000');
  assert.equal(l.tagB, null);
  assert.equal(l.nameFx, 'glow');
  assert.equal(l.cardFx, 'none');
  assert.equal(l.fxA, '#8b5cf6');
  assert.ok(hasLook(l));
  assert.ok(!hasLook(normalizeLook(null)));
  assert.equal(normalizeLook({ tag: 'x'.repeat(TAG_MAX + 1) }).tag, '');
  assert.equal(normalizeLook({ tag: 'see https://evil.example' }).tag, '');
  assert.equal(normalizeLook({ tag: '<b>hi</b>' }).tag, '');
  assert.equal(normalizeLook({ tag: 42, nameFx: { x: 1 } }).tag, '');
  assert.equal(tagProblem('🦀'.repeat(TAG_MAX)), null, 'emoji count as one character each');
  assert.match(tagProblem('a'.repeat(TAG_MAX + 1)), /at most/);
});

test('premium look: the stored record has leaves only and passes normalization unchanged', () => {
  const rec = lookRecord({ tag: 'Core team', tagA: '#123456', tagB: '#abcdef', nameFx: 'rainbow', fxA: '#000000', fxB: '#ffffff', cardFx: 'snow', banner: 'starfield', frame: 'rainbow', extra: 'x' });
  assert.deepEqual(Object.keys(rec).sort(), ['banner', 'cardFx', 'frame', 'fxA', 'fxB', 'nameFx', 'tag', 'tagA', 'tagB']);
  for (const v of Object.values(rec)) assert.ok(typeof v === 'string' && v.length <= 2000);
  assert.deepEqual(normalizeLook(rec), { ...rec });
  assert.throws(() => lookRecord({ tag: 'x'.repeat(30) }), /at most/);
  assert.equal(readableOn('#ffffff'), '#111111');
  assert.equal(readableOn('#101010'), '#ffffff');
});

test('minifier: isString() guards go only from plain && chains in .validate', () => {
  assert.equal(dropStringGuards("newData.isString()&&newData.val().length<=8"), 'newData.val().length<=8');
  assert.equal(dropStringGuards("a&&newData.child('x').isString()&&newData.child('x').val().matches(/^a$/)&&b"), "a&&newData.child('x').val().matches(/^a$/)&&b");
  // Kept: a top-level || or ?:, a different subject, a guard not followed by .length/.matches, a negated guard.
  for (const e of [
    'newData.isString()&&newData.val().length<=8||newData.isNumber()',
    'c?newData.isString()&&newData.val().length<5:true',
    "newData.isString()&&newData.child('a').val().length<5",
    'newData.isString()&&newData.val()==\'x\'',
    '!newData.isString()&&newData.val().length<5',
    'newData.isString()',
  ]) assert.equal(dropStringGuards(e), e);
  // Inside parentheses an || doesn't matter, and strings/regexes never count.
  assert.equal(dropStringGuards("newData.isString()&&newData.val().matches(/^(a|b)?$/)&&(x||y)"), "newData.val().matches(/^(a|b)?$/)&&(x||y)");
  const rules = { rules: { a: { '.validate': 'newData.isString() && newData.val().length <= 8', '.write': 'newData.isString() && newData.val().length <= 8' } } };
  const min = JSON.parse(minifyRules(rules));
  assert.equal(min.rules.a['.validate'], 'newData.val().length<=8');
  assert.equal(min.rules.a['.write'], 'newData.isString()&&newData.val().length<=8', '.write rules keep their guards');
  assert.equal(JSON.parse(minifyRules(rules, { guards: false })).rules.a['.validate'], 'newData.isString()&&newData.val().length<=8');
});

// Round 3 shop workstream: community item validation, the editor-theme generator, earnings helpers and
// the client/rules contract (token keys, earning keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BASE_TOKENS,
  CREATOR_KINDS,
  DEFAULT_CATALOG,
  TOKEN_KEYS,
  findForbidden,
  normalizeItem,
  resolveEditorAddons,
  sanitizeItemInput,
  themeTokensProblem,
} from '../../src/lib/addons/registry.js';
import {
  BASE_EDITOR_TOKENS,
  EDITOR_TOKEN_KEYS,
  cleanEditorTokens,
  editorPalette,
  editorPreview,
  editorTokensProblem,
} from '../../src/lib/addons/editorPalette.js';
import { contrast, mix, withAlpha } from '../../src/lib/addons/color.js';
import { countCreatorItems, earningKey, earningsFrom, parseEarningKey, salesFrom } from '../../src/lib/addons/earnings.js';
import { editorThemeFromTokens } from '../../src/lib/addons/editorThemes.js';
import { extensionsForSpec } from '../../src/lib/addons/runtime.js';

const rules = JSON.parse(readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8')).rules;
const UID = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v'; // 28 chars, like Firebase Auth uids
const badge = { name: 'Fox', desc: 'A fox', kind: 'badge', price: 40, data: { glyph: '🦊' }, active: true };
const raw = (extra = {}) => ({ ...badge, updatedAt: 5, updatedBy: UID, by: UID, createdAt: 5, ...extra });

test('creator input: the four creator kinds pass, bundled modules are admin-only', () => {
  assert.deepEqual(CREATOR_KINDS, ['theme', 'editorTheme', 'badge', 'nameColor']);
  assert.equal(sanitizeItemInput(badge, { creator: true }).kind, 'badge');
  assert.ok(sanitizeItemInput({ ...badge, kind: 'nameColor', data: { color: '#FF00AA' } }, { creator: true }).data.color === '#ff00aa');
  assert.ok(sanitizeItemInput({ ...badge, kind: 'theme', data: { tokens: { accent: '#ff8800' } } }, { creator: true }));
  const ed = sanitizeItemInput({ ...badge, kind: 'editorTheme', data: { tokens: BASE_EDITOR_TOKENS } }, { creator: true });
  assert.deepEqual(Object.keys(ed.data.tokens), EDITOR_TOKEN_KEYS);
  assert.throws(() => sanitizeItemInput({ ...badge, kind: 'editorExt', data: { builtinId: 'line-wrap' } }, { creator: true }), /admins/);
  assert.throws(() => sanitizeItemInput({ ...badge, kind: 'editorTheme', data: { builtinId: 'one-dark' } }, { creator: true }), /admins/);
  // Admins may still publish bundled modules.
  assert.equal(sanitizeItemInput({ ...badge, kind: 'editorTheme', data: { builtinId: 'one-dark' } }).data.builtinId, 'one-dark');
});

test('creator input: content policy on create and edit (links, markup, code), price range', () => {
  for (const name of ['visit http://x.io', 'see example.com', '<b>hi</b>', 'a { color: red }', 'javascript:alert(1)']) {
    assert.throws(() => sanitizeItemInput({ ...badge, name }, { creator: true }));
  }
  assert.throws(() => sanitizeItemInput({ ...badge, desc: 'get it at www.shop' }, { creator: true }));
  assert.throws(() => sanitizeItemInput({ ...badge, data: { glyph: '<img>' } }, { creator: true }));
  for (const price of [-1, 10001, 1.5, NaN]) assert.throws(() => sanitizeItemInput({ ...badge, price }, { creator: true }), /Price/);
  assert.equal(sanitizeItemInput({ ...badge, price: '10000' }, { creator: true }).price, 10000);
});

test('readability: unreadable app and editor themes are rejected; the bundled catalog passes', () => {
  assert.equal(themeTokensProblem(BASE_TOKENS), null);
  assert.match(themeTokensProblem({ text: '#161a23' }), /contrast/);
  assert.throws(() => sanitizeItemInput({ ...badge, kind: 'theme', data: { tokens: { bg2: '#e6e9f0' } } }, { creator: true }), /contrast/);
  assert.equal(editorTokensProblem(BASE_EDITOR_TOKENS), null);
  assert.match(editorTokensProblem({ ...BASE_EDITOR_TOKENS, fg: '#2a2e36' }), /Foreground/);
  assert.match(editorTokensProblem({ ...BASE_EDITOR_TOKENS, kw: '#282c34' }), /Keyword/);
  assert.match(editorTokensProblem({ ...BASE_EDITOR_TOKENS, sel: '#abb2bf' }), /Selected text/);
  for (const def of DEFAULT_CATALOG) assert.doesNotThrow(() => sanitizeItemInput(def), def.id);
});

test('render-time checks: community items that break the policy never render', () => {
  const ok = normalizeItem('-abc', raw());
  assert.equal(ok.by, UID);
  assert.equal(ok.official, false);
  assert.equal(ok.createdAt, 5);
  assert.equal(normalizeItem('-abc', raw({ name: 'buy at evil.com' })), null);
  assert.equal(normalizeItem('-abc', raw({ desc: '<script>' })), null);
  assert.equal(normalizeItem('-abc', raw({ kind: 'editorExt', data: { builtinId: 'line-wrap' } })), null);
  assert.equal(normalizeItem('-abc', raw({ kind: 'editorTheme', data: { builtinId: 'one-dark' } })), null);
  assert.equal(normalizeItem('-abc', raw({ kind: 'theme', data: { tokens: { text: '#161a23' } } })), null);
  assert.equal(normalizeItem('-abc', raw({ by: 'bad_uid' })), null);
  assert.equal(normalizeItem('-abc', raw({ by: 42 })), null);
  // Official items (no `by`) keep working exactly as before.
  const official = normalizeItem('badge-star', { ...badge, updatedAt: 1, updatedBy: 'admin' });
  assert.equal(official.official, true);
  assert.equal(official.by, null);
  assert.equal(official.createdAt, 0);
});

test('admin take-down is visible to the client: inactive + last written by someone else', () => {
  assert.equal(normalizeItem('-a', raw({ active: false, updatedBy: 'admin1' })).heldByAdmin, true);
  assert.equal(normalizeItem('-a', raw({ active: false })).heldByAdmin, false);
  assert.equal(normalizeItem('-a', raw({ active: true, updatedBy: 'admin1' })).heldByAdmin, false);
});

test('editor theme generator: tokens -> CodeMirror palette, preview and extension', () => {
  assert.equal(cleanEditorTokens({ ...BASE_EDITOR_TOKENS, op: undefined }), null);
  assert.equal(cleanEditorTokens({ ...BASE_EDITOR_TOKENS, op: 'red' }), null);
  assert.equal(cleanEditorTokens({ ...BASE_EDITOR_TOKENS, extra: '#000000' }).extra, undefined);
  const p = editorPalette(cleanEditorTokens(BASE_EDITOR_TOKENS));
  assert.equal(p.dark, true);
  assert.equal(p.bg, '#282c34');
  assert.equal(p.keyword, '#c678dd');
  assert.equal(p.cursor, '#528bff');
  for (const v of Object.values(p)) if (typeof v === 'string') assert.match(v, /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/);
  const light = editorPalette({ ...BASE_EDITOR_TOKENS, bg: '#fafafa', fg: '#222222', sel: '#cce0ff' });
  assert.equal(light.dark, false);
  assert.deepEqual(Object.keys(editorPreview(BASE_EDITOR_TOKENS)).sort(), ['bg', 'caret', 'comment', 'fg', 'fn', 'gutter', 'keyword', 'number', 'op', 'sel', 'string', 'type']);
  const ext = editorThemeFromTokens(BASE_EDITOR_TOKENS);
  assert.ok(Array.isArray(ext) && ext.length === 2);
  assert.equal(editorThemeFromTokens({ ...BASE_EDITOR_TOKENS }), ext, 'cached by value');
  assert.equal(editorThemeFromTokens({ bg: '#000000' }), null);
  assert.equal(extensionsForSpec({ theme: null, palette: BASE_EDITOR_TOKENS, exts: [] })[0], ext);
});

test('equipped token editor theme resolves to a palette for the runtime', () => {
  const item = normalizeItem('-ed', raw({ kind: 'editorTheme', data: { tokens: BASE_EDITOR_TOKENS } }));
  assert.equal(item.supported, true);
  const spec = resolveEditorAddons({ editorTheme: '-ed' }, { '-ed': item });
  assert.equal(spec.theme, null);
  assert.deepEqual(spec.palette, BASE_EDITOR_TOKENS);
  const bundled = normalizeItem('etheme-one', { ...badge, kind: 'editorTheme', data: { builtinId: 'solarized-dark' }, updatedAt: 1, updatedBy: 'a' });
  assert.deepEqual(resolveEditorAddons({ editorTheme: 'etheme-one' }, { 'etheme-one': bundled }), { theme: 'solarized-dark', palette: null, exts: [] });
});

test('color helpers', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#123456', '#123456'), 1);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(withAlpha('#ff0000', 0.25), 'rgba(255, 0, 0, 0.25)');
});

test('earning keys: {buyer}_{item} round-trips; malformed keys and entries are dropped', () => {
  const key = earningKey(UID, '-Nabc_def-123');
  assert.deepEqual(parseEarningKey(key), { buyer: UID, itemId: '-Nabc_def-123' });
  assert.equal(parseEarningKey('_x'), null);
  assert.equal(parseEarningKey('nounderscore'), null);
  assert.equal(parseEarningKey(`${UID}_`), null);
  assert.equal(parseEarningKey(`${UID}_bad/id`), null);
  const list = earningsFrom({
    [earningKey(UID, '-a')]: { price: 30, ts: 1 },
    [earningKey(UID, '-b')]: { price: 10, ts: 9 },
    bad: { price: 5, ts: 3 },
    [earningKey(UID, '-c')]: { price: -4, ts: 2 },
    [earningKey(UID, '-d')]: { price: 1.5, ts: 2 },
  });
  assert.deepEqual(list.map((e) => [e.itemId, e.price]), [['-b', 10], ['-a', 30]]);
  const s = salesFrom({ k1: { item: '-a', price: 30, at: 1 }, k2: { item: '-a', price: 30, at: 2 }, k3: { item: '-b', price: 5, at: 3 }, k4: { item: 7, price: 1 } });
  assert.deepEqual(s, { byItem: { '-a': 2, '-b': 1 }, count: 3, total: 65 });
  assert.equal(countCreatorItems({ x: { by: UID }, y: { by: 'other' }, z: null, w: { by: UID } }, UID), 2);
});

test('contract with the rules: token keys, earnings shape, creator ids', () => {
  const tokenRe = rules.shop.items.$itemId.data.tokens.$k['.validate'];
  const m = /matches\(\/\^\(([^)]*)\)\$\/\)/.exec(tokenRe);
  assert.ok(m, 'token key pattern not found');
  assert.deepEqual(m[1].split('|').sort(), [...TOKEN_KEYS, ...EDITOR_TOKEN_KEYS].sort());
  const earn = rules.earnings.$creator.$key;
  assert.match(earn['.write'], /\$key === auth\.uid \+ '_' \+ \$key\.replace\(auth\.uid \+ '_', ''\)/);
  assert.match(earn.$f['.validate'], /'price'.*'ts'/);
  assert.match(rules.shop.items.$itemId['.write'], /\$itemId\.beginsWith\('-'\)/);
  assert.match(rules.shop.items.$itemId['.write'], /udata\/' \+ auth\.uid \+ '\/shop\/last/);
  // Push ids start with '-' (until the year 2109), which the rules require of creator item ids.
  assert.ok(findForbidden('-Nabc') === null);
});

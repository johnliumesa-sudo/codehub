// Personal features (round 3): status, favorites, server folders, notes and appearance helpers, and
// the appearance boot script in index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  CLEAR_AFTER, STATUS_TEXT_MAX, cleanEmoji, cleanStatusText, clearAfterUntil, effectivePresence, normalizeMode,
  presenceToWrite, readCustomStatus,
} from '../../src/features/personal/lib/statusCore.js';
import { FAV_MAX, favConv, favKey, favRecord, moveItem, nextPos, parseFavorites, positionsPatch } from '../../src/features/personal/lib/favoritesCore.js';
import { cleanColor, cleanFolderName, parseFolders, parseSids, planMove, planTake, railLayout, sidsString } from '../../src/features/personal/lib/foldersCore.js';
import { NOTE_MAX, cleanNote, noteAad } from '../../src/features/personal/lib/notesCore.js';
import {
  APPEARANCE_BOOT_SNIPPET, appearanceAttrs, applyAppearanceTo, cleanAppearance, clockOptions, formatClock, sameAppearance,
} from '../../src/features/personal/lib/appearanceCore.js';

const UA = 'u'.repeat(28);
const UB = 'v'.repeat(28);
const SID = '-NabcdefghijklmnopQ';
const CID = '-NzyxwvutsrqponmlkJ';

// ---------- status ----------

test('status modes: unknown values fall back to online; what this tab writes per mode', () => {
  assert.equal(normalizeMode('dnd'), 'dnd');
  assert.equal(normalizeMode('invisible'), 'invisible');
  assert.equal(normalizeMode('busy'), 'online');
  assert.equal(normalizeMode(undefined), 'online');
  assert.equal(presenceToWrite('invisible', 'online'), 'offline');
  assert.equal(presenceToWrite('idle', 'online'), 'idle');
  assert.equal(presenceToWrite('dnd', 'idle'), 'idle');
  assert.equal(presenceToWrite('dnd', 'online'), 'online');
  assert.equal(presenceToWrite('online', 'idle'), 'idle');
});

test('effective presence: offline wins (closed tab or invisible), DND shows while around', () => {
  assert.equal(effectivePresence('online', null), 'online');
  assert.equal(effectivePresence('idle', { mode: 'dnd' }), 'dnd');
  assert.equal(effectivePresence('online', { mode: 'dnd', text: 'x' }), 'dnd');
  assert.equal(effectivePresence('offline', { mode: 'dnd' }), 'offline');
  assert.equal(effectivePresence(undefined, { mode: 'dnd' }), 'offline');
  assert.equal(effectivePresence('online', { mode: 'invisible' }), 'online'); // only 'dnd' is ever public
  assert.equal(effectivePresence('garbage', null), 'offline');
});

test('clear after: durations, today = next local midnight, never = 0', () => {
  const now = new Date(2026, 4, 10, 15, 20).getTime();
  assert.equal(clearAfterUntil('30m', now), now + 30 * 60_000);
  assert.equal(clearAfterUntil('1h', now), now + 3_600_000);
  assert.equal(clearAfterUntil('4h', now), now + 4 * 3_600_000);
  assert.equal(clearAfterUntil('today', now), new Date(2026, 4, 11, 0, 0).getTime());
  assert.equal(clearAfterUntil('never', now), 0);
  assert.equal(clearAfterUntil('bogus', now), 0);
  assert.deepEqual(CLEAR_AFTER.map((o) => o.id), ['30m', '1h', '4h', 'today', 'never']);
});

test('status text: one line, control and bidi characters removed, 80 characters without splitting emoji', () => {
  assert.equal(cleanStatusText('  in a\nmeeting\t '), 'in a meeting');
  assert.equal(cleanStatusText('a\u202eb\u200bc\u0007'), 'abc');
  assert.equal(cleanStatusText(42), '');
  const long = '🙂'.repeat(STATUS_TEXT_MAX + 10);
  const out = cleanStatusText(long);
  assert.equal(Array.from(out).length, STATUS_TEXT_MAX);
  assert.ok(!out.includes('\ud83d\ud83d'));
  assert.equal(cleanStatusText('x'.repeat(200)).length, STATUS_TEXT_MAX);
});

test('status emoji: the first grapheme only if it is an emoji', () => {
  assert.equal(cleanEmoji('💻'), '💻');
  assert.equal(cleanEmoji('💻🔥'), '💻');
  assert.equal(cleanEmoji('👩‍💻 coding'), '👩‍💻');
  assert.equal(cleanEmoji('🇯🇵'), '🇯🇵');
  assert.equal(cleanEmoji('1️⃣'), '1️⃣');
  assert.equal(cleanEmoji('hello'), '');
  assert.equal(cleanEmoji('<b>'), '');
  assert.equal(cleanEmoji(null), '');
});

test('reading a public status record treats it as untrusted and hides expired ones', () => {
  const now = 1_000_000;
  assert.deepEqual(readCustomStatus({ emoji: '💻', text: ' Coding ', until: now + 5 }, now), { emoji: '💻', text: 'Coding', until: now + 5 });
  assert.equal(readCustomStatus({ emoji: '💻', text: 'Coding', until: now - 1 }, now), null);
  assert.equal(readCustomStatus({ mode: 'dnd' }, now), null);
  assert.equal(readCustomStatus({ emoji: 'not emoji', text: { evil: 1 } }, now), null);
  assert.deepEqual(readCustomStatus({ text: 'x'.repeat(500), until: 'soon' }, now), { emoji: '', text: 'x'.repeat(80), until: 0 });
  assert.equal(readCustomStatus('string', now), null);
});

// ---------- favorites ----------

test('favorite keys come from conversation ids only, and invalid ids are rejected', () => {
  assert.equal(favKey({ kind: 'channel', sid: SID, cid: CID }), `c_${SID}_${CID}`);
  assert.equal(favKey({ kind: 'dm', dmId: `${UA}_${UB}` }), `d_${UA}_${UB}`);
  assert.equal(favKey({ kind: 'group', gid: SID }), `g_${SID}`);
  assert.equal(favKey({ kind: 'channel', sid: 'a/b', cid: CID }), null);
  assert.equal(favKey({ kind: 'dm', dmId: 'nounderscore' }), null);
  assert.equal(favKey({ kind: 'codespace', csid: SID }), null);
  assert.equal(favKey(null), null);
  assert.ok(favKey({ kind: 'dm', dmId: `${UA}_${UB}` }).length <= 128);
});

test('favorites parse in position order, drop records that do not match their key', () => {
  const raw = {
    [`g_${SID}`]: favRecord({ kind: 'group', gid: SID }, 2),
    [`c_${SID}_${CID}`]: favRecord({ kind: 'channel', sid: SID, cid: CID }, 0),
    [`d_${UA}_${UB}`]: favRecord({ kind: 'dm', dmId: `${UA}_${UB}` }, 1),
    [`c_${SID}_other`]: { kind: 'channel', sid: SID, cid: CID, pos: 0 }, // key/ids mismatch
    junk: 'x',
  };
  const list = parseFavorites(raw);
  assert.deepEqual(list.map((f) => f.kind), ['channel', 'dm', 'group']);
  assert.deepEqual(favConv(list[0]), { kind: 'channel', sid: SID, cid: CID });
  assert.equal(nextPos(list), 3);
  assert.equal(nextPos([]), 0);
  assert.deepEqual(parseFavorites(null), []);
  assert.equal(FAV_MAX, 50);
});

test('reordering favorites renumbers only the positions that change', () => {
  const keys = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(keys, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(keys, 0, 9), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveItem(keys, 1, -4), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveItem(keys, 7, 0), keys);
  const patch = positionsPatch('udata/me/favorites', ['b', 'a', 'c', 'd'], { a: 0, b: 1, c: 2, d: 3 });
  assert.deepEqual(patch, { 'udata/me/favorites/b/pos': 0, 'udata/me/favorites/a/pos': 1 });
});

// ---------- server folders ----------

const srv = (...sids) => sids.map((sid, i) => ({ sid, joinedAt: i + 1 }));

test('folder ids lists and fields are validated', () => {
  assert.deepEqual(parseSids('a,b,,a,c/d,e'), ['a', 'b', 'e']);
  assert.equal(sidsString(['a', 'b', 'a', 'x/y']), 'a,b');
  assert.equal(cleanColor('#ABCDEF'), '#abcdef');
  assert.equal(cleanColor('red'), '#5b8cff');
  assert.equal(cleanFolderName('  Work \n stuff\u202e '), 'Work stuff');
  assert.equal(Array.from(cleanFolderName('x'.repeat(50))).length, 32);
  const f = parseFolders({ f2: { sids: 'b', color: '#00ff00', at: 2, iv: 'i', ct: 'c', collapsed: true }, f1: { sids: 'a,c', at: 1 }, 'bad/id': { sids: 'a' } });
  assert.deepEqual(f.map((x) => x.id), ['f1', 'f2']);
  assert.deepEqual(f[1], { id: 'f2', color: '#00ff00', sids: ['b'], collapsed: true, at: 2, box: { iv: 'i', ct: 'c' } });
  assert.equal(f[0].box, null);
});

test('rail layout: a folder sits where its first server would be; left servers and empty folders vanish', () => {
  const folders = parseFolders({
    f1: { sids: 'd,b', at: 1 },
    f2: { sids: 'b,zz', at: 2 }, // b already in f1; zz was left: f2 is empty
  });
  const items = railLayout(srv('a', 'b', 'c', 'd', 'e'), folders);
  assert.deepEqual(items.map((i) => (i.type === 'server' ? i.sid : `[${i.folder.id}:${i.sids.join(',')}]`)), ['a', '[f1:d,b]', 'c', 'e']);
  assert.deepEqual(railLayout(srv('a'), []), [{ type: 'server', sid: 'a' }]);
});

test('moving servers between folders: insert before, take out, empty folders are deleted', () => {
  const folders = parseFolders({ f1: { sids: 'a,b', at: 1 }, f2: { sids: 'c', at: 2 } });
  assert.deepEqual(planMove(folders, 'c', 'f1', 'b'), { f1: ['a', 'c', 'b'], f2: null });
  assert.deepEqual(planMove(folders, 'a', 'f2'), { f1: ['b'], f2: ['c', 'a'] });
  assert.deepEqual(planMove(folders, 'b', null), { f1: ['a'] });
  assert.deepEqual(planMove(folders, 'x', null), {});
  assert.deepEqual(planMove(folders, 'b', 'f1', 'a'), { f1: ['b', 'a'] });
  assert.deepEqual(planMove(folders, 'a', 'f1'), { f1: ['b', 'a'] }); // to the end
  assert.deepEqual(planTake(folders, ['a', 'c']), { f1: ['b'], f2: null });
});

// ---------- notes ----------

test('private notes: AAD binds owner and subject, text is cleaned and capped', () => {
  assert.equal(noteAad(UA, UB), `unote:${UA}/${UB}`);
  assert.equal(cleanNote('  line 1\r\nline 2\u0007\u202e  '), 'line 1\nline 2');
  assert.equal(Array.from(cleanNote('é'.repeat(NOTE_MAX + 5))).length, NOTE_MAX);
  assert.equal(cleanNote(null), '');
});

// ---------- appearance ----------

test('appearance settings are validated; out-of-range font sizes fall back to 100 %', () => {
  assert.deepEqual(cleanAppearance(null), { density: 'cozy', font: 100, reduceMotion: false, focusRings: false, chatWidth: 'full', clock: 'auto' });
  assert.deepEqual(cleanAppearance({ density: 'compact', font: '115', reduceMotion: true, focusRings: 'yes', chatWidth: 'narrow', clock: '24', extra: 1 }),
    { density: 'compact', font: 115, reduceMotion: true, focusRings: false, chatWidth: 'narrow', clock: '24' });
  assert.equal(cleanAppearance({ font: 200 }).font, 100);
  assert.equal(cleanAppearance({ font: 89 }).font, 100);
  assert.equal(cleanAppearance({ font: 129.6 }).font, 130);
  assert.ok(sameAppearance({ font: 100 }, {}));
  assert.ok(!sameAppearance({ font: 110 }, {}));
});

test('12/24-hour clock options', () => {
  assert.deepEqual(clockOptions('24'), { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
  assert.deepEqual(clockOptions('12'), { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
  assert.deepEqual(clockOptions('auto'), { hour: 'numeric', minute: '2-digit' });
  const ts = new Date(2026, 0, 1, 14, 5).getTime();
  assert.equal(formatClock(ts, '24', 'en-US'), '14:05');
  assert.match(formatClock(ts, '12', 'en-GB'), /^2:05\s?pm$/i);
  assert.equal(formatClock('x', '24'), '');
});

/** Run the boot snippet in a fake document; returns what it set. */
function boot(stored, { reduce = false, throws = false } = {}) {
  const classes = new Set();
  const attrs = {};
  const vars = {};
  const ctx = {
    JSON,
    Math,
    String,
    localStorage: { getItem: (k) => { if (throws) throw new Error('blocked'); return k === 'codehub.appearance' ? stored : null; } },
    matchMedia: (q) => ({ matches: reduce && q.includes('reduced-motion') }),
    document: {
      documentElement: {
        classList: { add: (c) => classes.add(c) },
        setAttribute: (k, v) => { attrs[k] = v; },
        style: { setProperty: (k, v) => { vars[k] = v; } },
      },
    },
  };
  vm.runInNewContext(APPEARANCE_BOOT_SNIPPET, ctx);
  return { classes: [...classes].sort(), attrs, vars };
}

function expected(stored, reduce = false) {
  let parsed = null;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = null;
  }
  const a = appearanceAttrs(parsed, reduce);
  return {
    classes: Object.entries(a.classes).filter(([, on]) => on).map(([c]) => c).sort(),
    attrs: Object.fromEntries(Object.entries(a.attrs).filter(([, v]) => v !== null)),
    vars: Object.fromEntries(Object.entries(a.vars).filter(([, v]) => v !== null)),
  };
}

test('index.html inlines APPEARANCE_BOOT_SNIPPET verbatim in <head>, after the theme script', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const at = head.indexOf(`<script>${APPEARANCE_BOOT_SNIPPET}</script>`);
  assert.ok(at > 0);
  assert.ok(head.indexOf("localStorage.getItem('codehub.theme')") < at);
});

test('boot snippet applies exactly what the app applies (no flash, no mismatch)', () => {
  const cases = [
    null,
    '{}',
    'not json',
    'null',
    JSON.stringify({ density: 'compact', font: 120, reduceMotion: true, focusRings: true, chatWidth: 'medium', clock: '24' }),
    JSON.stringify({ density: 'cozy', font: 100, chatWidth: 'full', clock: 'auto' }),
    JSON.stringify({ font: 90, chatWidth: 'wide', clock: '12' }),
    JSON.stringify({ font: 131, chatWidth: 'huge', clock: '13', density: 'tiny', reduceMotion: 'yes' }),
  ];
  for (const stored of cases) {
    for (const reduce of [false, true]) {
      assert.deepEqual(boot(stored, { reduce }), expected(stored, reduce), `stored=${stored} reduce=${reduce}`);
    }
  }
  assert.deepEqual(boot('{}', { throws: true }), { classes: [], attrs: {}, vars: {} });
});

test('applyAppearanceTo toggles classes, variables and attributes both ways', () => {
  const classes = new Set(['ap-compact', 'other']);
  const attrs = { 'data-ap-width': 'narrow' };
  const vars = { '--ap-font-scale': '1.2' };
  const el = {
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    style: { setProperty: (k, v) => { vars[k] = v; }, removeProperty: (k) => { delete vars[k]; } },
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  };
  applyAppearanceTo(el, { font: 110, clock: '12' });
  assert.deepEqual([...classes].sort(), ['ap-font', 'other']);
  assert.deepEqual(vars, { '--ap-font-scale': '1.1' });
  assert.deepEqual(attrs, { 'data-ap-clock': '12' });
  applyAppearanceTo(el, {}, true);
  assert.deepEqual([...classes].sort(), ['ap-reduce-motion', 'other']);
  assert.deepEqual(vars, {});
  assert.deepEqual(attrs, {});
});

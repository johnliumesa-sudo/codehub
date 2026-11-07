// Round 3 foundation: extension registries, the send pipeline and slash commands, the rules minifier
// (wildcard renaming, == rewrite, whitespace) and the test port blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { _resetRegistries, get, list, register, subscribe, unregister } from '../../src/lib/ext/registry.js';
import {
  CORE_BODY_KEYS, SLASH_GROUPS, commandGroup, commandsFor, draftToBody, helpCommand, matchCommands, parseSlash, pickExtras, runSendHooks, slashHook,
} from '../../src/lib/ext/send.js';
import { exprVars, looseEq, minifyRules, renameVars, squeeze, wildcardMap } from '../../scripts/minify-rules.mjs';
import { portsFor, portBase } from '../../scripts/test-ports.mjs';

test('registry: order, then registration order; replace by id; unregister removes only its own entry', () => {
  _resetRegistries();
  const seen = [];
  const unsub = subscribe('messageActions', (l) => seen.push(l.map((e) => e.id)));
  const offA = register('messageActions', { id: 'a', label: 'A' });
  register('messageActions', { id: 'b', label: 'B', order: -1 });
  register('messageActions', { id: 'c', label: 'C', order: 5 });
  register('messageActions', { id: 'd', label: 'D' });
  assert.deepEqual(list('messageActions').map((e) => e.id), ['b', 'a', 'd', 'c']);
  const snap = list('messageActions');
  assert.equal(list('messageActions'), snap, 'snapshot identity is stable without changes');
  assert.ok(Object.isFrozen(snap));

  register('messageActions', { id: 'a', label: 'A2' }); // replaces in place, keeps its slot
  assert.deepEqual(list('messageActions').map((e) => `${e.id}:${e.label}`), ['b:B', 'a:A2', 'd:D', 'c:C']);
  offA(); // the replaced registration's unregister must not remove the replacement
  assert.equal(get('messageActions', 'a').label, 'A2');
  assert.equal(unregister('messageActions', 'a'), true);
  assert.equal(unregister('messageActions', 'a'), false);
  assert.equal(get('messageActions', 'a'), null);
  unsub();
  register('messageActions', { id: 'e', label: 'E' });
  assert.equal(seen.length, 6, 'listener ran once per change until unsubscribed');
  assert.throws(() => register('messageActions', { label: 'no id' }), /id/);
  assert.throws(() => register('bad name!', { id: 'x' }), /registry name/);
  // slash commands may use `name` as their id
  register('slashCommands', { name: 'roll', run: () => ({ handled: true }) });
  assert.equal(get('slashCommands', 'roll').name, 'roll');
  _resetRegistries();
  assert.deepEqual(list('messageActions'), []);
});

test('send pipeline: drafts flow through, handled/cancel stop it, errors and junk cancel', async () => {
  const seen = [];
  const hooks = [
    { id: 'h1', run: (d) => ({ ...d, text: `${d.text}!`, extra: { ...(d.extra || {}), bot: { id: 'b' } } }) },
    { id: 'h2', run: async (d, ctx) => { seen.push([d.text, ctx.tag]); return d; } },
    { id: 'h3', run: () => undefined }, // unchanged
  ];
  const r = await runSendHooks({ text: 'hi' }, { tag: 't' }, hooks);
  assert.equal(r.draft.text, 'hi!');
  assert.deepEqual(seen, [['hi!', 't']]);
  assert.deepEqual(draftToBody(r.draft), { text: 'hi!', bot: { id: 'b' } });

  assert.deepEqual(await runSendHooks({ text: 'x' }, {}, [{ id: 'a', run: () => ({ handled: true }) }, { id: 'b', run: () => { throw new Error('not reached'); } }]), { handled: true });
  assert.deepEqual(await runSendHooks({ text: 'x' }, {}, [{ id: 'a', run: () => ({ cancel: true, reason: 'nope' }) }]), { cancel: true, reason: 'nope' });
  const thrown = await runSendHooks({ text: 'x' }, {}, [{ id: 'boom', run: () => { throw new Error('kaput'); } }]);
  assert.deepEqual(thrown, { cancel: true, reason: 'kaput' });
  const junk = await runSendHooks({ text: 'x' }, {}, [{ id: 'junk', run: () => 42 }]);
  assert.equal(junk.cancel, true);
  const noText = await runSendHooks({ text: 'x' }, {}, [{ id: 'nt', run: () => ({ code: {} }) }]);
  assert.equal(noText.cancel, true);
});

test('body extras: only extension keys, never core keys, nothing unserialisable', () => {
  const extra = { bot: { id: 'b', name: 'Bot' }, text: 'override', poll: { q: 'x' }, __proto_x: 1, 'bad-key': 1, Upper: 1, fn: () => 1, nil: null, ok2: 0 };
  assert.deepEqual(pickExtras(extra), { bot: { id: 'b', name: 'Bot' }, ok2: 0 });
  assert.deepEqual(draftToBody({ text: 'hi', attachments: [1], extra }), { text: 'hi', attachments: [1], bot: { id: 'b', name: 'Bot' }, ok2: 0 });
  for (const k of CORE_BODY_KEYS) assert.equal(k in pickExtras({ [k]: 1 }), false);
});

test('slash commands: parsing, matching by scope, running through the first hook', async () => {
  assert.deepEqual(parseSlash('/Roll 2d6 + 1'), { name: 'roll', args: '2d6 + 1' });
  assert.deepEqual(parseSlash('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseSlash('/ask what is\nthis?'), { name: 'ask', args: 'what is\nthis?' });
  assert.equal(parseSlash('hello /help'), null);
  assert.equal(parseSlash('/'), null);
  assert.equal(parseSlash('//not'), null);

  const cmds = [
    { id: 'roll', name: 'roll', description: 'Roll dice', run: (a) => ({ text: `rolled ${a}` }) },
    { id: 'remind', name: 'remind', scopes: ['channel'], run: () => ({ handled: true }) },
    { id: 'dup', name: 'roll', run: () => ({ text: 'second roll' }) },
    { id: 'bad', name: 'Bad Name', run: () => null },
    { id: 'help', ...helpCommand },
  ];
  assert.deepEqual(commandsFor('dm', cmds).map((c) => c.id), ['roll', 'help']);
  assert.deepEqual(commandsFor('channel', cmds).map((c) => c.id), ['roll', 'remind', 'help']);
  assert.deepEqual(matchCommands('re', 'channel', cmds).map((c) => c.name), ['remind']);
  assert.deepEqual(matchCommands('', 'group', cmds).map((c) => c.name), ['roll', 'help']);
  assert.deepEqual(matchCommands('el', 'group', cmds).map((c) => c.name), ['help'], 'substring matches come after prefixes');

  // Every match is returned (no cap), grouped built-in -> features -> server bots; within a group,
  // prefix matches before substring matches, otherwise registration order.
  const many = [
    { name: 'zbot', group: 'bot', run: () => null },
    { name: 'ask', run: () => null },
    { name: 'help', group: 'builtin', run: () => null },
    ...Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, group: 'nonsense', run: () => null })),
    { name: 'shrug', group: 'builtin', run: () => null },
    { name: 'shout', run: () => null },
    { name: 'fish', group: 'bot', run: () => null },
  ];
  const all = matchCommands('', 'channel', many);
  assert.equal(all.length, many.length);
  assert.deepEqual(all.map(commandGroup), [...Array(2).fill('builtin'), ...Array(14).fill('feature'), ...Array(2).fill('bot')]);
  assert.deepEqual(all.slice(0, 3).map((c) => c.name), ['help', 'shrug', 'ask']);
  assert.deepEqual(matchCommands('sh', 'channel', many).map((c) => c.name), ['shrug', 'shout', 'fish']);
  assert.deepEqual(matchCommands('f1', 'channel', many).map((c) => c.name), ['f1', 'f10', 'f11']);
  assert.deepEqual(SLASH_GROUPS.map((g) => g.id), ['builtin', 'feature', 'bot']);

  _resetRegistries();
  for (const c of cmds) register('slashCommands', c);
  const ctx = { conv: { kind: 'dm' } };
  const rolled = await slashHook.run({ text: '/roll 3', extra: { a: 1 } }, ctx);
  assert.deepEqual(rolled, { text: 'rolled 3', extra: { a: 1 } });
  assert.deepEqual(await slashHook.run({ text: '/remind me' }, ctx), { text: '/remind me' }, 'out-of-scope command sends as text');
  assert.deepEqual(await slashHook.run({ text: '/unknown thing' }, ctx), { text: '/unknown thing' }, 'unknown /word sends as text');
  assert.deepEqual(await slashHook.run({ text: 'plain' }, ctx), { text: 'plain' });
  const notes = [];
  assert.deepEqual(await slashHook.run({ text: '/help' }, { ...ctx, ephemeral: (e) => notes.push(e) }), { handled: true });
  assert.equal(notes[0].title, 'Slash commands');
  assert.deepEqual(notes[0].items.map((i) => i.label), ['/roll', '/help']);
  _resetRegistries();
});

test('minifier: wildcard names are renamed injectively, in keys and expressions, never in strings or regexes', () => {
  const rules = { rules: {
    things: { $thingId: {
      '.read': "root.child('owners').child($thingId).val() === auth.uid && $thingId.matches(/^\\$thingId$/)",
      $userId: { '.validate': "newData.val() === '$userId' || $userId === $thingId" },
      $f: { '.validate': '$f.length <= 64' },
    } },
    other: { $userId: { '.write': '$userId === auth.uid' } },
  } };
  const map = wildcardMap(rules);
  assert.equal(new Set(map.values()).size, map.size, 'injective');
  assert.deepEqual([...map.keys()].sort(), ['$f', '$thingId', '$userId']);
  for (const v of map.values()) assert.match(v, /^\$[A-Za-z][A-Za-z0-9_]?$/);
  const min = JSON.parse(minifyRules(rules));
  const t = map.get('$thingId');
  const u = map.get('$userId');
  const node = min.rules.things[t];
  assert.equal(node['.read'], `root.child('owners/'+${t}).val()==auth.uid&&${t}.matches(/^\\$thingId$/)`);
  assert.equal(node[u]['.validate'], `newData.val()=='$userId'||${u}==${t}`);
  assert.equal(min.rules.other[u]['.write'], `${u}==auth.uid`, 'same name -> same short name everywhere');
  assert.deepEqual(exprVars("$a + '$b' + $c.matches(/$d/)"), ['$a', '$c']);
  assert.equal(renameVars("$ab+'$ab'+$abc", new Map([['$ab', '$x']])), "$x+'$ab'+$abc");
});

test('minifier: == rewrite and whitespace never touch strings/regexes or fuse operators', () => {
  assert.equal(looseEq("a === 'x === y' && b !== c && d.matches(/^===$/)"), "a == 'x === y' && b != c && d.matches(/^===$/)");
  assert.equal(squeeze('a - -1 > 0 && ! b || !c'), 'a- -1>0&&!b||!c');
  assert.equal(squeeze("x === 'a  b' && y.matches( /^a b$/ )"), "x==='a  b'&&y.matches(/^a b$/)");
  assert.equal(squeeze('a = = b'), 'a= =b');
  assert.equal(squeeze('auth != null'), 'auth!=null');
  assert.equal(squeeze('newData.val() > now - 60000'), 'newData.val()>now-60000');
});

test('minifier: the real rules keep their structure and fit the console limit', () => {
  const src = JSON.parse(readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8'));
  const min = JSON.parse(minifyRules(src));
  const map = wildcardMap(src);
  // Same tree shape with every $wildcard key renamed through the map, and nothing else renamed.
  const shape = (n, rename) => (n && typeof n === 'object' && !Array.isArray(n)
    ? Object.fromEntries(Object.entries(n).map(([k, v]) => [rename && map.has(k) ? map.get(k) : k, typeof v === 'string' ? 's' : shape(v, rename)]))
    : typeof n);
  assert.deepEqual(shape(min, false), shape(src, true));
  assert.ok(Buffer.byteLength(JSON.stringify(min)) <= 102400, 'minified rules must paste into the console');
  assert.ok(!JSON.stringify(min).includes('==='), 'no === left');
});

test('test port blocks: default keeps the historical ports; other bases are disjoint blocks', () => {
  assert.equal(portBase({}), 9000);
  assert.deepEqual(portsFor(9000), { base: 9000, database: 9000, auth: 9099, vite: 5199, hub: 4400, logging: 4500 });
  const seen = new Set(Object.values(portsFor(9000)).slice(1));
  for (let b = 9100; b <= 9700; b += 100) {
    const p = portsFor(b);
    assert.equal(portBase({ CODEHUB_PORT_BASE: String(b) }), b);
    for (const port of [p.database, p.auth, p.vite, p.hub, p.logging]) {
      assert.ok(!seen.has(port), `port ${port} reused`);
      seen.add(port);
    }
  }
  assert.throws(() => portBase({ CODEHUB_PORT_BASE: 'abc' }));
});

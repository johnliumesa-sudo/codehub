// Bots (round 3): dice, the template language and its escaping, definition validation, keyword
// triggers, the built-in slash commands and the trigger-reply queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICE_LIMITS, diceLabel, flipCoin, formatRoll, parseDice, pick, randomInt, rollDice } from '../../src/features/bots/lib/dice.js';
import { escapeMarkdown, guardLeadingSlash, mentionFor, MAX_OUTPUT, renderTemplate, splitArgs, usesCount } from '../../src/features/bots/lib/template.js';
import {
  BOT_LIMITS, cleanBotTag, cleanCmd, cleanImg, emptyDef, newTriggerId, parseBotDef, parseBotEntry, parseInstalled, serializeBotDef, validateBotDef,
} from '../../src/features/bots/lib/schema.js';
import { answeredRecently, findTrigger, matchesTrigger, stripCode, triggerRegex } from '../../src/features/bots/lib/triggers.js';
import { BUILTIN_COMMANDS, meText, RESERVED_NAMES, rollText, SHRUG, spoilerText } from '../../src/features/bots/lib/builtins.js';
import { closeTool, peekTool } from '../../src/features/bots/lib/toolbus.js';
import { clearPending, onPending, PENDING_TTL, pendingCount, queueReply, takeReady } from '../../src/features/bots/lib/pending.js';
import { commandsFor, parseSlash, runSendHooks, slashHook } from '../../src/lib/ext/send.js';
import { _resetRegistries, register } from '../../src/lib/ext/registry.js';

/** A deterministic u32 source cycling through `values`. */
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

// ---------- dice ----------

test('randomInt is unbiased (rejection sampling) and in range', () => {
  // max = 3: limit = floor(2^32 / 3) * 3 = 4294967295; the value 4294967295 must be rejected.
  assert.equal(randomInt(3, seq(4294967295, 7)), 1);
  assert.equal(randomInt(1, seq(123)), 0);
  for (let i = 0; i < 2000; i++) {
    const r = randomInt(6);
    assert.ok(Number.isInteger(r) && r >= 0 && r < 6);
  }
  assert.throws(() => randomInt(0), RangeError);
  assert.throws(() => randomInt(1.5), RangeError);
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(randomInt(4));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  assert.equal(pick(['a', 'b', 'c'], seq(4)), 'b');
  assert.equal(pick([], seq(1)), undefined);
});

test('parseDice accepts NdM, dM, M, modifiers and the default; rejects out-of-range specs', () => {
  assert.deepEqual(parseDice(''), { n: 1, sides: 6, mod: 0 });
  assert.deepEqual(parseDice('2d6'), { n: 2, sides: 6, mod: 0 });
  assert.deepEqual(parseDice(' 3 D 20 + 4 '), { n: 3, sides: 20, mod: 4 });
  assert.deepEqual(parseDice('d20'), { n: 1, sides: 20, mod: 0 });
  assert.deepEqual(parseDice('20'), { n: 1, sides: 20, mod: 0 });
  assert.deepEqual(parseDice('1d8-2'), { n: 1, sides: 8, mod: -2 });
  for (const bad of ['0d6', '101d6', '1d1', '1d1001', '2d6+1001', 'abc', '2d', 'd', '1d6d6', '-1d6', '2d6*3']) {
    assert.equal(parseDice(bad), null, bad);
  }
  assert.equal(parseDice(`${DICE_LIMITS.maxDice}d${DICE_LIMITS.maxSides}`).n, 100);
  assert.equal(diceLabel({ n: 2, sides: 6, mod: 3 }), '2d6+3');
  assert.equal(diceLabel({ n: 1, sides: 20, mod: -1 }), '1d20-1');
});

test('rollDice / formatRoll: "rolled 2d6: 3 + 5 = 8"', () => {
  // randomInt(6) of u32 v is v % 6 (for v below the rejection limit): 2 -> 3, 4 -> 5
  const r = rollDice('2d6', seq(2, 4));
  assert.deepEqual(r.rolls, [3, 5]);
  assert.equal(r.total, 8);
  assert.equal(formatRoll(r), 'rolled 2d6: 3 + 5 = 8');
  assert.equal(formatRoll(rollDice('d20', seq(16))), 'rolled 1d20: 17');
  assert.equal(formatRoll(rollDice('2d6+3', seq(2, 4))), 'rolled 2d6+3: 3 + 5 + 3 = 11');
  assert.equal(formatRoll(rollDice('1d6-2', seq(0))), 'rolled 1d6-2: 1 - 2 = -1');
  assert.equal(rollDice('nope'), null);
  for (let i = 0; i < 200; i++) {
    const x = rollDice('3d4');
    assert.equal(x.rolls.length, 3);
    assert.ok(x.rolls.every((v) => v >= 1 && v <= 4));
    assert.equal(x.total, x.rolls.reduce((a, b) => a + b, 0));
  }
  assert.equal(flipCoin(seq(0)), 'Heads');
  assert.equal(flipCoin(seq(1)), 'Tails');
});

// ---------- template ----------

test('escapeMarkdown neutralises markdown, spoilers, shortcodes, mentions, HTML and block markers', () => {
  assert.equal(escapeMarkdown('**bold** _it_ `code` ~~s~~'), '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\~\\~s\\~\\~');
  assert.equal(escapeMarkdown('[x](http://e.test)'), '\\[x\\](http://e.test)');
  assert.equal(escapeMarkdown('||secret||'), '\\|\\|secret\\|\\|');
  assert.equal(escapeMarkdown('hi @everyone :smile:'), 'hi \\@everyone \\:smile:');
  assert.equal(escapeMarkdown('<img src=x onerror=alert(1)>'), '\\<img src=x onerror=alert(1)\\>');
  assert.equal(escapeMarkdown('# Title'), '\\# Title');
  assert.equal(escapeMarkdown('> quote'), '\\> quote');
  assert.equal(escapeMarkdown('- item'), '\\- item');
  assert.equal(escapeMarkdown('1. first'), '1\\. first');
  assert.equal(escapeMarkdown('a\\b'), 'a\\\\b');
  assert.equal(escapeMarkdown('  multi\n\nline\ttext  '), 'multi line text');
  assert.equal(escapeMarkdown('time: 5 o\'clock, mail@host'), 'time: 5 o\'clock, mail\\@host');
  assert.equal(escapeMarkdown(null), '');
  assert.equal(escapeMarkdown('nul\u0000char'), 'nulchar');
});

test('mentionFor / splitArgs / guardLeadingSlash', () => {
  assert.equal(mentionFor('Ada Lovelace'), '@AdaLovelace');
  assert.equal(mentionFor('dev.ops'), '@dev.ops');
  assert.equal(mentionFor('*star*'), '\\*star\\*');
  assert.deepEqual(splitArgs('one "two three" four'), ['one', 'two three', 'four']);
  assert.deepEqual(splitArgs('  '), []);
  assert.equal(guardLeadingSlash('/shrug'), '\\/shrug');
  assert.equal(guardLeadingSlash('  /x'), '\\/x');
  assert.equal(guardLeadingSlash('a /b'), 'a /b');
});

test('renderTemplate substitutes every placeholder in one pass, escaping what members typed', () => {
  const now = new Date(2026, 10, 6, 9, 5);
  const vars = { user: 'Ada *L*', channel: 'gen_eral', server: 'My <Server>', args: 'alpha "beta gamma" @everyone', count: 7, now, locale: 'en-US' };
  const out = renderTemplate('{user}|{mention}|#{channel}|{server}|{args}|{arg1}/{arg2}/{arg3}/{arg9}|{count}|{date}|{time}', vars);
  // {mention} of a name that can't be a mention token falls back to the escaped name.
  assert.equal(out, 'Ada \\*L\\*|Ada \\*L\\*|#gen\\_eral|My \\<Server\\>|alpha "beta gamma" \\@everyone|alpha/beta gamma/\\@everyone/|7|Nov 6, 2026|9\\:05 AM');
  assert.equal(renderTemplate('Hi {mention}', { user: 'Ada Lovelace' }), 'Hi @AdaLovelace');
  // {random} and {dice} use the injected random source; unknown placeholders stay.
  assert.equal(renderTemplate('{random:a|b|c} {dice:2d6} {unknown} {dice:bad}', {}, { u32: seq(1, 2, 4) }), 'b 8 {unknown} {dice:bad}');
  // Single pass: typed placeholders are not expanded.
  assert.equal(renderTemplate('You said {args}', { args: '{user} {random:x|y}' }), 'You said {user} {random\\:x\\|y}');
  // Output never starts with "/" (it would run as a command) and is capped.
  assert.equal(renderTemplate('/shrug {args}', { args: 'x' }), '\\/shrug x');
  assert.equal(renderTemplate('{args}', { args: '/help' }), '\\/help');
  const long = renderTemplate('x'.repeat(5000));
  assert.equal(long.length, MAX_OUTPUT);
  assert.ok(long.endsWith('…'));
  assert.equal(renderTemplate('   '), '');
  assert.equal(usesCount('n={count}'), true);
  assert.equal(usesCount('n'), false);
});

// ---------- schema ----------

const goodDef = () => ({
  v: 1,
  name: ' Helper ',
  glyph: '🛠️',
  desc: 'Says hi',
  commands: [{ name: '/Hello', usage: '<name>', desc: 'Greets', response: 'Hello {mention}! {args}' }],
  triggers: [{ id: 'k1', match: 'good   morning', response: 'Morning {user}', cooldown: 60 }],
  welcome: 'Welcome {user}',
  extra: 'dropped',
});

test('validateBotDef normalises a good definition and drops unknown keys', () => {
  const r = validateBotDef(goodDef());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.def.name, 'Helper');
  assert.equal(r.def.commands[0].name, 'hello');
  assert.equal(r.def.triggers[0].match, 'good morning');
  assert.equal(r.def.extra, undefined);
  const again = parseBotDef(serializeBotDef(r.def));
  assert.deepEqual(again.def, r.def);
  assert.deepEqual(validateBotDef({ ...emptyDef(), name: 'W', welcome: 'hi' }).ok, true);
});

test('validateBotDef rejects malformed and oversized definitions', () => {
  const bad = (patch, re) => {
    const r = validateBotDef({ ...goodDef(), ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch).slice(0, 80));
    if (re) assert.match(r.errors.join(' | '), re);
  };
  bad({ v: 2 }, /version/);
  bad({ name: '' }, /Name is required/);
  bad({ name: 'x'.repeat(BOT_LIMITS.name + 1) }, /Name is too long/);
  bad({ name: 'bad\nname' }, /control/);
  bad({ name: 42 }, /Name must be text/);
  bad({ glyph: 'x'.repeat(17) }, /Icon/);
  bad({ desc: 'x'.repeat(301) }, /Description/);
  bad({ commands: 'nope' }, /list/);
  bad({ commands: [{ name: 'Bad Name', response: 'x' }] }, /name must be/);
  bad({ commands: [{ name: 'a', response: 'x' }, { name: 'a', response: 'y' }] }, /twice/);
  bad({ commands: [{ name: 'a', response: '' }] }, /response is required/);
  bad({ commands: [{ name: 'a', response: 'x'.repeat(BOT_LIMITS.response + 1) }] }, /too long/);
  bad({ commands: Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, response: 'x' })) }, /At most 20 commands/);
  bad({ triggers: [{ id: 'k1', match: 'x', response: 'y', cooldown: 1 }] }, /cooldown/);
  bad({ triggers: [{ id: 'k1', match: 'x', response: 'y', cooldown: 7.5 }] }, /cooldown/);
  bad({ triggers: [{ id: 'BAD!', match: 'x', response: 'y', cooldown: 60 }] }, /invalid id/);
  bad({ triggers: [{ id: 'k1', match: 'x', response: 'y', cooldown: 60 }, { id: 'k1', match: 'z', response: 'y', cooldown: 60 }] }, /invalid id/);
  bad({ triggers: [{ id: 'k1', match: '', response: 'y', cooldown: 60 }] }, /phrase is required/);
  bad({ commands: [], triggers: [], welcome: '' }, /at least one/);
  assert.equal(validateBotDef(null).ok, false);
  assert.equal(validateBotDef([]).ok, false);
  // reserved names (the builder passes the built-ins)
  const r = validateBotDef({ ...goodDef(), commands: [{ name: 'roll', response: 'x' }] }, { reserved: RESERVED_NAMES });
  assert.match(r.errors.join(' '), /built-in/);
  // total size: 20 commands with long responses exceed one 20000-character leaf
  const big = validateBotDef({
    ...goodDef(),
    commands: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, desc: 'd', response: 'x'.repeat(1500) })),
  });
  assert.equal(big.ok, false);
  assert.match(big.errors[0], /too large/);
});

test('parseBotDef / parseBotEntry / parseInstalled never trust stored data', () => {
  assert.equal(parseBotDef('{').ok, false);
  assert.equal(parseBotDef('x'.repeat(20001)).ok, false);
  assert.equal(parseBotDef(42).ok, false);
  assert.equal(parseBotDef('null').ok, false);
  const def = validateBotDef(goodDef()).def;
  const json = serializeBotDef(def);
  const e = parseBotEntry('-Nabc_1', { def: json, ver: 3, by: 'u1', ts: 50, created: 10, img: 'QUJD', imgType: 'image/webp', name: 'Helper' });
  assert.equal(e.ok, true);
  assert.equal(e.ver, 3);
  assert.equal(e.created, 10);
  assert.deepEqual(e.image, { img: 'QUJD', imgType: 'image/webp' });
  assert.equal(parseBotEntry('b', { def: json, ver: 1, by: 'u1', img: 'QUJD', imgType: 'image/svg+xml' }).image, null);
  assert.equal(parseBotEntry('b', { def: json, ver: 0, by: 'u1' }).ok, false);
  assert.equal(parseBotEntry('b', { def: '{}', ver: 1, by: 'u1' }).by, 'u1', 'invalid entries keep their publisher (to remove them)');
  assert.equal(parseBotEntry('b', { def: json, ver: 1 }).ok, false);
  assert.equal(parseBotEntry('bad/id', { def: json, ver: 1, by: 'u1' }).ok, false);
  const list = parseInstalled({
    b2: { def: json, ver: 1, at: 20, author: 'u2', by: 'u1' },
    b1: { def: json, ver: 2, at: 10 },
    bad: { def: '{"v":1}', ver: 1, at: 1 },
    noVer: { def: json, at: 1 },
    'x.y': { def: json, ver: 1 },
  });
  assert.deepEqual(list.map((b) => [b.id, b.ver]), [['b1', 2], ['b2', 1]]);
  assert.equal(list[1].author, 'u2');
  assert.deepEqual(parseInstalled(null), []);
  assert.equal(cleanImg({ img: 'not base64!', imgType: 'image/png' }), null);
  assert.equal(cleanImg({ img: 'A'.repeat(20004), imgType: 'image/png' }), null);
});

test('cleanBotTag / cleanCmd validate message body keys', () => {
  assert.deepEqual(cleanBotTag({ id: '-Nb1', name: ' Helper ', glyph: '🛠', via: 'trigger', trig: 'k1', evil: '<b>' }), { id: '-Nb1', name: 'Helper', glyph: '🛠', via: 'trigger', trig: 'k1' });
  assert.deepEqual(cleanBotTag({ id: 'b', name: 'H', via: 'nope', trig: 'BAD!' }), { id: 'b', name: 'H' });
  for (const bad of [null, 'x', [], { id: 'b' }, { id: 'a/b', name: 'x' }, { id: 'b', name: '' }, { id: 'b', name: 'x'.repeat(33) }, { id: 'b', name: 'a\nb' }, { id: 'b', name: {} }]) {
    assert.equal(cleanBotTag(bad), null, JSON.stringify(bad));
  }
  assert.equal(cleanCmd('roll'), 'roll');
  assert.equal(cleanCmd('Roll'), null);
  assert.equal(cleanCmd({}), null);
  assert.match(newTriggerId(), /^[a-z0-9]{1,12}$/);
});

// ---------- triggers ----------

test('keyword triggers match whole words, any case, outside code', () => {
  assert.equal(matchesTrigger('Good  Morning everyone', 'good morning'), true);
  assert.equal(matchesTrigger('goodmorning', 'good morning'), false);
  assert.equal(matchesTrigger('ping?', 'ping'), true);
  assert.equal(matchesTrigger('pinging', 'ping'), false);
  assert.equal(matchesTrigger('typing', 'ping'), false);
  assert.equal(matchesTrigger('use !ping now', '!ping'), true);
  assert.equal(matchesTrigger('I love c++!', 'c++'), true);
  assert.equal(matchesTrigger('Привет мир', 'привет'), true);
  assert.equal(matchesTrigger('see `ping` here', 'ping'), false);
  assert.equal(matchesTrigger('```\nping\n```', 'ping'), false);
  assert.equal(matchesTrigger('a.b', 'a.b'), true);
  assert.equal(matchesTrigger('axb', 'a.b'), false, 'regex characters are literal');
  assert.equal(triggerRegex('  '), null);
  assert.equal(stripCode('a `b` c'), 'a   c');
});

test('findTrigger: first match in install order, skips cooling triggers, one reply', () => {
  const bots = [
    { id: 'b1', def: { triggers: [{ id: 't1', match: 'hello', cooldown: 60 }, { id: 't2', match: 'world', cooldown: 60 }] } },
    { id: 'b2', def: { triggers: [{ id: 't3', match: 'hello', cooldown: 60 }] } },
  ];
  assert.equal(findTrigger('hello world', bots).trigger.id, 't1');
  assert.equal(findTrigger('hello world', bots, (b, t) => t.id === 't1').trigger.id, 't2');
  assert.equal(findTrigger('hello', bots, (b, t) => t.id === 't1').bot.id, 'b2');
  assert.equal(findTrigger('nothing', bots), null);
  assert.equal(findTrigger('', bots), null);
  const msgs = [
    { mid: 'a', ts: 1000, body: { text: 'old', bot: { id: 'b1', trig: 't1', via: 'trigger' } } },
    { mid: 'b', ts: 50_000, body: { text: 'hi' } },
  ];
  const t1 = bots[0].def.triggers[0];
  assert.equal(answeredRecently(msgs, 'b1', t1, 30_000), true);
  assert.equal(answeredRecently(msgs, 'b1', t1, 70_000), false);
  assert.equal(answeredRecently(msgs, 'b2', t1, 30_000), false);
});

// ---------- built-in commands ----------

const run = (name, args = '', ctx = { conv: { kind: 'channel', scope: 's_c' } }) => BUILTIN_COMMANDS.find((c) => c.name === name).run(args, ctx);

test('built-in commands produce tagged drafts or usage errors', () => {
  assert.deepEqual(run('shrug'), { text: SHRUG, extra: { cmd: 'shrug' } });
  assert.equal(SHRUG, '¯\\\\\\_(ツ)\\_/¯');
  assert.equal(run('shrug', 'oh well').text, `oh well ${SHRUG}`);
  assert.match(run('tableflip').text, /┻━┻$/);
  assert.match(run('unflip', 'fine').text, /^fine ┬─┬/);
  assert.deepEqual(run('me', '  waves   at_you \\o/ '), { text: '_waves at\\_you \\\\o/_', extra: { cmd: 'me' } });
  assert.equal(run('me', '').cancel, true);
  assert.equal(meText(''), '');
  assert.match(run('roll', '2d6').text, /^🎲 rolled 2d6: \d \+ \d = \*\*\d+\*\*$/);
  assert.match(run('roll').text, /^🎲 rolled 1d6: \*\*[1-6]\*\*$/);
  assert.equal(run('roll', '0d6').cancel, true);
  assert.match(run('roll', '0d6').reason, /Usage/);
  assert.equal(rollText('2d6', seq(2, 4)), '🎲 rolled 2d6: 3 + 5 = **8**');
  assert.match(run('flip').text, /^🪙 flipped a coin: \*\*(Heads|Tails)\*\*$/);
  assert.deepEqual(run('spoiler', 'the butler | did it\n'), { text: '||the butler ¦ did it||', extra: { cmd: 'spoiler' } });
  assert.equal(spoilerText('   '), '');
  assert.equal(run('spoiler', '').cancel, true);
  assert.deepEqual(RESERVED_NAMES.slice(0, 2), ['help', 'shrug']);
});

test('/poll and /gif ask the composer of this conversation for the tool', () => {
  assert.deepEqual(run('poll'), { handled: true });
  assert.equal(peekTool().kind, 'poll');
  assert.equal(peekTool().scope, 's_c');
  assert.deepEqual(run('gif', 'cats'), { handled: true });
  assert.deepEqual([peekTool().kind, peekTool().query], ['gif', 'cats']);
  const n = peekTool().seq;
  closeTool(n - 1); // stale close is ignored
  assert.equal(peekTool().kind, 'gif');
  closeTool(n);
  assert.equal(peekTool(), null);
});

test('built-ins run through the real slash hook and keep extra.cmd', async () => {
  _resetRegistries('slashCommands');
  for (const c of BUILTIN_COMMANDS) register('slashCommands', { ...c, id: `bots.${c.name}` });
  const ctx = { conv: { kind: 'dm', scope: 'dm_x' } };
  const res = await runSendHooks({ text: '/shrug ok' }, ctx, [slashHook]);
  assert.deepEqual(res.draft.extra, { cmd: 'shrug' });
  assert.equal(res.draft.text, `ok ${SHRUG}`);
  const cancel = await runSendHooks({ text: '/me' }, ctx, [slashHook]);
  assert.equal(cancel.cancel, true);
  assert.deepEqual(parseSlash('/roll 2d6'), { name: 'roll', args: '2d6' });
  assert.ok(commandsFor('group').some((c) => c.name === 'spoiler'));
  _resetRegistries('slashCommands');
});

// ---------- trigger-reply queue ----------

test('queued trigger replies wait for their own new message, then leave the queue', () => {
  clearPending();
  let pings = 0;
  const off = onPending(() => pings++);
  const known = new Set(['m1']);
  queueReply({ scope: 's_c', uid: 'me', text: 'ping please', known, at: 1000, draft: { text: 'pong' } }, 1000);
  assert.equal(pings, 1);
  const old = { mid: 'm1', uid: 'me', body: { text: 'ping please' } };
  // Not yet sent (only the old, already-loaded message with the same text): nothing ready.
  assert.deepEqual(takeReady('s_c', 'me', [old], 2000), []);
  // Someone else's message, a bot message, a still-encrypted one, or another conversation: still waiting.
  const others = [
    { mid: 'm2', uid: 'bob', body: { text: 'ping please' } },
    { mid: 'm3', uid: 'me', body: { text: 'ping please', bot: { id: 'b' } } },
    { mid: 'm4', uid: 'me', pending: true },
  ];
  assert.deepEqual(takeReady('s_c', 'me', [old, ...others], 2000), []);
  assert.deepEqual(takeReady('s_other', 'me', [old, { mid: 'm5', uid: 'me', body: { text: 'ping please' } }], 2000), []);
  // My new message arrives: the reply is released exactly once.
  const mine = { mid: 'm6', uid: 'me', body: { text: ' ping please ' } };
  const ready = takeReady('s_c', 'me', [old, ...others, mine], 2500);
  assert.deepEqual(ready.map((p) => p.draft.text), ['pong']);
  assert.deepEqual(takeReady('s_c', 'me', [old, mine], 2600), []);
  assert.equal(pendingCount(), 0);
  // Two queued replies need two new messages.
  queueReply({ scope: 's_c', uid: 'me', text: 'a', known: new Set(), at: 3000, draft: { text: 'r1' } }, 3000);
  queueReply({ scope: 's_c', uid: 'me', text: 'a', known: new Set(), at: 3000, draft: { text: 'r2' } }, 3000);
  assert.deepEqual(takeReady('s_c', 'me', [{ mid: 'x1', uid: 'me', body: { text: 'a' } }], 3100).map((p) => p.draft.text), ['r1']);
  assert.deepEqual(takeReady('s_c', 'me', [{ mid: 'x1', uid: 'me', body: { text: 'a' } }], 3150), [], 'x1 already released r1');
  assert.deepEqual(takeReady('s_c', 'me', [{ mid: 'x1', uid: 'me', body: { text: 'a' } }, { mid: 'x2', uid: 'me', body: { text: 'a' } }], 3200).map((p) => p.draft.text), ['r2']);
  // A reply whose message never shows up expires.
  queueReply({ scope: 's_c', uid: 'me', text: 'lost', known: new Set(), at: 5000, draft: { text: 'x' } }, 5000);
  assert.deepEqual(takeReady('s_c', 'me', [{ mid: 'y', uid: 'me', body: { text: 'lost' } }], 5000 + PENDING_TTL), []);
  assert.equal(pendingCount(), 0);
  off();
  clearPending();
});

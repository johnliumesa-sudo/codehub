// Round 3 messaging: pure helpers behind voice messages, reminders, message links, run code, chat
// export and drafts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_MAX_BYTES, baseMime, cleanAudioAtt, decodeWave, encodeWave, formatDuration, peaksFromSamples, pickRecorderType,
  recordingProblem, rmsLevel,
} from '../../src/lib/media/audio.js';
import {
  buildMessageLink, convKey, convRef, dmPeerOf, findMessageLinks, messageHash, parseMessageHash, parseMessageLink, sameConv,
} from '../../src/features/messaging/lib/links.js';
import { formatDue, fromLocalInput, parseWhen, presets, snoozeChoices, toLocalInput } from '../../src/features/messaging/lib/when.js';
import {
  MARK, MAX_RUN_CHARS, PRELUDE_LINES, buildHtmlDocument, buildJsDocument, extractRunnables, fencedBlocks, readConsole, runLang,
} from '../../src/features/messaging/lib/runnable.js';
import { exportFilename, fence, mdInline, toJson, toMarkdown, toRecord } from '../../src/features/messaging/lib/exportFormat.js';
import { MAX_DRAFTS, STORAGE_PREFIX, createDraftStore, draftAad } from '../../src/features/messaging/lib/draftStore.js';
import {
  MAX_EXCERPT, buildPayload, cleanPayload, dueToFire, excerptOf, nextDue, reminderAad, reminderSummary, sections, stateOf,
} from '../../src/features/messaging/lib/reminderModel.js';
import { chatFor, currentChat, publishChat, retractChat, waitForChat } from '../../src/features/messaging/lib/bridge.js';

const BASE = 'https://app.example/codehub/';
const CH = { kind: 'channel', sid: 's-1', cid: 'c_2' };
const DM = { kind: 'dm', dmId: 'alice_bob' };
const GRP = { kind: 'group', gid: 'g-9' };

// ---------- voice messages ----------

test('audio: recorder type choice, mime base, duration format', () => {
  assert.deepEqual(pickRecorderType((t) => t === 'audio/webm;codecs=opus'), { type: 'audio/webm;codecs=opus', mime: 'audio/webm' });
  assert.deepEqual(pickRecorderType((t) => t.startsWith('audio/mp4')), { type: 'audio/mp4;codecs=mp4a.40.2', mime: 'audio/mp4' });
  assert.equal(pickRecorderType(() => false), null);
  assert.equal(pickRecorderType(() => { throw new Error('x'); }), null);
  assert.equal(baseMime('Audio/WebM; codecs=opus'), 'audio/webm');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(9.9), '0:09');
  assert.equal(formatDuration(75.4), '1:15');
});

test('audio: waveform encode/decode, peaks and RMS levels', () => {
  const wave = encodeWave([0, 0.5, 1, 0.25], 4);
  assert.equal(wave, '08f4');
  assert.equal(encodeWave([], 6), '000000');
  assert.equal(encodeWave([0, 0, 0], 3), '000');
  assert.equal(encodeWave(Array.from({ length: 1000 }, (_, i) => (i === 999 ? 2 : 1))).length, 48);
  assert.deepEqual(decodeWave('0f'), [0, 1]);
  assert.deepEqual(decodeWave('xyz'), []);
  assert.deepEqual(decodeWave(42), []);
  assert.deepEqual(peaksFromSamples(new Float32Array([0.1, -0.9, 0.2, 0.3]), 2).map((v) => Math.round(v * 10) / 10), [0.9, 0.3]);
  assert.equal(rmsLevel(new Uint8Array(64).fill(128)), 0);
  assert.ok(rmsLevel(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0))) > 0.9);
});

test('audio: attachment entries are validated like untrusted input', () => {
  const good = { attId: 'att_1-x', kind: 'audio', mime: 'audio/webm', size: 1000, dur: 3.14159, wave: '0123456789abcdef' };
  assert.deepEqual(cleanAudioAtt(good), { attId: 'att_1-x', kind: 'audio', mime: 'audio/webm', size: 1000, dur: 3.1, wave: '0123456789abcdef' });
  assert.equal(cleanAudioAtt({ ...good, wave: '<script>' }).wave, undefined);
  for (const bad of [
    null, 'x', { ...good, kind: 'image' }, { ...good, attId: '../x' }, { ...good, mime: 'audio/x-evil' }, { ...good, mime: 'image/png' },
    { ...good, size: 0 }, { ...good, size: AUDIO_MAX_BYTES + 1 }, { ...good, dur: 0 }, { ...good, dur: 'long' },
  ]) assert.equal(cleanAudioAtt(bad), null, JSON.stringify(bad));
  assert.equal(cleanAudioAtt({ ...good, dur: 500 }).dur, 61);
});

test('audio: recording checks', () => {
  assert.equal(recordingProblem({ size: 1000, dur: 2, mime: 'audio/webm' }), null);
  assert.match(recordingProblem({ size: 1000, dur: 0.2, mime: 'audio/webm' }), /too short/);
  assert.match(recordingProblem({ size: AUDIO_MAX_BYTES + 1, dur: 30, mime: 'audio/ogg' }), /too large/);
  assert.match(recordingProblem({ size: 0, dur: 3, mime: 'audio/mp4' }), /empty/);
  assert.match(recordingProblem({ size: 10, dur: 3, mime: 'audio/wav' }), /format/);
});

// ---------- message links ----------

test('links: build, parse and round-trip for channels, DMs and groups', () => {
  for (const conv of [CH, DM, GRP]) {
    const link = buildMessageLink(conv, '-Nabc_123', BASE);
    assert.ok(link.startsWith(`${BASE}#/m/`), link);
    const t = parseMessageLink(link, BASE);
    assert.equal(t.mid, '-Nabc_123');
    assert.ok(sameConv(t, conv));
    assert.deepEqual(convRef(t), convRef(conv));
  }
  assert.equal(messageHash(CH, 'm1'), '#/m/ch/s-1/c_2/m1');
  assert.equal(messageHash(DM, 'm1'), '#/m/dm/alice_bob/m1');
  assert.equal(messageHash(GRP, 'm1'), '#/m/grp/g-9/m1');
  assert.equal(messageHash(CH, 'bad/mid'), null);
  assert.equal(messageHash({ kind: 'channel', sid: 's1' }, 'm1'), null);
  assert.deepEqual(parseMessageHash('#/m/ch/a/b/c'), { kind: 'channel', sid: 'a', cid: 'b', mid: 'c' });
  for (const bad of ['', '#/m/ch/a/b', '#/m/dm/a', '#/m/xx/a/b', '#/m/ch/a/b/c/d', '#/m/grp/a/b?x=1', '#/join/a/b/c', '#/m/ch/a$/b/c']) {
    assert.equal(parseMessageHash(bad), null, bad);
  }
  assert.equal(convKey(CH), 'ch:s-1/c_2');
  assert.equal(convKey({ kind: 'nope' }), null);
  assert.equal(sameConv(CH, { ...CH, cid: 'other' }), false);
});

test('links: only links to this app (same origin and path) count', () => {
  const link = buildMessageLink(CH, 'm1', BASE);
  assert.equal(parseMessageLink(link.replace('app.example', 'evil.example'), BASE), null);
  assert.equal(parseMessageLink(link.replace('/codehub/', '/other/'), BASE), null);
  assert.equal(parseMessageLink(`${BASE}?x=1#/m/ch/a/b/c`, BASE), null);
  assert.equal(parseMessageLink('#/m/ch/a/b/c', BASE), null);
  const text = `see ${link}. and ${link}, also https://evil.example/codehub/#/m/ch/a/b/c and ${buildMessageLink(DM, 'm2', BASE)})`;
  const found = findMessageLinks(text, BASE);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((t) => t.mid), ['m1', 'm2']);
  assert.equal(findMessageLinks('no links here', BASE).length, 0);
  const many = [1, 2, 3, 4, 5].map((i) => buildMessageLink(CH, `m${i}`, BASE)).join(' ');
  assert.equal(findMessageLinks(many, BASE).length, 3);
  assert.equal(dmPeerOf('alice_bob', 'alice'), 'bob');
  assert.equal(dmPeerOf('alice_bob', 'bob'), 'alice');
  assert.equal(dmPeerOf('alice_bob', 'carol'), null);
});

test('bridge: publish, retract, chatFor and waitForChat', async () => {
  const a = { conv: { ...CH }, messages: [] };
  const b = { conv: { ...CH }, messages: [{ mid: 'm1' }] };
  publishChat(a);
  assert.equal(currentChat(), a);
  assert.equal(chatFor(CH), a);
  assert.equal(chatFor(DM), null);
  const waiting = waitForChat((c) => c.messages.length > 0, 1000);
  publishChat(b);
  assert.equal(await waiting, b);
  retractChat(a); // stale: b stays
  assert.equal(currentChat(), b);
  retractChat(b);
  assert.equal(currentChat(), null);
  assert.equal(await waitForChat(() => true, 30), null);
});

// ---------- reminders: time parsing ----------

// Friday 2026-11-06 14:30 local time.
const NOW = new Date(2026, 10, 6, 14, 30, 0, 0);
const at = (d, h, m) => new Date(2026, 10, d, h, m, 0, 0).getTime();

test('when: relative times', () => {
  assert.equal(NOW.getDay(), 5);
  assert.deepEqual(parseWhen('20m stretch', NOW), { due: NOW.getTime() + 20 * 60_000, rest: 'stretch' });
  assert.deepEqual(parseWhen('in 2 hours call mom', NOW), { due: NOW.getTime() + 7_200_000, rest: 'call mom' });
  assert.equal(parseWhen('1h30m', NOW).due, NOW.getTime() + 90 * 60_000);
  assert.equal(parseWhen('1 h 30 min x', NOW).rest, 'x');
  assert.equal(parseWhen('45s', NOW).due, NOW.getTime() + 45_000);
  assert.equal(parseWhen('3d', NOW).due, NOW.getTime() + 3 * 86_400_000);
  assert.equal(parseWhen('1w review', NOW).due, NOW.getTime() + 7 * 86_400_000);
});

test('when: clock times, tomorrow, weekdays and dates', () => {
  assert.deepEqual(parseWhen('tomorrow', NOW), { due: at(7, 9, 0), rest: '' });
  assert.deepEqual(parseWhen('tomorrow 14:45 standup', NOW), { due: at(7, 14, 45), rest: 'standup' });
  assert.equal(parseWhen('tomorrow at 2pm', NOW).due, at(7, 14, 0));
  assert.deepEqual(parseWhen('17:00 ship it', NOW), { due: at(6, 17, 0), rest: 'ship it' });
  assert.equal(parseWhen('at 5:30 pm', NOW).due, at(6, 17, 30));
  assert.equal(parseWhen('13:00', NOW).due, at(7, 13, 0), 'a time that passed today means tomorrow');
  assert.equal(parseWhen('12am', NOW).due, at(7, 0, 0));
  assert.equal(parseWhen('today 18:15', NOW).due, at(6, 18, 15));
  assert.equal(parseWhen('monday 10:00 plan', NOW).due, at(9, 10, 0));
  assert.equal(parseWhen('fri', NOW).due, at(13, 9, 0), 'today’s 9:00 has passed: next week');
  assert.equal(parseWhen('friday 16:00', NOW).due, at(6, 16, 0));
  assert.equal(parseWhen('sat', NOW).due, at(7, 9, 0));
  assert.deepEqual(parseWhen('2026-12-24 18:00 presents', NOW), { due: new Date(2026, 11, 24, 18, 0).getTime(), rest: 'presents' });
  assert.equal(parseWhen('2026-12-24', NOW).due, new Date(2026, 11, 24, 9, 0).getTime());
});

test('when: rejects nonsense, the past and more than a year ahead', () => {
  for (const bad of ['', 'soon', 'call mom', '5 apples', '0m', 'today', 'today 13:00', '25:00', '13pm', '2026-02-31', '2025-01-01', '2028-01-01', '500w']) {
    assert.equal(parseWhen(bad, NOW), null, bad);
  }
});

test('when: presets, snooze choices, labels and datetime-local values', () => {
  const p = presets(NOW);
  assert.deepEqual(p.map((x) => x.id), ['20m', '1h', '3h', 'tomorrow']);
  assert.equal(p[3].due, at(7, 9, 0));
  assert.ok(p.every((x, i) => i === 0 || x.due > p[i - 1].due));
  assert.equal(snoozeChoices(NOW)[0].due, NOW.getTime() + 600_000);
  assert.match(formatDue(at(6, 18, 0), NOW, 'en-US'), /^today at 6:00\sPM$/);
  assert.match(formatDue(at(7, 9, 0), NOW, 'en-US'), /^tomorrow at 9:00\sAM$/);
  assert.match(formatDue(at(5, 9, 0), NOW, 'en-US'), /^yesterday at/);
  assert.match(formatDue(at(20, 9, 0), NOW, 'en-US'), /Nov 20 at/);
  assert.equal(formatDue(NaN, NOW), '');
  assert.equal(toLocalInput(at(6, 9, 5)), '2026-11-06T09:05');
  assert.equal(fromLocalInput('2026-11-06T09:05'), at(6, 9, 5));
  assert.ok(Number.isNaN(fromLocalInput('tomorrow')));
});

// ---------- reminders: model ----------

test('reminders: payload validation, cleaning and AAD', () => {
  const p = buildPayload({ due: 5000, note: ' call back ', conv: { ...CH, name: 'general', extra: 1 }, mid: 'm1', title: '#general', excerpt: 'x'.repeat(500), author: 'Alice' }, 1000);
  assert.deepEqual(p.conv, CH);
  assert.equal(p.note, 'call back');
  assert.equal(p.excerpt.length, MAX_EXCERPT);
  assert.equal(p.mid, 'm1');
  assert.equal(p.createdAt, 1000);
  assert.equal(buildPayload({ due: 5000, conv: DM, mid: 'bad/id' }).mid, undefined);
  assert.throws(() => buildPayload({ due: NaN, conv: CH }), /time/);
  assert.throws(() => buildPayload({ due: 5, conv: { kind: 'channel' } }), /conversation/);
  assert.deepEqual(cleanPayload(p), { ...p });
  assert.equal(cleanPayload({ due: 'x', conv: CH }), null);
  assert.equal(cleanPayload({ due: 1, conv: { kind: 'dm' } }), null);
  assert.equal(cleanPayload(null), null);
  assert.equal(reminderAad('u1', 'r1'), 'reminder:u1/r1');
});

test('reminders: states, sections, what fires and when to wake up', () => {
  const now = 10_000;
  const list = [
    { id: 'a', due: 5000, fired: null, done: null },
    { id: 'b', due: 20_000, fired: null, done: null },
    { id: 'c', due: 4000, fired: 4100, done: null },
    { id: 'd', due: 3000, fired: 3100, done: 3500 },
    { id: 'e', due: 15_000, fired: null, done: null },
    { id: 'f', due: 2000, fired: null, done: 2500 },
  ];
  assert.equal(stateOf(list[0], now), 'due');
  assert.equal(stateOf(list[1], now), 'upcoming');
  assert.equal(stateOf(list[3], now), 'done');
  const s = sections(list, now);
  assert.deepEqual(s.due.map((r) => r.id), ['c', 'a']);
  assert.deepEqual(s.upcoming.map((r) => r.id), ['e', 'b']);
  assert.deepEqual(s.done.map((r) => r.id), ['d', 'f']);
  assert.deepEqual(dueToFire(list, now).map((r) => r.id), ['a']);
  assert.equal(nextDue(list, now), 15_000);
  assert.equal(nextDue([], now), null);
  assert.equal(reminderSummary({ note: 'n', excerpt: 'e' }), 'n');
  assert.equal(reminderSummary({ note: '', excerpt: 'hello', author: 'Bo' }), 'Bo: hello');
  assert.equal(reminderSummary({ note: '', excerpt: '', title: '#general' }), 'Check #general');
});

test('reminders: message excerpts', () => {
  assert.equal(excerptOf({ text: 'look  at\nthis ```js\nx\n``` ok' }), 'look at this [code] ok');
  assert.equal(excerptOf({ text: '', code: { content: 'x', filename: 'a.js' } }), '[code: a.js]');
  assert.equal(excerptOf({ text: '', attachments: [{ kind: 'audio' }] }), '[voice message]');
  assert.equal(excerptOf({ text: '', attachments: [{ mime: 'image/png' }] }), '[image]');
  assert.equal(excerptOf({ text: '', poll: { q: 'Lunch?' } }), '[poll] Lunch?');
  assert.equal(excerptOf({ text: 'x'.repeat(400) }).length, MAX_EXCERPT);
  assert.equal(excerptOf(null), '');
});

// ---------- run code ----------

test('run code: languages, fenced blocks and runnable units', () => {
  assert.equal(runLang('JavaScript'), 'js');
  assert.equal(runLang('html'), 'html');
  assert.equal(runLang('css'), 'css');
  assert.equal(runLang('python'), null);
  const text = 'intro\n```js\nconsole.log(1)\n```\nmid\n```python\nprint(2)\n```\n```javascript title\nlet a = 2\n```';
  assert.deepEqual(fencedBlocks(text).map((b) => b.lang), ['js', 'python', 'javascript']);
  assert.equal(fencedBlocks(text)[0].code, 'console.log(1)');

  const js = extractRunnables({ text });
  assert.deepEqual(js.map((u) => [u.id, u.kind, u.label]), [['js0', 'js', 'JavaScript (block 1)'], ['js1', 'js', 'JavaScript (block 2)']]);
  assert.equal(js[1].code, 'let a = 2');

  const page = extractRunnables({ text: '```html\n<p class="x">hi</p>\n```\n```css\n.x{color:red}\n```\n```js\nconsole.log(3)\n```' });
  assert.equal(page.length, 1);
  assert.equal(page[0].kind, 'html');
  assert.equal(page[0].label, 'HTML + CSS + JS');
  assert.deepEqual(page[0].css, ['.x{color:red}']);

  assert.deepEqual(extractRunnables({ text: '```css\na{}\n```' }), []);
  assert.deepEqual(extractRunnables({ text: 'no code' }), []);
  assert.deepEqual(extractRunnables(null), []);
  assert.equal(extractRunnables({ text: '', code: { lang: 'javascript', content: 'console.log(1)' } })[0].kind, 'js');
  assert.equal(extractRunnables({ text: '', code: { lang: 'plaintext', content: '<b>x</b>', filename: 'page.html' } })[0].kind, 'html');
  assert.deepEqual(extractRunnables({ text: '', code: { lang: 'javascript', content: 'x'.repeat(MAX_RUN_CHARS + 1) } }), []);
  assert.deepEqual(extractRunnables({ text: '```js\n   \n```' }), []);
});

test('run code: documents keep user code inside its script and report through markers', () => {
  const evil = 'console.log("</script><img src=x onerror=alert(1)>")';
  const doc = buildJsDocument(evil);
  assert.ok(!doc.includes('</script><img'), 'user code never closes the runner script');
  assert.ok(doc.includes('new Worker('));
  assert.ok(doc.includes('LIMIT=5000') && doc.includes('setTimeout(function(){end(done?"end":"timeout");},LIMIT)'));
  assert.ok(PRELUDE_LINES > 3);
  const html = buildHtmlDocument({ html: '<p>hi</p>', css: ['p{color:red}</style><b>'], js: ['console.log(1)</script>x'] });
  assert.ok(html.startsWith('<html><head>'));
  assert.ok(html.includes('<style>\np{color:red}<\\/style><b>\n</style>'));
  assert.ok(html.includes('console.log(1)<\\/script>x'));
  assert.ok(html.includes('console.debug(M+"hb")'));
  const full = buildHtmlDocument({ html: '<html><head><title>t</title></head><body><p>x</p></body></html>', css: ['b{}'], js: ['1'] });
  assert.ok(full.includes('<style>\nb{}\n</style></head>'));
  assert.ok(full.includes('<script>\n1\n</script></body>'));
  assert.deepEqual(readConsole({ level: 'log', args: [`${MARK}hb`] }), { mark: 'hb' });
  assert.deepEqual(readConsole({ level: 'log', args: [`${MARK}timeout`] }), { mark: 'timeout' });
  assert.deepEqual(readConsole({ level: 'warn', args: ['a', 'b'] }), { line: { level: 'warn', text: 'a b' } });
  assert.deepEqual(readConsole({ level: 'weird', args: [`${MARK}bogus`] }), { line: { level: 'log', text: `${MARK}bogus` } });
});

// ---------- export ----------

test('export: records from raw messages and bodies (untrusted)', () => {
  const names = { u1: 'Alice' };
  const raw = { mid: 'm1', uid: 'u1', ts: Date.UTC(2026, 10, 6, 12, 0), editedAt: Date.UTC(2026, 10, 6, 12, 5), pinned: true, replyTo: 'm0', reactions: { '1f44d': { a: true, b: true }, e_party: { a: true } } };
  const body = {
    text: 'hello', code: { lang: 'js', content: 'x()', filename: 'a.js' },
    attachments: [{ attId: 'a1', mime: 'image/png', w: 10, h: 20, size: 99 }, { attId: 'a2', kind: 'audio', mime: 'audio/webm', size: 50, dur: 3 }, { attId: 'a3', kind: 'audio', mime: 'text/html', size: 1, dur: 1 }],
    gif: { url: 'https://media.giphy.com/x.gif' }, poll: { q: 'Q?', options: ['a', 'b'] }, fwd: { from: 'Bob' },
  };
  const r = toRecord(raw, body, names);
  assert.equal(r.author.name, 'Alice');
  assert.equal(r.time, '2026-11-06T12:00:00.000Z');
  assert.deepEqual(r.attachments.map((a) => a.type), ['image', 'voice']);
  assert.deepEqual(r.reactions, { '1f44d': 2, e_party: 1 });
  assert.equal(r.forwardedFrom, 'Bob');
  assert.equal(r.replyTo, 'm0');
  assert.deepEqual(toRecord({ mid: 'm2', uid: 'u2', ts: 1, deleted: true }, null, names), { id: 'm2', ts: 1, time: '1970-01-01T00:00:00.001Z', author: { uid: 'u2', name: 'Unknown' }, deleted: true });
  assert.equal(toRecord({ mid: 'm3', uid: 'u1', ts: 1 }, null, names, new Error('x')).undecryptable, true);
  assert.equal(toRecord({ mid: 'm4', uid: 'u1', ts: 1 }, { text: 42, code: { content: 5 } }, names).text, '');
});

test('export: Markdown and JSON output', () => {
  const recs = [
    toRecord({ mid: 'm1', uid: 'u1', ts: new Date(2026, 10, 5, 9, 15).getTime() }, { text: 'first *one*' }, { u1: 'Al*ce' }),
    toRecord({ mid: 'm2', uid: 'u1', ts: new Date(2026, 10, 6, 10, 0).getTime(), reactions: { '1f44d': { x: true } } }, { text: '', code: { lang: 'md', content: 'a ``` b ```` c' }, attachments: [{ attId: 'v', kind: 'audio', mime: 'audio/ogg', size: 9, dur: 42 }] }, { u1: 'Al*ce' }),
    toRecord({ mid: 'm3', uid: 'u1', ts: new Date(2026, 10, 6, 10, 1).getTime(), deleted: true }, null, {}),
  ];
  const md = toMarkdown(recs, { title: '#general', exportedAt: new Date(2026, 10, 6, 12, 0).getTime(), exportedBy: 'Bob' });
  assert.match(md, /^# Chat export: \\#general\n/);
  assert.match(md, /not encrypted/);
  assert.match(md, /## 2026-11-05\n\n\*\*Al\\\*ce\*\* · 09:15\nfirst \*one\*/);
  assert.match(md, /## 2026-11-06/);
  assert.ok(md.includes('`````md\na ``` b ```` c\n`````'), 'fence longer than any backtick run inside');
  assert.ok(md.includes('_[voice message, 0:42]_'));
  assert.ok(md.includes('Reactions: 👍 1'));
  assert.ok(md.includes('_Message deleted_'));
  assert.ok(md.endsWith('\n') && !md.includes('\n\n\n'));
  const json = JSON.parse(toJson(recs, { title: '#general', kind: 'channel', exportedAt: 0, range: { from: 0 } }));
  assert.equal(json.format, 'codehub-chat-export');
  assert.equal(json.count, 3);
  assert.equal(json.messages[1].attachments[0].duration, 42);
  assert.match(json.note, /NOT encrypted/);
  assert.equal(fence('no ticks'), '```');
  assert.equal(mdInline('a\nb # c'), 'a b \\# c');
  assert.equal(exportFilename('#General Chat!', 'md', new Date(2026, 10, 6).getTime()), 'codehub-general-chat-2026-11-06.md');
  assert.equal(exportFilename('', 'json', new Date(2026, 0, 2).getTime()), 'codehub-conversation-2026-01-02.json');
});

// ---------- drafts ----------

function memoryStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
// Fake sealing that binds the AAD like AES-GCM would (opening under another AAD fails).
const seal = async (aad, obj) => ({ iv: 'iv', ct: Buffer.from(JSON.stringify({ aad, obj })).toString('base64') });
const open = async (aad, box) => {
  const v = JSON.parse(Buffer.from(box.ct, 'base64').toString());
  if (v.aad !== aad) throw new Error('bad aad');
  return v.obj;
};

test('drafts: save, restore, list, clear on blank text, never plaintext in storage', async () => {
  const storage = memoryStorage();
  let t = 100;
  const s = createDraftStore({ storage, seal, open, now: () => ++t });
  const seen = [];
  s.subscribe((uid) => seen.push(uid));
  await s.save('u1', { ...CH, name: 'general' }, 'half a thought', '#general');
  await s.save('u1', DM, 'hey');
  assert.deepEqual(await s.get('u1', CH), { text: 'half a thought', title: '#general' });
  assert.ok(s.has('u1', DM));
  assert.equal(s.has('u2', DM), false);
  assert.deepEqual(s.list('u1').map((d) => d.key), ['dm:alice_bob', 'ch:s-1/c_2']);
  assert.deepEqual(s.list('u1')[1].conv, CH);
  const raw = storage.getItem(`${STORAGE_PREFIX}u1`);
  assert.ok(!raw.includes('half a thought'), 'stored sealed');
  assert.equal(draftAad('u1', 'dm:alice_bob'), 'draft:u1/dm:alice_bob');
  await s.save('u1', DM, '   ');
  assert.equal(s.has('u1', DM), false);
  await s.clear('u1', CH);
  assert.equal(storage.getItem(`${STORAGE_PREFIX}u1`), null);
  assert.ok(seen.length >= 4 && seen.every((u) => u === 'u1'));
});

test('drafts: last write wins, entries moved between conversations do not open, oldest evicted', async () => {
  const storage = memoryStorage();
  let t = 0;
  const s = createDraftStore({ storage, seal, open, now: () => ++t });
  await Promise.all([s.save('u1', GRP, 'first'), s.save('u1', GRP, 'second'), s.save('u1', GRP, '')]);
  assert.equal(s.has('u1', GRP), false, 'the clear issued last wins');
  await Promise.all([s.save('u1', GRP, 'a'), s.save('u1', GRP, 'b')]);
  assert.equal((await s.get('u1', GRP)).text, 'b');

  const map = JSON.parse(storage.getItem(`${STORAGE_PREFIX}u1`));
  map['dm:alice_bob'] = { ...map['grp:g-9'], kind: 'dm', dmId: 'alice_bob' };
  delete map['dm:alice_bob'].gid;
  storage.setItem(`${STORAGE_PREFIX}u1`, JSON.stringify(map));
  assert.equal(await s.get('u1', DM), null, 'AAD binds a draft to its conversation');

  storage.setItem(`${STORAGE_PREFIX}u2`, 'not json');
  assert.deepEqual(s.list('u2'), []);
  for (let i = 0; i < MAX_DRAFTS + 5; i++) await s.save('u3', { kind: 'group', gid: `g${i}` }, `t${i}`);
  const keys = s.list('u3').map((d) => d.key);
  assert.equal(keys.length, MAX_DRAFTS);
  assert.ok(!keys.includes('grp:g0') && keys.includes(`grp:g${MAX_DRAFTS + 4}`));

  const events = [];
  s.subscribe((u) => events.push(u));
  s.onStorageEvent({ key: `${STORAGE_PREFIX}u9` });
  s.onStorageEvent({ key: 'unrelated' });
  assert.deepEqual(events, ['u9']);
});

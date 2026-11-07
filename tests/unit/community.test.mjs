// Round 3 community workstream: pure logic of events/RSVPs, AutoMod, the welcome screen and rules
// gate, templates and discovery listings, plus a check that the client and the rules agree on the
// gate's paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_DURATION_MS, EVENT_LIMITS, REMINDER_LEAD_MS, canJoinVoice, cleanEvent, collectRsvps, dueReminders, eventAad,
  fromLocalInput, isLive, nextEvent, nextReminderIn, parseRsvpKey, reminderId, relTime, resolveRid, rsvpKey, sanitizeEvent,
  splitEvents, tallyRsvps, toIcs, toLocalInput,
} from '../../src/features/community/lib/events.js';
import {
  automodAad, automodActive, checkMessage, cleanAutomod, isExempt, normalizeText, parseWordList, patternMatches,
} from '../../src/features/community/lib/automod.js';
import { cleanWelcome, isGated, parseRules, welcomeAad, welcomeState } from '../../src/features/community/lib/welcome.js';
import {
  BUILTIN_TEMPLATES, TEMPLATE_LIMITS, cleanTemplate, summarize, templateAad, templateFromServer, withoutTopics,
} from '../../src/features/community/lib/templates.js';
import {
  cleanGlyph, cleanListing, filterListings, listingJoinHash, parseTags, sanitizeListing, topTags,
} from '../../src/features/community/lib/discovery.js';

const H = 3600_000;
const NOW = Date.UTC(2026, 10, 6, 12, 0);

test('events: cleanEvent validates titles, times, places and colors', () => {
  const ok = cleanEvent({ title: '  Game   night ', desc: 'a\r\nb\n\n\n\nc', start: NOW + H, end: NOW + 3 * H, loc: { kind: 'voice', cid: 'c-1' }, color: '#AABBCC' }, { now: NOW });
  assert.deepEqual(ok, { title: 'Game night', desc: 'a\nb\n\nc', start: NOW + H, end: NOW + 3 * H, loc: { kind: 'voice', cid: 'c-1' }, color: '#aabbcc' });
  assert.throws(() => cleanEvent({ title: ' ', start: NOW + H }, { now: NOW }), /title/);
  assert.throws(() => cleanEvent({ title: 'x' }, { now: NOW }), /start/);
  assert.throws(() => cleanEvent({ title: 'x', start: NOW - 2 * 24 * H }, { now: NOW }), /past/);
  assert.doesNotThrow(() => cleanEvent({ title: 'x', start: NOW - 2 * 24 * H }, { now: NOW, isNew: false }));
  assert.throws(() => cleanEvent({ title: 'x', start: NOW + H, end: NOW + H }, { now: NOW }), /end after/);
  assert.throws(() => cleanEvent({ title: 'x', start: NOW + H, end: NOW + H + 8 * 24 * H }, { now: NOW }), /7 days/);
  assert.throws(() => cleanEvent({ title: 'x', start: NOW + 3 * 366 * 24 * H }, { now: NOW }), /two years/);
  const t = cleanEvent({ title: 'x'.repeat(500), desc: 'y'.repeat(5000), start: NOW + H, loc: { kind: 'text', text: ' Room\u0000 4 ' }, color: 'red' }, { now: NOW });
  assert.equal(t.title.length, EVENT_LIMITS.title);
  assert.equal(t.desc.length, EVENT_LIMITS.desc);
  assert.deepEqual(t.loc, { kind: 'text', text: 'Room 4' });
  assert.equal(t.color, '#5b8cff');
  assert.equal(t.end, 0);
  assert.equal(cleanEvent({ title: 'x', start: NOW + H, loc: { kind: 'voice', cid: 'bad/id' } }, { now: NOW }).loc, null);
  assert.equal(cleanEvent({ title: 'x', start: NOW + H, loc: { kind: 'html', text: '<b>' } }, { now: NOW }).loc, null);
  const c = cleanEvent({ title: 'x', start: NOW + H, cancelled: true, rid: 'orig1', orig: 'uidA', extra: 'dropped' }, { now: NOW });
  assert.equal(c.cancelled, true);
  assert.equal(c.rid, 'orig1');
  assert.equal(c.orig, 'uidA');
  assert.equal('extra' in c, false);
  // untrusted input from other members
  assert.equal(sanitizeEvent(null), null);
  assert.equal(sanitizeEvent({ title: 1, start: NOW }), null);
  assert.equal(sanitizeEvent(['x']), null);
  assert.equal(sanitizeEvent({ title: 'Old one', start: NOW - 400 * 24 * H }).title, 'Old one');
  assert.equal(eventAad('s1', 'e1'), 'event:s1/e1');
});

test('events: RSVP keys, dedupe by author, tallies', () => {
  assert.equal(rsvpKey('e1', 'u1'), 'e1~u1');
  assert.deepEqual(parseRsvpKey('e-1~uid_9'), { rid: 'e-1', uid: 'uid_9' });
  assert.equal(parseRsvpKey('~u'), null);
  assert.equal(parseRsvpKey('e1~'), null);
  assert.equal(parseRsvpKey('noTilde'), null);
  const m = collectRsvps([
    { id: 'e1~a', by: 'a', s: 'going', ts: 1 },
    { id: 'e1~b', by: 'b', s: 'maybe', ts: 2 },
    { id: 'e1~c', by: 'x', s: 'going', ts: 3 }, // key and author disagree: ignored
    { id: 'e1~d', by: 'd', s: 'yes', ts: 4 }, // unknown state: ignored
    { id: 'e2~a', by: 'a', s: 'not', ts: 5 },
  ]);
  assert.deepEqual([...m.get('e1').keys()], ['a', 'b']);
  assert.equal(m.get('e2').get('a').s, 'not');
  const t = tallyRsvps(m.get('e1'));
  assert.deepEqual(t, { going: ['a'], maybe: ['b'], not: [] });
  assert.deepEqual(tallyRsvps(undefined), { going: [], maybe: [], not: [] });
});

test('events: upcoming/past split, next event, live window, Join voice window, moderator copies', () => {
  const a = { id: 'a', title: 'A', start: NOW + 2 * H, end: 0 };
  const b = { id: 'b', title: 'B', start: NOW + H, end: NOW + 2 * H, cancelled: true };
  const c = { id: 'c', title: 'C', start: NOW - 30 * 60_000, end: NOW + 30 * 60_000, loc: { kind: 'voice', cid: 'v' } };
  const d = { id: 'd', title: 'D', start: NOW - 5 * H, end: NOW - 4 * H };
  const { upcoming, past } = splitEvents([a, b, c, d], NOW);
  assert.deepEqual(upcoming.map((e) => e.id), ['c', 'b', 'a']);
  assert.deepEqual(past.map((e) => e.id), ['d']);
  assert.equal(nextEvent([a, b, d], NOW).id, 'a', 'cancelled events are skipped');
  assert.equal(nextEvent([d], NOW), null);
  assert.equal(isLive(c, NOW), true);
  assert.equal(isLive(a, NOW), false);
  assert.equal(isLive({ ...a, start: NOW - H }, NOW), true, 'no end = default duration');
  assert.equal(isLive({ ...a, start: NOW - DEFAULT_DURATION_MS - 1 }, NOW), false);
  assert.equal(canJoinVoice(c, NOW), true);
  assert.equal(canJoinVoice({ ...c, start: NOW + 11 * 60_000, end: 0 }, NOW), false);
  assert.equal(canJoinVoice({ ...c, start: NOW + 9 * 60_000, end: 0 }, NOW), true);
  assert.equal(canJoinVoice({ ...c, cancelled: true }, NOW), false);
  assert.equal(canJoinVoice({ ...c, loc: { kind: 'text', text: 'x' } }, NOW), false);
  assert.equal(resolveRid({ id: 'n1' }, new Set()), 'n1');
  assert.equal(resolveRid({ id: 'n1', rid: 'o1' }, new Set(['n1'])), 'o1', 'a copy keeps the RSVPs of the replaced event');
  assert.equal(resolveRid({ id: 'n1', rid: 'o1' }, new Set(['n1', 'o1'])), 'n1', 'a live original is never hijacked');
  assert.equal(relTime(NOW + 5 * 60_000, NOW), 'in 5 min');
  assert.equal(relTime(NOW - 2 * H, NOW), '2 h ago');
  assert.equal(relTime(NOW + 3 * 24 * H, NOW), 'in 3 days');
  assert.equal(relTime(NOW + 10_000, NOW), 'now');
});

test('events: reminders fire once, 15 minutes ahead, only for going, and catch up after a reload', () => {
  const ev = { id: 'e1', start: NOW + 10 * 60_000 };
  const later = { id: 'e2', start: NOW + H };
  const list = [{ sid: 's1', ev, rid: 'e1' }, { sid: 's1', ev: later, rid: 'e2' }, { sid: 's2', ev: { id: 'e3', start: NOW + 5 * 60_000 }, rid: 'e3' }];
  const going = new Set(['s1/e1', 's1/e2']);
  assert.deepEqual(dueReminders(list, going, new Set(), NOW).map((r) => r.ev.id), ['e1']);
  assert.deepEqual(dueReminders(list, going, new Set([reminderId('s1', ev)]), NOW), [], 'already fired');
  assert.deepEqual(dueReminders(list, going, new Set(), ev.start + 1), [], 'never after the start');
  assert.deepEqual(dueReminders([{ sid: 's1', ev: { ...ev, cancelled: true }, rid: 'e1' }], going, new Set(), NOW), []);
  assert.equal(nextReminderIn(list, going, new Set([reminderId('s1', ev)]), NOW), H - REMINDER_LEAD_MS);
  assert.equal(nextReminderIn([], going, new Set(), NOW), null);
  assert.notEqual(reminderId('s1', ev), reminderId('s1', { ...ev, start: ev.start + 1 }), 'a moved event reminds again');
});

test('events: datetime-local round trip and calendar export', () => {
  const ms = new Date(2026, 10, 7, 18, 30).getTime();
  assert.equal(toLocalInput(ms), '2026-11-07T18:30');
  assert.equal(fromLocalInput('2026-11-07T18:30'), ms);
  assert.equal(fromLocalInput('nope'), 0);
  assert.equal(toLocalInput(0), '');
  const ics = toIcs({ id: 'e1', title: 'Jam; night, 2', desc: 'line1\nline2', start: Date.UTC(2026, 10, 7, 18), end: 0, cancelled: true }, { where: 'Room\\4' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Jam\\; night\\, 2\r\n/);
  assert.match(ics, /DESCRIPTION:line1\\nline2\r\n/);
  assert.match(ics, /LOCATION:Room\\\\4\r\n/);
  assert.match(ics, /DTSTART:20261107T180000Z\r\nDTEND:20261107T200000Z/);
  assert.match(ics, /STATUS:CANCELLED/);
});

test('automod: patterns are whole-word, case/accent-insensitive, with * wildcards and phrases', () => {
  assert.equal(normalizeText('Ｓpä​M'), 'spam');
  assert.deepEqual(parseWordList('Spam*\n*coin, buy  NOW\n\n*\nspam*'), ['spam*', '*coin', 'buy now']);
  const cfg = cleanAutomod({ words: ['spam*', '*coin', 'buy now', 'c++'] });
  const hit = (text) => checkMessage({ text }, cfg)?.rule || null;
  assert.equal(hit('total SPAMMER here'), 'words');
  assert.equal(hit('get bitcoin'), 'words');
  assert.equal(hit('Buy\n  now!'), 'words');
  assert.equal(hit('I like c++ a lot'), 'words');
  assert.equal(hit('antispam filter'), null, 'whole words only');
  assert.equal(hit('coins'), null);
  assert.equal(hit('buy nowhere'), null);
  assert.equal(hit('Spämmy'), 'words', 'accents are ignored');
  assert.match(checkMessage({ text: 'spam' }, cfg).reason, /blocks/);
  assert.doesNotMatch(checkMessage({ text: 'spam' }, cfg).reason, /spam/, 'the notice never repeats the word');
  assert.equal(checkMessage({ text: 'ok', poll: { q: 'spam?', options: ['a', 'b'] } }, cfg)?.rule, 'words', 'polls are checked');
  assert.ok(patternMatches('*bad*', 'verybadthing'));
});

test('automod: invites, links, mentions and capitals', () => {
  const inv = cleanAutomod({ invites: true });
  assert.equal(checkMessage({ text: 'join https://codehub.app/#/join/s1/i1/key' }, inv)?.rule, 'invites');
  assert.equal(checkMessage({ text: 'discord.gg/abc' }, inv)?.rule, 'invites');
  assert.equal(checkMessage({ text: 'see https://example.com' }, inv), null);
  const links = cleanAutomod({ links: true });
  for (const t of ['https://x.io', 'go to www.example.org', '<mailto:a@b.c>', '[x](https://y.z)']) assert.equal(checkMessage({ text: t }, links)?.rule, 'links', t);
  assert.equal(checkMessage({ text: 'file.js is fine' }, links), null);
  assert.equal(checkMessage({ text: 'gif', gif: { url: 'https://media.giphy.com/x.gif' } }, links)?.rule, 'links');
  const mm = cleanAutomod({ maxMentions: 2 });
  assert.equal(checkMessage({ text: '@a @b' }, mm), null);
  assert.equal(checkMessage({ text: '@a @b (@c)' }, mm)?.rule, 'mentions');
  assert.equal(checkMessage({ text: 'mail me@x.org @a @b' }, mm), null, 'emails are not mentions');
  assert.equal(checkMessage({ text: '@a @b `@c @d`' }, mm), null, 'code is ignored');
  const caps = cleanAutomod({ caps: 70 });
  assert.equal(checkMessage({ text: 'THIS IS VERY LOUD TEXT' }, caps)?.rule, 'caps');
  assert.equal(checkMessage({ text: 'OK FINE' }, caps), null, 'short messages pass');
  assert.equal(checkMessage({ text: 'This Is Title Case Text Here' }, caps), null);
  assert.equal(checkMessage({ text: 'look ```CONST VALUE = SHOUTING_IN_CODE``` ok' }, caps), null);
});

test('automod: config cleaning, activity and exemptions', () => {
  const c = cleanAutomod({ words: ['x', 5, null], invites: 'yes', maxMentions: 999, caps: 30, action: 'nuke', exemptMods: false, other: 1 });
  assert.deepEqual(c, { words: ['x'], invites: false, links: false, maxMentions: 50, caps: 0, action: 'block', exemptMods: false });
  assert.equal(automodActive(cleanAutomod({})), false);
  assert.equal(automodActive(null), false);
  assert.equal(checkMessage({ text: 'anything' }, cleanAutomod({})), null);
  assert.equal(cleanAutomod({ caps: 100, action: 'hide' }).caps, 100);
  assert.equal(isExempt({ staff: true }, c), true);
  assert.equal(isExempt({ manageMessages: true }, c), false, 'moderators are checked when exemptMods is off');
  assert.equal(isExempt({ manageApps: true }, cleanAutomod({ exemptMods: true })), true);
  assert.equal(isExempt({}, cleanAutomod({})), false);
  assert.equal(isExempt(null, cleanAutomod({})), false);
  assert.equal(automodAad('s1'), 'automod:s1/cfg');
});

test('welcome: cleaning, state machine and the gate', () => {
  assert.deepEqual(cleanWelcome({ text: ' hi\r\n\n\n\nthere ', rules: ['  be  nice ', '', 3, 'x'.repeat(400)] }), { text: 'hi\n\nthere', rules: ['be nice', '3', 'x'.repeat(300)] });
  assert.equal(parseRules('a\n\nb\n'.repeat(20)).length, 25);
  const w = { configured: true, req: false, v: 10, by: 'mgr' };
  const st = (o) => welcomeState({ welcome: w, myUid: 'me', myRole: 'member', marker: null, seenV: 0, ...o });
  assert.equal(st({}), 'show');
  assert.equal(st({ seenV: 10 }), null);
  assert.equal(st({ seenV: 9 }), 'show', 'a newer version shows again');
  assert.equal(st({ myRole: 'owner' }), null);
  assert.equal(st({ myUid: 'mgr' }), null, 'the author is not greeted by their own message');
  assert.equal(st({ welcome: { ...w, configured: false } }), null);
  assert.equal(st({ welcome: null }), null);
  const g = { ...w, req: true };
  assert.equal(st({ welcome: g }), 'gate');
  assert.equal(st({ welcome: g, myRole: 'admin' }), 'show', 'admins are exempt from accepting but still greeted once');
  assert.equal(st({ welcome: g, myRole: 'admin', seenV: 10 }), null);
  assert.equal(st({ welcome: g, marker: { by: 'me', v: 10 } }), null);
  assert.equal(st({ welcome: g, marker: { by: 'me', v: 9 } }), 'update');
  assert.equal(st({ welcome: g, marker: { by: 'other', v: 10 } }), 'gate', 'a forged marker does not count');
  assert.equal(isGated({ req: true, myUid: 'me', myRole: 'member', marker: null }), true);
  assert.equal(isGated({ req: true, myUid: 'me', myRole: 'member', marker: { by: 'me' } }), false);
  assert.equal(isGated({ req: true, myUid: 'me', myRole: 'owner', marker: null }), false);
  assert.equal(isGated({ req: false, myUid: 'me', myRole: 'member', marker: null }), false);
  assert.equal(welcomeAad('s1'), 'welcome:s1/msg');
});

test('templates: the five built-ins are valid and complete', () => {
  assert.deepEqual(BUILTIN_TEMPLATES.map((t) => t.name), ['Study group', 'Open-source project', 'Game jam', 'Hackathon', 'Friends']);
  for (const t of BUILTIN_TEMPLATES) {
    const { id, ...rest } = t;
    assert.ok(id);
    assert.deepEqual(cleanTemplate(t), rest, `${t.name} is stable under cleaning`);
    assert.ok(t.channels.some((c) => c.type === 'text'), `${t.name} has a text channel`);
    assert.ok(t.message, `${t.name} posts a welcome message`);
    const cats = new Set(t.categories.map((c) => c.key));
    t.channels.forEach((c) => assert.ok(!c.cat || cats.has(c.cat)));
    assert.ok(t.channels.length <= TEMPLATE_LIMITS.channels);
    assert.match(summarize(t), /channels/);
  }
  assert.ok(BUILTIN_TEMPLATES.filter((t) => t.roles.length).length >= 4);
  assert.ok(BUILTIN_TEMPLATES.some((t) => t.welcome?.require), 'one template turns on the rules gate');
});

test('templates: cleaning untrusted templates and saving a server structure', () => {
  assert.throws(() => cleanTemplate(null), /template/);
  assert.throws(() => cleanTemplate({ name: '', channels: [{ name: 'a' }] }), /name/);
  assert.throws(() => cleanTemplate({ name: 'x', channels: [] }), /channel/);
  const t = cleanTemplate({
    name: 'Mine',
    categories: [{ key: 'k', name: 'Cat' }, { key: 'k', name: 'Dup' }, { key: '', name: 'x' }],
    channels: [{ type: 'text', name: 'Hello World!', topic: 't', cat: 'k' }, { type: 'voice', name: 'v', cat: 'k' }, { type: 'evil', name: 'x', cat: 'missing' }, { name: '' }],
    roles: [{ name: 'Mod', color: '#ABCDEF', position: 50, perms: { manageMessages: true, root: true, kick: 'yes' } }, { name: 'Bad', position: 0 }],
    welcome: { text: 'hi', rules: ['r'], require: 'yes' },
    message: 'hello',
  });
  assert.deepEqual(t.categories, [{ key: 'k', name: 'Cat' }]);
  assert.deepEqual(t.channels, [{ type: 'text', name: 'hello-world', topic: 't', cat: 'k' }, { type: 'voice', name: 'v' }, { type: 'text', name: 'x' }]);
  assert.deepEqual(t.roles, [{ name: 'Mod', color: '#abcdef', position: 50, perms: { manageMessages: true } }]);
  assert.deepEqual(t.welcome, { text: 'hi', rules: ['r'], require: false });
  assert.deepEqual(withoutTopics(t).channels[0], { type: 'text', name: 'hello-world', cat: 'k' });
  const fromServer = templateFromServer({
    name: 'Srv',
    color: '#3ccf91',
    channels: [
      { cid: 'c2', type: 'code', name: 'ws', topic: '', position: 1 },
      { cid: 'c1', type: 'text', name: 'general', topic: 'chat', cat: 'cat9', position: 0 },
      { cid: 'c3', type: 'text', name: null, failed: true, position: 2 },
    ],
    categories: [{ id: 'cat9', name: 'Main', position: 0 }],
    roles: { r1: { name: 'Helper', color: '#ff0000', position: 10, perms: { kick: true, ban: false } }, r2: { name: null, failed: true, position: 5 } },
    welcome: { text: 'Welcome', rules: ['Be nice'], req: true },
  });
  assert.deepEqual(fromServer.categories, [{ key: 'c0', name: 'Main' }]);
  assert.deepEqual(fromServer.channels, [{ type: 'text', name: 'general', topic: 'chat', cat: 'c0' }, { type: 'code', name: 'ws' }]);
  assert.deepEqual(fromServer.roles, [{ name: 'Helper', color: '#ff0000', position: 10, perms: { kick: true } }]);
  assert.deepEqual(fromServer.welcome, { text: 'Welcome', rules: ['Be nice'], require: true });
  assert.equal(templateAad('u1', 't1'), 'tmpl:u1/t1');
});

test('discovery: listing fields, sanitizing untrusted listings, search and tags', () => {
  assert.deepEqual(parseTags('Rust, Game Dev ,rust,,a!b,c,d,e,f'), ['rust', 'game-dev', 'ab', 'c', 'd']);
  assert.deepEqual(parseTags(['X Y']), ['x-y']);
  assert.equal(cleanGlyph('🦀 crab'), '🦀');
  assert.equal(cleanGlyph('rust'), 'RU');
  assert.equal(cleanGlyph('  '), '');
  assert.throws(() => cleanListing({ name: '', desc: 'x' }), /name/);
  assert.throws(() => cleanListing({ name: 'x', desc: ' ' }), /description/);
  assert.deepEqual(cleanListing({ name: ' Rustaceans ', desc: 'Learn  Rust', tags: 'Rust', glyph: '', color: 'blue', members: -3 }),
    { name: 'Rustaceans', desc: 'Learn Rust', tags: 'rust', glyph: 'R', color: '#5b8cff', members: 0 });
  const raw = { name: 'Rust', desc: 'd', tags: 'rust,beginners', glyph: '🦀', color: '#FF8F4D', members: 12, iid: 'inv1', k: 'A'.repeat(43), by: 'u1', ts: 5 };
  const l = sanitizeListing('s1', raw);
  assert.equal(l.color, '#ff8f4d');
  assert.deepEqual(l.tags, ['rust', 'beginners']);
  assert.equal(listingJoinHash(l), `/join/s1/inv1/${'A'.repeat(43)}`);
  assert.equal(sanitizeListing('s1', { ...raw, k: 'short' }), null);
  assert.equal(sanitizeListing('s1', { ...raw, iid: 'a/b' }), null);
  assert.equal(sanitizeListing('bad/sid', raw), null);
  assert.equal(sanitizeListing('s1', { ...raw, name: '' }), null);
  assert.equal(sanitizeListing('s1', { ...raw, members: 'lots' }).members, 0);
  const list = [
    { ...l, sid: 'a', name: 'Rust', members: 3, ts: 1, tags: ['rust'] },
    { ...l, sid: 'b', name: 'Jam', desc: 'Game jams', members: 9, ts: 2, tags: ['games', 'rust'] },
    { ...l, sid: 'c', name: 'Py', desc: 'python', members: 9, ts: 3, tags: ['python'] },
  ];
  assert.deepEqual(filterListings(list).map((x) => x.sid), ['c', 'b', 'a']);
  assert.deepEqual(filterListings(list, { sort: 'new' }).map((x) => x.sid), ['c', 'b', 'a']);
  assert.deepEqual(filterListings(list, { q: 'GAME' }).map((x) => x.sid), ['b']);
  assert.deepEqual(filterListings(list, { tag: 'rust' }).map((x) => x.sid), ['b', 'a']);
  assert.deepEqual(filterListings(list, { q: 'rust jam' }).map((x) => x.sid), ['b']);
  assert.deepEqual(topTags(list), [{ tag: 'rust', n: 2 }, { tag: 'games', n: 1 }, { tag: 'python', n: 1 }]);
});

test('rules and client agree on the gate paths; the gate fits the rule budget', () => {
  const rules = readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8');
  const data = readFileSync(new URL('../../src/features/community/lib/data.js', import.meta.url), 'utf8');
  assert.match(rules, /'sconf\/' \+ \$sid \+ '\/welcome\/req'\)\.val\(\) !== true/);
  assert.match(rules, /'sitems\/' \+ \$sid \+ '\/accepted\/' \+ auth\.uid \+ '\/by'\)\.val\(\) === auth\.uid/);
  assert.match(rules, /\$feat\.matches\(\/\^\(accepted\|rsvp\)\$\/\) \|\| \$id\.endsWith\(auth\.uid\)/);
  assert.match(data, /`sconf\/\$\{sid\}\/welcome\/req`/);
  assert.match(data, /`sitems\/\$\{sid\}\/accepted\/\$\{me\}`/);
  assert.match(data, /`sitems\/\$\{sid\}\/rsvp\/\$\{rsvpKey\(/);
});

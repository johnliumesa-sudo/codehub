// Add-ons: manifests and permissions, chunked storage, SHA-256 pins, the bridge host (permissions,
// validation, rate limits, storage quota) and the in-frame SDK talking to the host over a real
// MessageChannel, plus checks on the shipped example add-ons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADDON_PERMS, LIMITS, compareVersions, consentKey, filterManifests, formatBytes, isAddonId, normalizePerms, parseCodeRecord,
  parseConsent, parseInstall, parseInstalls, parseManifest, permDiff, permsCover, permsToString, utf8Length, validateDraft,
} from '../../src/features/addons/lib/manifest.js';
import { CHUNK, MAX_CHUNKS, packChunks, splitChunks, unpackChunks } from '../../src/features/addons/lib/chunks.js';
import { sha256Hex, shaMatches } from '../../src/features/addons/lib/hash.js';
import {
  addonDocument, addonSdk, applyStorageOp, createBridgeHost, createRateLimiter, isHello, readTheme, storageSize,
  toAddonContext, toAddonMessages,
} from '../../src/features/addons/lib/bridge.js';
import { ADDON_REPORT_KIND, addonIdFromTarget, addonReportTarget, reportedAddonId } from '../../src/features/addons/lib/report.js';

const SHA = 'a'.repeat(64);
const manifestRaw = (extra = {}) => ({ name: 'Timer', desc: 'A timer', icon: '⏱', version: '1.2.3', perms: 'storage', sha: SHA, size: 120, by: 'u1', ts: 5, ...extra });

test('permissions: normalize, stringify, diff, cover', () => {
  assert.deepEqual(ADDON_PERMS, ['readMessages', 'composer', 'send', 'storage']);
  assert.deepEqual(normalizePerms('storage, readMessages,bogus,storage'), ['readMessages', 'storage']);
  assert.deepEqual(normalizePerms(['send', 'composer']), ['composer', 'send']);
  assert.deepEqual(normalizePerms(null), []);
  assert.equal(permsToString(['storage', 'send', 'x']), 'send,storage');
  assert.deepEqual(permDiff(['storage'], ['storage', 'send']), { added: ['send'], removed: [] });
  assert.deepEqual(permDiff('readMessages,send', 'send'), { added: [], removed: ['readMessages'] });
  assert.equal(permsCover(['storage', 'send'], ['send']), true);
  assert.equal(permsCover(['storage'], ['send']), false);
  assert.equal(permsCover([], []), true);
});

test('versions, ids, sizes', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('junk', '0.0.0'), -1);
  assert.equal(isAddonId('-NabcDEF_123'), true);
  assert.equal(isAddonId('a/b'), false);
  assert.equal(isAddonId(''), false);
  assert.equal(utf8Length('aé€😀'), 1 + 2 + 3 + 4);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(65536), '64 KB');
  assert.equal(consentKey('s1', 'a1'), 's1~a1');
});

test('validateDraft: required fields, limits, version bump on update', () => {
  const ok = validateDraft({ name: ' Timer ', icon: '⏱', version: '1.0.0', desc: 'd', perms: ['storage', 'nope'], code: '<p>hi</p>' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { name: 'Timer', desc: 'd', icon: '⏱', version: '1.0.0', perms: ['storage'], code: '<p>hi</p>' });

  const bad = validateDraft({ name: '', icon: 'two words', version: '1.0', code: '   ' });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['code', 'icon', 'name', 'version']);
  assert.match(validateDraft({ name: 'x'.repeat(49), icon: 'x', version: '1.0.0', code: 'c' }).errors.name, /48/);
  assert.match(validateDraft({ name: 'a‮b', icon: 'x', version: '1.0.0', code: 'c' }).errors.name, /not allowed/);
  assert.match(validateDraft({ name: 'n', icon: 'x'.repeat(9), version: '1.0.0', code: 'c' }).errors.icon, /8/);
  assert.match(validateDraft({ name: 'n', icon: 'x', version: '1.0.0', desc: 'd'.repeat(501), code: 'c' }).errors.desc, /500/);
  // 64 KB is measured in UTF-8 bytes
  assert.equal(validateDraft({ name: 'n', icon: 'x', version: '1.0.0', code: 'a'.repeat(65536) }).ok, true);
  assert.match(validateDraft({ name: 'n', icon: 'x', version: '1.0.0', code: 'é'.repeat(32769) }).errors.code, /65536/);
  // updates must raise the version
  assert.match(validateDraft({ name: 'n', icon: 'x', version: '1.0.0', code: 'c' }, { previousVersion: '1.0.0' }).errors.version, /above 1\.0\.0/);
  assert.equal(validateDraft({ name: 'n', icon: 'x', version: '1.0.1', code: 'c' }, { previousVersion: '1.0.0' }).ok, true);
});

test('parseManifest / parseCodeRecord refuse anything malformed (database data is untrusted)', () => {
  const m = parseManifest('a1', manifestRaw({ seed: 'pomodoro' }));
  assert.deepEqual(m, { id: 'a1', name: 'Timer', desc: 'A timer', icon: '⏱', version: '1.2.3', perms: ['storage'], sha: SHA, size: 120, by: 'u1', ts: 5, seed: 'pomodoro' });
  assert.equal(parseManifest('a1', manifestRaw({ perms: '' })).perms.length, 0);
  assert.equal(parseManifest('a1', manifestRaw({ desc: undefined })).desc, '');
  for (const bad of [
    manifestRaw({ sha: 'xyz' }),
    manifestRaw({ perms: 'storage,launchMissiles' }),
    manifestRaw({ name: '' }),
    manifestRaw({ name: 'n'.repeat(49) }),
    manifestRaw({ icon: '' }),
    manifestRaw({ version: 'v1' }),
    manifestRaw({ by: 7 }),
    manifestRaw({ ts: 'now' }),
    manifestRaw({ desc: 'd'.repeat(501) }),
    null,
    'string',
  ]) assert.equal(parseManifest('a1', bad), null, JSON.stringify(bad));
  assert.equal(parseManifest('bad/id', manifestRaw()), null);
  assert.equal(parseManifest('a1', manifestRaw({ seed: 'Bad Seed' })).seed, null);

  assert.deepEqual(parseCodeRecord({ code: '<p>', sha: SHA, by: 'u1', ts: 1 }), { code: '<p>', sha: SHA, by: 'u1' });
  assert.equal(parseCodeRecord({ code: '', sha: SHA, by: 'u1' }), null);
  assert.equal(parseCodeRecord({ code: 'x', sha: 'nope', by: 'u1' }), null);
  assert.equal(parseCodeRecord({ code: 'x'.repeat(65537), sha: SHA, by: 'u1' }), null);
});

test('install and consent records', () => {
  const inst = parseInstall('a1', { sha: SHA, perms: 'send,storage', at: 3, v: '1.0.0', name: 'Timer', icon: '⏱', auto: true, by: 'u2' });
  assert.deepEqual(inst, { id: 'a1', sha: SHA, perms: ['send', 'storage'], at: 3, v: '1.0.0', name: 'Timer', icon: '⏱', auto: true, by: 'u2' });
  assert.equal(parseInstall('a1', { perms: 'send' }), null, 'a pin without a sha is useless');
  const fallback = parseInstall('a2', { sha: SHA, name: '', icon: 'x'.repeat(20), v: 'nope', auto: 'yes' });
  assert.equal(fallback.name, 'Add-on');
  assert.equal(fallback.icon, '🧩');
  assert.equal(fallback.v, '');
  assert.equal(fallback.auto, false);
  assert.deepEqual(parseInstalls({ b: { sha: SHA, name: 'Zed' }, a: { sha: SHA, name: 'Alpha' }, c: { nope: 1 } }).map((i) => i.id), ['a', 'b']);
  assert.deepEqual(parseConsent({ perms: 'readMessages', sha: SHA, auto: true }), { perms: ['readMessages'], sha: SHA, auto: true });
  assert.equal(parseConsent(null), null);
});

test('directory search and sort', () => {
  const list = [
    parseManifest('a', manifestRaw({ name: 'Beta', ts: 1 })),
    parseManifest('b', manifestRaw({ name: 'alpha', desc: 'Word cloud', perms: 'readMessages', ts: 3 })),
    parseManifest('c', manifestRaw({ name: 'Gamma', ts: 2 })),
  ];
  assert.deepEqual(filterManifests(list).map((m) => m.id), ['b', 'c', 'a']);
  assert.deepEqual(filterManifests(list, '', 'name').map((m) => m.id), ['b', 'a', 'c']);
  assert.deepEqual(filterManifests(list, 'cloud').map((m) => m.id), ['b']);
  assert.deepEqual(filterManifests(list, 'READMESSAGES').map((m) => m.id), ['b']);
});

test('chunks: split without breaking surrogate pairs, pack/unpack 64 KB, reject malformed', () => {
  const emoji = '😀'.repeat(CHUNK); // 2 * CHUNK UTF-16 units
  const parts = splitChunks(`x${emoji}`);
  assert.ok(parts.every((p) => p.length <= CHUNK));
  assert.equal(parts.join(''), `x${emoji}`);
  for (const p of parts) assert.doesNotMatch(p, /^[\udc00-\udfff]|[\ud800-\udbff]$/, 'no lone surrogate at a chunk edge');

  const code = 'abcdefghij'.repeat(6553) + 'abcdef'; // 65536 chars
  const rec = packChunks(code, { sha: SHA });
  assert.equal(rec.sha, SHA);
  assert.equal(rec.n, Math.ceil(65536 / CHUNK));
  assert.ok(Object.keys(rec).every((k) => ['sha', 'n'].includes(k) || /^c\d$/.test(k)));
  assert.equal(unpackChunks(rec), code);
  assert.equal(unpackChunks({ n: 0 }), '');
  assert.equal(unpackChunks({ n: 2, c0: 'a' }), null);
  assert.equal(unpackChunks({ n: MAX_CHUNKS + 1 }), null);
  assert.equal(unpackChunks({ n: 1, c0: 'x'.repeat(CHUNK + 1) }), null);
  assert.throws(() => packChunks('x'.repeat(CHUNK * MAX_CHUNKS + 1)), /Too large/);
});

test('sha256Hex matches the standard test vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex('é'), await sha256Hex('é'));
  assert.equal(await shaMatches('abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), true);
  assert.equal(await shaMatches('abd', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), false);
});

test('report targets', () => {
  assert.equal(ADDON_REPORT_KIND, 'addon');
  assert.equal(addonReportTarget('-Nabc'), '-Nabc');
  assert.equal(reportedAddonId({ kind: 'addon', target: '-Nabc' }), '-Nabc');
  assert.equal(reportedAddonId({ kind: 'addon', target: 'a/b' }), null);
  // Reports filed before the `addon` kind existed: shopItem + `addon:{id}`.
  assert.equal(reportedAddonId({ kind: 'shopItem', target: 'addon:-Nabc' }), '-Nabc');
  assert.equal(reportedAddonId({ kind: 'shopItem', target: 'itemA' }), null);
  assert.equal(reportedAddonId({ kind: 'user', target: '-Nabc' }), null);
  assert.equal(addonIdFromTarget('addon:-Nabc'), '-Nabc');
  assert.equal(addonIdFromTarget('itemA'), null);
  assert.equal(addonIdFromTarget('addon:a/b'), null);
});

test('rate limiter: burst capacity, refill over time', () => {
  const rl = createRateLimiter({ capacity: 3, perSec: 2 });
  assert.equal([rl.take(0), rl.take(0), rl.take(0), rl.take(0)].join(), 'true,true,true,false');
  assert.equal(rl.take(400), false, '0.8 tokens after 400 ms');
  assert.equal(rl.take(500), true, '1 token after 500 ms');
  assert.equal(rl.take(10_000), true);
});

function host(perms, over = {}) {
  const calls = [];
  const h = {
    ready: () => true,
    context: () => ({ kind: 'channel', name: 'general', me: { name: 'Ada' }, scope: 'personal' }),
    theme: () => ({ mode: 'dark', tokens: {} }),
    messages: (n) => { calls.push(['messages', n]); return [{ id: 'm1', author: 'Ada', text: 'hi', ts: 1 }]; },
    insertText: (t) => { calls.push(['insertText', t]); return true; },
    sendMessage: (t) => { calls.push(['sendMessage', t]); return true; },
    storage: (op, key, value) => { calls.push(['storage', op, key, value]); return op === 'get' ? 42 : true; },
    ...over,
  };
  let t = 0;
  const bridge = createBridgeHost({ perms, handlers: h, now: () => t, ...over.opts });
  return { bridge, calls, tick: (ms) => { t += ms; } };
}

test('bridge host: permissions, argument checks, dispatch', async () => {
  const { bridge, calls } = host(['readMessages', 'storage']);
  assert.equal(await bridge.handle(null), null);
  assert.equal(await bridge.handle({ id: 0, method: 'ready' }), null);
  assert.deepEqual(await bridge.handle({ id: 1, method: 'ready' }), { re: 1, ok: true, result: true });
  assert.deepEqual((await bridge.handle({ id: 2, method: 'getContext' })).result.name, 'general');
  assert.equal((await bridge.handle({ id: 3, method: 'eval', args: ['x'] })).error.code, 'UNKNOWN_METHOD');
  assert.equal((await bridge.handle({ id: 4, method: 'toString' })).error.code, 'UNKNOWN_METHOD');

  // granted
  assert.deepEqual((await bridge.handle({ id: 5, method: 'getMessages', args: [500] })).result[0].id, 'm1');
  assert.deepEqual(calls.pop(), ['messages', 100], 'n is clamped to 100');
  await bridge.handle({ id: 6, method: 'getMessages' });
  assert.deepEqual(calls.pop(), ['messages', 20], 'default n');
  assert.equal((await bridge.handle({ id: 7, method: 'getMessages', args: ['all'] })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await bridge.handle({ id: 8, method: 'storage.get', args: ['k'] })).result, 42);
  assert.deepEqual(calls.pop(), ['storage', 'get', 'k', undefined]);
  await bridge.handle({ id: 9, method: 'storage.set', args: ['k', { a: [1, 2], d: undefined }] });
  assert.deepEqual(calls.pop(), ['storage', 'set', 'k', { a: [1, 2] }], 'values are JSON-copied');
  assert.equal((await bridge.handle({ id: 10, method: 'storage.set', args: ['k'] })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await bridge.handle({ id: 11, method: 'storage.get', args: [''] })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await bridge.handle({ id: 12, method: 'storage.get', args: ['k'.repeat(129)] })).error.code, 'INVALID_ARGUMENT');

  // not granted
  for (const [method, args] of [['insertText', ['hi']], ['sendMessage', ['hi']]]) {
    const r = await bridge.handle({ id: 13, method, args });
    assert.equal(r.error.code, 'PERMISSION_DENIED', method);
  }
  assert.equal(calls.length, 0, 'denied calls never reach a handler');

  // too large
  assert.equal((await bridge.handle({ id: 14, method: 'storage.set', args: ['k', 'x'.repeat(80000)] })).error.code, 'INVALID_ARGUMENT');
  // handler errors keep their code; odd codes become FAILED
  const { bridge: b2 } = host(['storage'], { storage: () => { const e = new Error('nope'); e.code = 'QUOTA_EXCEEDED'; throw e; } });
  assert.deepEqual((await b2.handle({ id: 1, method: 'storage.keys' })).error, { code: 'QUOTA_EXCEEDED', message: 'nope' });
  const { bridge: b3 } = host(['storage'], { storage: () => { const e = new Error('x'); e.code = 'lower case'; throw e; } });
  assert.equal((await b3.handle({ id: 1, method: 'storage.keys' })).error.code, 'FAILED');
});

test('bridge host: send rules and rate limits', async () => {
  const { bridge, calls, tick } = host(['composer', 'send']);
  assert.equal((await bridge.handle({ id: 1, method: 'insertText', args: [''] })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await bridge.handle({ id: 2, method: 'insertText', args: [7] })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await bridge.handle({ id: 3, method: 'insertText', args: ['x'.repeat(4001)] })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await bridge.handle({ id: 4, method: 'sendMessage', args: ['/kick everyone'] })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await bridge.handle({ id: 5, method: 'sendMessage', args: ['hello'] })).ok, true);
  assert.equal((await bridge.handle({ id: 6, method: 'sendMessage', args: ['again'] })).error.code, 'RATE_LIMITED');
  tick(3000);
  assert.equal((await bridge.handle({ id: 7, method: 'sendMessage', args: ['later'] })).ok, true);
  assert.deepEqual(calls.filter((c) => c[0] === 'sendMessage').map((c) => c[1]), ['hello', 'later']);

  const { bridge: flood } = host([]);
  const results = [];
  for (let i = 1; i <= 40; i++) results.push(await flood.handle({ id: i, method: 'getContext' }));
  assert.equal(results.filter((r) => r.ok).length, 30, 'burst of 30');
  assert.equal(results[39].error.code, 'RATE_LIMITED');
});

test('storage model: get/set/remove/keys and the 32 KB quota', () => {
  let s = applyStorageOp({}, 'set', 'a', { n: 1 });
  assert.equal(s.changed, true);
  assert.deepEqual(applyStorageOp(s.map, 'get', 'a').result, { n: 1 });
  assert.equal(applyStorageOp(s.map, 'get', 'missing').result, null);
  assert.equal(applyStorageOp(s.map, 'get', 'toString').result, null, 'no prototype keys');
  s = applyStorageOp(s.map, 'set', 'b', 'x');
  assert.deepEqual(applyStorageOp(s.map, 'keys').result, ['a', 'b']);
  assert.deepEqual(applyStorageOp(s.map, 'remove', 'missing'), { map: s.map, result: false, changed: false });
  s = applyStorageOp(s.map, 'remove', 'a');
  assert.deepEqual(s.map, { b: 'x' });
  const big = 'y'.repeat(LIMITS.storageBytes - 20);
  assert.ok(storageSize({ k: big }) <= LIMITS.storageBytes);
  assert.equal(applyStorageOp({}, 'set', 'k', big).changed, true);
  assert.throws(() => applyStorageOp({ k: big }, 'set', 'k2', 'z'.repeat(100)), (e) => e.code === 'QUOTA_EXCEEDED');
});

test('messages and context handed to add-ons', () => {
  const msgs = [
    { mid: 'm1', uid: 'u1', ts: 1, body: { text: 'first' } },
    { mid: 'm2', uid: 'u2', ts: 2, deleted: true, body: { text: 'gone' } },
    { mid: 'm3', uid: 'u1', ts: 3, error: true },
    { mid: 'm4', uid: 'u1', ts: 4, pending: true, body: { text: 'sending' } },
    { mid: 'm5', uid: 'u3', ts: 5, body: { text: '', code: { lang: 'js', content: 'x()' } } },
    { mid: 'm6', uid: 'u2', ts: 6, body: { text: 'last', secret: 'not exposed' } },
  ];
  const out = toAddonMessages(msgs, { u1: { name: 'Ada' }, u2: { name: 'Linus' } }, 100);
  assert.deepEqual(out, [
    { id: 'm1', author: 'Ada', text: 'first', ts: 1 },
    { id: 'm5', author: 'Unknown', text: '```js\nx()\n```', ts: 5 },
    { id: 'm6', author: 'Linus', text: 'last', ts: 6 },
  ]);
  assert.deepEqual(toAddonMessages(msgs, {}, 1).map((m) => m.id), ['m6']);
  assert.deepEqual(toAddonContext({ kind: 'channel', name: 'general', sid: 's1', cid: 'c1' }, { name: 'Ada', uid: 'u1', email: 'a@x' }, 'server'), {
    kind: 'channel', name: 'general', me: { name: 'Ada' }, scope: 'server',
  });
  assert.equal(toAddonContext({ kind: 'weird' }, null).kind, 'preview');
});

test('theme tokens: only plain colors pass', () => {
  const vals = { '--bg-0': ' #0b0d12 ', '--text': 'rgb(1, 2, 3)', '--accent': 'url(javascript:alert(1))', '--danger': 'red;}body{x' };
  const t = readTheme((n) => vals[n], 'light');
  assert.deepEqual(t, { mode: 'light', tokens: { 'bg-0': '#0b0d12', text: 'rgb(1, 2, 3)' } });
  assert.equal(readTheme(() => '', 'weird').mode, 'dark');
});

test('frame document: SDK first, then the add-on; hello check', () => {
  const doc = addonDocument('<p>mine</p>', 'abcdef0123456789abcdef0123456789');
  assert.ok(doc.startsWith('<script>('));
  assert.ok(doc.indexOf('abcdef0123456789abcdef0123456789') < doc.indexOf('<p>mine</p>'));
  assert.doesNotMatch(doc.slice(0, doc.indexOf('</script>')), /<\/script/i);
  assert.equal(isHello({ __addon: 'abcdef0123456789', hello: 1 }, 'abcdef0123456789'), true);
  assert.equal(isHello({ __addon: 'other', hello: 1 }, 'abcdef0123456789'), false);
  assert.equal(isHello({ __addon: 'short', hello: 1 }, 'short'), false);
  assert.equal(isHello(null, 'abcdef0123456789'), false);
  // The SDK is serialized with toString: it must not depend on module scope.
  const fn = new Function(`return (${addonSdk.toString()})`)();
  assert.equal(typeof fn, 'function');
});

/** A fake frame window around the real SDK; the "parent" receives the hello with its port. */
function frameWithSdk(opts) {
  const style = {};
  const attrs = {};
  const hellos = [];
  const win = {
    MessageChannel,
    console: { log() {}, info() {}, warn() {}, error() {} },
    addEventListener() {},
    document: { documentElement: { style: { setProperty: (k, v) => { style[k] = v; } }, setAttribute: (k, v) => { attrs[k] = v; } } },
    parent: { postMessage: (data, origin, ports) => hellos.push({ data, origin, ports }) },
  };
  addonSdk(win, 'f'.repeat(32), opts);
  return { win, hellos, style, attrs };
}

test('SDK ↔ host over a MessageChannel: hello, init, calls, errors, events', async () => {
  const { win, hellos, style, attrs } = frameWithSdk({ console: false });
  assert.equal(hellos.length, 1);
  assert.equal(isHello(hellos[0].data, 'f'.repeat(32)), true);
  assert.equal(hellos[0].origin, '*');
  const port = hellos[0].ports[0];
  const api = win.codehub;
  assert.ok(Object.isFrozen(api));
  assert.throws(() => { win.codehub = null; }, TypeError, 'window.codehub cannot be replaced');

  const { bridge, calls } = host(['readMessages']);
  port.onmessage = async (e) => {
    const reply = await bridge.handle(e.data);
    if (reply) port.postMessage(reply);
  };
  const theme = { mode: 'light', tokens: { 'bg-0': '#ffffff', accent: '#2f62e0' } };
  port.postMessage({ event: 'init', data: { perms: ['readMessages'], theme, context: { kind: 'dm', name: 'Ada', me: { name: 'Linus' } }, scope: 'personal' } });

  const ready = await api.ready();
  assert.deepEqual(ready.perms, ['readMessages']);
  assert.equal(ready.context.name, 'Ada');
  assert.equal(style['--ch-accent'], '#2f62e0', 'theme tokens become --ch-* variables');
  assert.equal(attrs['data-theme'], 'light');
  assert.deepEqual(await api.getMessages(5), [{ id: 'm1', author: 'Ada', text: 'hi', ts: 1 }]);
  assert.deepEqual(calls.pop(), ['messages', 5]);
  await assert.rejects(api.sendMessage('hi'), (e) => e.code === 'PERMISSION_DENIED');
  await assert.rejects(api.storage.set('k', () => 1), (e) => e.code === 'INVALID_ARGUMENT', 'functions cannot be cloned');

  const seen = [];
  const off = api.on('theme', (t) => seen.push(t.mode));
  port.postMessage({ event: 'theme', data: { mode: 'dark', tokens: { accent: '#5b8cff' } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['dark']);
  assert.equal(api.theme.mode, 'dark');
  assert.equal(style['--ch-accent'], '#5b8cff');
  off();
  port.postMessage({ event: 'theme', data: { mode: 'light', tokens: {} } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['dark'], 'off() unsubscribes');
  port.close();
});

test('SDK console forwarding (builder preview only)', async () => {
  const { win, hellos } = frameWithSdk({ console: true });
  const port = hellos[0].ports[0];
  const got = [];
  port.onmessage = (e) => got.push(e.data);
  win.console.log('hello', { a: 1 });
  win.console.error(new Error('boom'));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, [{ log: 'log', args: ['hello', '{"a":1}'] }, { log: 'error', args: ['Error: boom'] }]);
  port.close();
});

test('shipped examples: under 64 KB, self-contained, use the bridge safely', () => {
  for (const [file, perm] of [['pomodoro.html', 'storage'], ['wordcloud.html', 'readMessages']]) {
    const code = readFileSync(new URL(`../../src/features/addons/examples/${file}`, import.meta.url), 'utf8');
    assert.ok(utf8Length(code) < LIMITS.codeBytes, `${file} fits`);
    assert.match(code, /codehub\.ready\(\)/);
    assert.doesNotMatch(code, /\b(src|href)\s*=\s*["']?(https?:)?\/\//i, `${file} loads nothing from the network`);
    assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|document\.write/, `${file} renders text safely`);
    assert.ok(code.includes(perm === 'storage' ? 'codehub.storage' : 'codehub.getMessages'));
  }
  const index = readFileSync(new URL('../../src/features/addons/examples/index.js', import.meta.url), 'utf8');
  assert.match(index, /perms: \['storage'\]/);
  assert.match(index, /perms: \['readMessages'\]/);
});

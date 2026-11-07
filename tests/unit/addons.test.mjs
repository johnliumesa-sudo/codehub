// Add-ons: manifests and permissions, chunked storage, SHA-256 pins, the bridge host (permissions,
// validation, rate limits, storage quota), the runtime (frame document pinned by CSP hashes, the
// worker SDK talking to the real bridge host from a vm context without string code generation),
// the shipped examples running in that worker, and the rules that stop removed add-ons from running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  ADDON_PERMS, LIMITS, compareVersions, consentKey, filterManifests, formatBytes, isAddonId, isCurrentRuntime, normalizePerms,
  parseCodeRecord, parseConsent, parseInstall, parseInstalls, parseManifest, permDiff, permsCover, permsToString, runBlock,
  updateBlock, utf8Length, validateDraft,
} from '../../src/features/addons/lib/manifest.js';
import { CHUNK, MAX_CHUNKS, packChunks, splitChunks, unpackChunks } from '../../src/features/addons/lib/chunks.js';
import { sha256Hex, shaMatches } from '../../src/features/addons/lib/hash.js';
import {
  SEND_ARM_MS, applyStorageOp, createBridgeHost, createRateLimiter, initPayload, isHello, messageStats, readTheme, storageSize,
  toAddonContext, toAddonMessages,
} from '../../src/features/addons/lib/bridge.js';
import {
  MAX_UI_HTML, RUNTIME_VERSION, addonCsp, cleanPurifySource, frameDocument, hostScript, runtimeAssets, workerSdk, workerSource,
} from '../../src/features/addons/lib/runtime.js';
import { ADDON_REPORT_KIND, addonIdFromTarget, addonReportTarget, reportedAddonId } from '../../src/features/addons/lib/report.js';

const SHA = 'a'.repeat(64);
const manifestRaw = (extra = {}) => ({ name: 'Timer', desc: 'A timer', icon: '⏱', version: '1.2.3', perms: 'storage', sha: SHA, size: 120, by: 'u1', ts: 5, ...extra });

test('permissions: normalize, stringify, diff, cover', () => {
  assert.deepEqual(ADDON_PERMS, ['context', 'readMessages', 'composer', 'send', 'storage']);
  assert.deepEqual(normalizePerms('storage,context'), ['context', 'storage']);
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
  // add-on code is worker JavaScript, not an HTML page (the old runtime)
  for (const page of ['<!doctype html><p>x</p>', '  <html><body></body></html>', '<script>codehub.ready()</script>', '<!-- c -->']) {
    assert.match(validateDraft({ name: 'n', icon: 'x', version: '1.0.0', code: page }).errors.code, /JavaScript/, page);
  }
  assert.equal(validateDraft({ name: 'n', icon: 'x', version: '1.0.0', code: "codehub.ui.render('<p>hi</p>')" }).ok, true);
  // updates must raise the version
  assert.match(validateDraft({ name: 'n', icon: 'x', version: '1.0.0', code: 'c' }, { previousVersion: '1.0.0' }).errors.version, /above 1\.0\.0/);
  assert.equal(validateDraft({ name: 'n', icon: 'x', version: '1.0.1', code: 'c' }, { previousVersion: '1.0.0' }).ok, true);
});

test('parseManifest / parseCodeRecord refuse anything malformed (database data is untrusted)', () => {
  const m = parseManifest('a1', manifestRaw({ seed: 'pomodoro', rt: 2 }));
  assert.deepEqual(m, { id: 'a1', name: 'Timer', desc: 'A timer', icon: '⏱', version: '1.2.3', perms: ['storage'], sha: SHA, size: 120, by: 'u1', ts: 5, seed: 'pomodoro', rt: 2 });
  assert.equal(parseManifest('a1', manifestRaw()).rt, 1, 'no runtime field: written for the old document runtime');
  assert.equal(parseManifest('a1', manifestRaw({ rt: 'two' })).rt, 1);
  assert.equal(isCurrentRuntime(parseManifest('a1', manifestRaw({ rt: RUNTIME_VERSION }))), true);
  assert.equal(isCurrentRuntime(parseManifest('a1', manifestRaw())), false);
  assert.equal(parseManifest('a1', manifestRaw({ perms: 'context,readMessages' })).perms.join(), 'context,readMessages');
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
  const inst = parseInstall('a1', { sha: SHA, perms: 'send,storage', at: 3, v: '1.0.0', name: 'Timer', icon: '⏱', auto: true, by: 'u2', publisher: 'u1', rt: 2 });
  assert.deepEqual(inst, { id: 'a1', sha: SHA, perms: ['send', 'storage'], at: 3, v: '1.0.0', name: 'Timer', icon: '⏱', auto: true, by: 'u2', publisher: 'u1', rt: 2 });
  const legacy = parseInstall('a1', { sha: SHA, name: 'Old' });
  assert.equal(legacy.publisher, '');
  assert.equal(legacy.rt, 1);
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
  assert.equal((await bridge.handle({ id: 2, method: 'getContext' })).error.code, 'PERMISSION_DENIED', 'names need the context permission');
  assert.equal((await host(['context']).bridge.handle({ id: 2, method: 'getContext' })).result.name, 'general');
  assert.equal((await bridge.handle({ id: 2, method: 'getTheme' })).result.mode, 'dark', 'the theme needs no permission');
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
  for (let i = 1; i <= 40; i++) results.push(await flood.handle({ id: i, method: 'getTheme' }));
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


test('hello check', () => {
  assert.equal(isHello({ __addon: 'abcdef0123456789', hello: 1 }, 'abcdef0123456789'), true);
  assert.equal(isHello({ __addon: 'other', hello: 1 }, 'abcdef0123456789'), false);
  assert.equal(isHello({ __addon: 'short', hello: 1 }, 'short'), false);
  assert.equal(isHello(null, 'abcdef0123456789'), false);
});

// ---------- runtime: the frame document holds only our scripts, pinned by hash ----------

const PURIFY = readFileSync(new URL('../../node_modules/dompurify/dist/purify.min.js', import.meta.url), 'utf8');
const sha256b64 = async (text) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64');

test('frame document: only DOMPurify and the host script, both pinned by sha256 in a strict CSP', async () => {
  const assets = await runtimeAssets(PURIFY);
  const doc = frameDocument(assets, 'ab'.repeat(16));
  const scripts = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2, 'exactly two inline scripts');
  assert.deepEqual(scripts, [assets.purify, assets.host]);
  for (const body of scripts) assert.ok(assets.csp.includes(`'sha256-${await sha256b64(body)}'`), 'each script is allowed by its hash');
  const scriptSrc = assets.csp.match(/script-src ([^;]*)/)[1];
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|blob:|data:|\*/, 'no other script can run in the frame');
  for (const d of ["worker-src blob:", "connect-src 'none'", "default-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'"]) {
    assert.ok(assets.csp.includes(d), d);
  }
  assert.ok(doc.includes(`<meta http-equiv="Content-Security-Policy" content="${assets.csp}">`));
  assert.ok(doc.includes(`<meta name="codehub-addon" content="${'ab'.repeat(16)}">`));
  assert.match(frameDocument(assets, '"><script>alert(1)</script>'), /<meta name="codehub-addon" content="[0-9a-f]*"><style>/, 'the token keeps hex only');
  assert.match(assets.host, /^[\x00-\x7f]*$/, 'host script is ASCII (hash-stable)');
  assert.doesNotMatch(assets.purify, /sourceMappingURL/);
  assert.equal(typeof new Function(`return (${hostScript.toString()})`)(), 'function', 'host script has no module dependencies');
  assert.throws(() => cleanPurifySource('x</script><script>evil()'), /cannot be inlined/);
  assert.equal(addonCsp(['A', 'B']).match(/script-src ([^;]*)/)[1], "'sha256-A' 'sha256-B'");
});

test('worker source: SDK first, then the add-on in its own scope; line offset', () => {
  const code = 'var first = 1;\ncodehub.ui.render("<p>x</p>");';
  const { src, offset } = workerSource(code);
  assert.ok(src.startsWith('(function workerSdk('));
  const lines = src.split('\n');
  assert.equal(lines[offset], 'var first = 1;', 'line offset + 1 is the add-on’s first line');
  assert.ok(lines[offset - 1].endsWith('(function(){'));
  assert.ok(src.endsWith('\n}).call(self);'));
  assert.equal(typeof new Function(`return (${workerSdk.toString()})`)(), 'function', 'SDK has no module dependencies');
  assert.equal(workerSource(code, { console: true }).src.includes('{"console":true}'), true);
});

// ---------- the worker SDK against the real bridge host, in a vm context like a CSP-bound worker ----------

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await tick(5);
  }
}

/** Runs workerSource(code) in a vm context with string code generation off (as the frame CSP does). */
function runAddon(code, { perms = [], context = { kind: 'channel', name: 'general', me: { name: 'Ada' }, scope: 'personal' }, handlers = {}, preview = false } = {}) {
  const renders = [];
  const logs = [];
  const calls = [];
  const listeners = [];
  const intervals = new Set();
  const store = { map: {} };
  const theme = { mode: 'dark', tokens: { accent: '#5b8cff' } };
  const bridge = createBridgeHost({
    perms,
    handlers: {
      ready: () => true,
      context: () => context,
      theme: () => theme,
      messages: (n) => toAddonMessages([], {}, n),
      insertText: () => true,
      sendMessage: () => true,
      storage: (op, key, value) => {
        const r = applyStorageOp(store.map, op, key, value);
        store.map = r.map;
        return r.result;
      },
      ...handlers,
    },
  });
  const deliver = (d) => {
    const data = structuredClone(d);
    for (const fn of listeners) fn({ data });
  };
  const sandbox = {
    postMessage: (m) => {
      const d = structuredClone(m);
      if (typeof d.render === 'string') renders.push(d.render);
      else if (typeof d.log === 'string') logs.push(d);
      else if (typeof d.id === 'number') {
        calls.push(d);
        bridge.handle(d).then((reply) => reply && deliver(reply));
      }
    },
    addEventListener: (type, fn) => {
      if (type === 'message') listeners.push(fn);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms).unref();
      intervals.add(t);
      return t;
    },
    clearInterval,
    console: { log() {}, info() {}, warn() {}, error() {} },
  };
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('var self = globalThis;', ctx);
  vm.runInContext(workerSource(code, { console: preview }).src, ctx, { filename: 'addon-worker.js' });
  deliver({ event: 'init', data: initPayload({ perms, theme, context }) });
  return {
    ctx, renders, logs, calls, store, deliver,
    last: () => renders[renders.length - 1] || '',
    click: (id) => deliver({ event: 'ui', data: { type: 'click', id } }),
    stop: () => intervals.forEach((t) => clearInterval(t)),
  };
}

test('SDK: string code generation is off in the worker (the frame CSP has no unsafe-eval)', () => {
  const a = runAddon('codehub.ui.render("<p>x</p>");');
  assert.throws(() => vm.runInContext('eval("1")', a.ctx), (e) => e.name === 'EvalError');
  assert.throws(() => vm.runInContext('new Function("return 1")', a.ctx), (e) => e.name === 'EvalError');
  assert.equal(vm.runInContext('Object.isFrozen(codehub) && Object.getOwnPropertyDescriptor(self, "codehub").writable === false', a.ctx), true);
});

test('SDK: ready, the context permission, calls through the host, errors with codes', async () => {
  const code = `
    var out = [];
    codehub.ready().then(function (i) {
      out.push('ctx:' + JSON.stringify(i.context) + ' perms:' + i.perms.join(',') + ' scope:' + i.scope + ' theme:' + i.theme.mode);
      return codehub.getContext().then(function (c) { out.push('getContext:' + c.name); }, function (e) { out.push('getContext:' + e.code); });
    }).then(function () {
      return codehub.sendMessage('hi').then(function () { out.push('send:ok'); }, function (e) { out.push('send:' + e.code); });
    }).then(function () {
      return codehub.storage.set('k', { a: 1 }).then(function () { return codehub.storage.get('k'); }).then(function (v) { out.push('storage:' + JSON.stringify(v)); }, function (e) { out.push('storage:' + e.code); });
    }).then(function () { codehub.ui.render('<p>' + codehub.ui.escape(out.join(' | ')) + '</p>'); });
  `;
  const without = runAddon(code, { perms: ['storage'] });
  await until(() => without.renders.length);
  assert.equal(without.last(), '<p>ctx:null perms:storage scope:personal theme:dark | getContext:PERMISSION_DENIED | send:PERMISSION_DENIED | storage:{&quot;a&quot;:1}</p>');
  const withCtx = runAddon(code, { perms: ['context', 'send'] });
  await until(() => withCtx.renders.length);
  assert.match(withCtx.last(), /ctx:\{&quot;kind&quot;:&quot;channel&quot;,&quot;name&quot;:&quot;general&quot;.* \| getContext:general \| send:ok \| storage:PERMISSION_DENIED/);
});

test('SDK: ui.render checks its input; ui.on gets events and off() stops them; escape', async () => {
  const a = runAddon(`
    var seen = [];
    var off = codehub.ui.on(function (e) { seen.push(e.type + ':' + e.id + ':' + (e.value === undefined ? '' : JSON.stringify(e.value))); codehub.ui.render('<p>' + codehub.ui.escape(seen.join(',')) + '</p>'); if (seen.length === 2) off(); });
    var bad = [];
    try { codehub.ui.render(42); } catch (e) { bad.push(e.name); }
    try { codehub.ui.render('x'.repeat(${MAX_UI_HTML + 1})); } catch (e) { bad.push(e.name); }
    codehub.ui.render('<p>' + bad.join(',') + ' ' + codehub.ui.escape('<b>"&\\'') + '</p>');
  `);
  assert.equal(a.last(), '<p>TypeError,RangeError &lt;b&gt;&quot;&amp;&#39;</p>');
  a.click('go');
  a.deliver({ event: 'ui', data: { type: 'submit', id: 'f', value: { q: 'v' } } });
  a.click('ignored');
  assert.equal(a.last(), '<p>click:go:,submit:f:{&quot;q&quot;:&quot;v&quot;}</p>');
  assert.equal(a.renders.length, 3);
});

test('SDK: top-level declarations in add-on code cannot replace what the SDK uses', async () => {
  const a = runAddon(`
    function postMessage() { throw new Error('mine'); }
    var addEventListener = null;
    codehub.ready().then(function (i) { codehub.ui.render('<p>still works: ' + i.perms.join(',') + '</p>'); });
  `, { perms: ['storage'] });
  await until(() => a.renders.length);
  assert.equal(a.last(), '<p>still works: storage</p>');
});

test('SDK: console forwarding only in the builder preview', () => {
  const p = runAddon('console.log("hello", { a: 1 }); console.error(new Error("boom"));', { preview: true });
  assert.deepEqual(p.logs, [{ log: 'log', args: ['hello', '{"a":1}'] }, { log: 'error', args: ['Error: boom'] }]);
  const q = runAddon('console.log("hello");');
  assert.deepEqual(q.logs, []);
});

test('init payload: the conversation context only with the context permission', () => {
  const context = { kind: 'dm', name: 'Ada', me: { name: 'Linus' }, scope: 'personal' };
  assert.deepEqual(initPayload({ perms: ['storage'], theme: null, context }), { perms: ['storage'], theme: null, context: null, scope: 'personal' });
  assert.deepEqual(initPayload({ perms: ['context'], theme: { mode: 'dark' }, context }).context, context);
});

// ---------- the shipped examples, running in the worker runtime ----------

const example = (file) => readFileSync(new URL(`../../src/features/addons/examples/${file}`, import.meta.url), 'utf8');

test('shipped examples: worker JavaScript under 64 KB, no network, no HTML page', () => {
  for (const [file, perm] of [['pomodoro.js', 'storage'], ['wordcloud.js', 'readMessages']]) {
    const code = example(file);
    assert.ok(utf8Length(code) < LIMITS.codeBytes, `${file} fits`);
    assert.match(code, /codehub\s*\.ready\(\)/);
    assert.match(code, /codehub\.ui\.render\(/);
    assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|document|window)\b/, `${file} uses only the worker API`);
    assert.doesNotMatch(code, /\b(src|href)\s*=\s*["']?(https?:)?\/\//i, `${file} loads nothing from the network`);
    assert.ok(code.includes(perm === 'storage' ? 'codehub.storage' : 'codehub.getMessages'));
    assert.equal(validateDraft({ name: 'n', icon: 'x', version: '2.0.0', code }).ok, true, `${file} passes the builder checks`);
  }
  const index = readFileSync(new URL('../../src/features/addons/examples/index.js', import.meta.url), 'utf8');
  assert.match(index, /perms: \['storage'\]/);
  assert.match(index, /perms: \['readMessages'\]/);
  assert.match(index, /pomodoro\.js\?raw/);
});

test('Pomodoro example works in the worker runtime: modes, storage, restore', async () => {
  const a = runAddon(example('pomodoro.js'), { perms: ['storage'] });
  try {
    await until(() => a.last().includes('Sessions completed: 0'));
    assert.match(a.last(), /id="time"[^>]*>25:00</);
    assert.match(a.last(), /data-id="mode:focus" aria-pressed="true"/);
    a.click('mode:short');
    await until(() => a.last().includes('Short break selected.'));
    assert.match(a.last(), /id="time"[^>]*>05:00</);
    assert.match(a.last(), /data-id="mode:short" aria-pressed="true"/);
    await until(() => a.store.map.state);
    assert.equal(a.store.map.state.mode, 'short');
    a.click('toggle');
    await until(() => a.last().includes('Short break started.'));
    assert.match(a.last(), />Pause</);
  } finally {
    a.stop();
  }
  // A new run restores the saved state (it keeps counting while closed).
  const b = runAddon(example('pomodoro.js'), { perms: ['storage'] });
  try {
    b.store.map = { state: { mode: 'long', endsAt: 0, left: 600, done: 2 } };
    await until(() => b.last().includes('Sessions completed: 2'));
    assert.match(b.last(), /id="time"[^>]*>10:00</);
    assert.match(b.last(), /data-id="mode:long" aria-pressed="true"/);
  } finally {
    b.stop();
  }
  // Without storage it still runs and says so.
  const c = runAddon(example('pomodoro.js'), { perms: [] });
  try {
    await until(() => c.last().includes('Storage permission not granted'));
  } finally {
    c.stop();
  }
});

test('word cloud example works in the worker runtime: counts words, escapes text, needs readMessages', async () => {
  const msgs = [
    { mid: 'm1', uid: 'u1', ts: 1, body: { text: 'deploy deploy pipeline <img src=x onerror=alert(1)>' } },
    { mid: 'm2', uid: 'u2', ts: 2, body: { text: 'the deploy is green, see https://example.com/x' } },
  ];
  const a = runAddon(example('wordcloud.js'), { perms: ['readMessages'], handlers: { messages: (n) => toAddonMessages(msgs, {}, n) } });
  await until(() => a.last().includes('From the last 2 messages.'));
  const html = a.last();
  assert.match(html, /data-key="w-deploy"[^>]*>deploy<span class="sr">, used 3 times<\/span>/);
  assert.match(html, />pipeline<span class="sr">, used 1 time</);
  assert.doesNotMatch(html, /<img|example\.com/, 'message text is never markup');
  a.click('refresh');
  await until(() => a.calls.filter((c) => c.method === 'getMessages').length === 2);
  const denied = runAddon(example('wordcloud.js'), { perms: [] });
  await until(() => denied.last().includes('needs the “Read messages” permission'));
});

// ---------- removed, re-published or outdated add-ons don't run ----------

test('runBlock: removed listings, another publisher and old-runtime copies never run', () => {
  const m = parseManifest('a1', manifestRaw({ by: 'pub1', rt: RUNTIME_VERSION }));
  const inst = parseInstall('a1', { sha: SHA, name: 'Timer', publisher: 'pub1', rt: RUNTIME_VERSION });
  assert.equal(runBlock(inst, m), null);
  assert.equal(runBlock(inst, null), 'removed', 'unpublished or removed by an app admin');
  assert.equal(runBlock(inst, parseManifest('a1', manifestRaw({ by: 'mallory', rt: RUNTIME_VERSION }))), 'publisher', 're-created under the same id by someone else');
  assert.equal(runBlock(parseInstall('a1', { sha: SHA, name: 'Old' }), m), 'runtime', 'installs from before runtime 2');
  assert.equal(runBlock(parseInstall('a1', { sha: SHA, rt: RUNTIME_VERSION }), m), 'publisher', 'no recorded publisher');
  // An updated listing still from the old runtime, or from another account, can't be accepted.
  assert.equal(updateBlock(inst, parseManifest('a1', manifestRaw({ by: 'pub1' }))), 'runtime');
  assert.equal(updateBlock(inst, parseManifest('a1', manifestRaw({ by: 'mallory', rt: RUNTIME_VERSION }))), 'publisher');
  assert.equal(updateBlock(parseInstall('a1', { sha: SHA }), m), null, 'legacy installs can take the update');
  assert.equal(updateBlock(inst, null), 'removed');
});

test('send confirmation: full-text stats and the arming delay', () => {
  assert.deepEqual(messageStats('ok'), { lines: 1, chars: 2 });
  assert.deepEqual(messageStats('a\n\n\n\n\nhidden at the bottom'), { lines: 6, chars: 26 });
  assert.deepEqual(messageStats('a\r\nb\rc'), { lines: 3, chars: 6 });
  assert.equal(messageStats('😀😀').chars, 2, 'characters, not UTF-16 units');
  assert.deepEqual(messageStats(''), { lines: 0, chars: 0 });
  assert.equal(SEND_ARM_MS, 1000);
});

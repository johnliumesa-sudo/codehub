// Update notice: version comparison, the auto-reload loop guard, input detection and the watcher's states.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_RELOAD_GAP_MS,
  RELOAD_KEY,
  RUNNING_BUILD,
  claimAutoReload,
  createUpdateWatcher,
  isChunkLoadError,
  isNewVersion,
  mightLoseInput,
  parseVersion,
  versionUrl,
} from '../../src/lib/appVersion.js';

const T0 = Date.parse('2026-11-07T10:00:00Z');
const v = (id, t) => ({ v: id, t });

test('parseVersion accepts { v, t } records only', () => {
  assert.deepEqual(parseVersion({ v: 'abc1234', t: '2026-11-07T10:00:00.000Z' }), { v: 'abc1234', t: T0 });
  assert.deepEqual(parseVersion({ v: 'b1x', t: 5 }), { v: 'b1x', t: 5 });
  assert.deepEqual(parseVersion({ v: 'abc1234' }), { v: 'abc1234', t: null });
  assert.deepEqual(parseVersion({ v: 'abc1234', t: 'not a date' }), { v: 'abc1234', t: null });
  for (const bad of [null, undefined, 'abc', 42, [], {}, { v: '' }, { v: 7 }, { v: 'a b' }, { v: '<x>' }, { v: 'x'.repeat(65) }]) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad));
  }
  assert.equal(RUNNING_BUILD, null, 'no build id outside a Vite build');
});

test('isNewVersion: a different id is an update unless it is an older build', () => {
  const running = v('aaa1111', T0);
  assert.equal(isNewVersion(running, v('aaa1111', T0 + 1000)), false, 'same id');
  assert.equal(isNewVersion(running, v('bbb2222', T0 + 1000)), true, 'newer build');
  assert.equal(isNewVersion(running, v('bbb2222', T0 - 1000)), false, 'stale copy of an older build');
  assert.equal(isNewVersion(running, v('bbb2222', null)), true, 'no time: the id decides');
  assert.equal(isNewVersion(v('aaa1111', null), v('bbb2222', T0 - 1000)), true);
  assert.equal(isNewVersion(null, v('bbb2222', T0)), false, 'unknown running build');
  assert.equal(isNewVersion(running, null), false);
});

test('versionUrl keeps the GitHub Pages sub-path and busts caches', () => {
  assert.equal(versionUrl('https://me.github.io/codehub/', 5), 'https://me.github.io/codehub/version.json?t=5');
  assert.equal(versionUrl('https://me.github.io/codehub/index.html#/m/x', 6), 'https://me.github.io/codehub/version.json?t=6');
  assert.equal(versionUrl('http://127.0.0.1:5173/', 7), 'http://127.0.0.1:5173/version.json?t=7');
});

test('isChunkLoadError recognises failed lazy imports in each browser', () => {
  for (const m of [
    'Failed to fetch dynamically imported module: https://x/assets/GamesView-1.js',
    'error loading dynamically imported module: https://x/assets/a.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/a.css',
    'Loading chunk 12 failed.',
  ]) assert.equal(isChunkLoadError(new TypeError(m)), true, m);
  assert.equal(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' })), true);
  for (const e of [null, undefined, new Error('Cannot read properties of undefined'), new Error('PERMISSION_DENIED')]) {
    assert.equal(isChunkLoadError(e), false);
  }
});

function memStorage(init = {}, { throwOnGet = false, throwOnSet = false, dropWrites = false } = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => {
      if (throwOnGet) throw new Error('SecurityError');
      return m.has(k) ? m.get(k) : null;
    },
    setItem: (k, val) => {
      if (throwOnSet) throw new Error('QuotaExceededError');
      if (!dropWrites) m.set(k, String(val));
    },
  };
}

test('claimAutoReload: one automatic reload, never twice from the same build, never in a loop', () => {
  const s = memStorage();
  assert.equal(claimAutoReload({ storage: s, running: 'aaa', now: T0 }), true, 'first failure reloads');
  assert.deepEqual(JSON.parse(s.m.get(RELOAD_KEY)), { from: 'aaa', at: T0 });
  // The reload came back on the same build (stale page) and failed again: ask instead, however late.
  assert.equal(claimAutoReload({ storage: s, running: 'aaa', now: T0 + 1000 }), false);
  assert.equal(claimAutoReload({ storage: s, running: 'aaa', now: T0 + 10 * AUTO_RELOAD_GAP_MS }), false);
  // A newer build failing soon after (A -> B -> A alternation) waits for the gap.
  assert.equal(claimAutoReload({ storage: s, running: 'bbb', now: T0 + 1000 }), false);
  assert.equal(claimAutoReload({ storage: s, running: 'bbb', now: T0 + AUTO_RELOAD_GAP_MS }), true);
  assert.deepEqual(JSON.parse(s.m.get(RELOAD_KEY)), { from: 'bbb', at: T0 + AUTO_RELOAD_GAP_MS });
  // A clock that went backwards still counts as recent.
  assert.equal(claimAutoReload({ storage: s, running: 'ccc', now: T0 + 1000 }), false);
});

test('claimAutoReload refuses when input could be lost or the guard cannot be stored', () => {
  assert.equal(claimAutoReload({ storage: memStorage(), running: 'aaa', now: T0, busy: true }), false);
  assert.equal(claimAutoReload({ storage: memStorage(), running: null, now: T0 }), false);
  assert.equal(claimAutoReload({ storage: memStorage({}, { throwOnGet: true }), running: 'aaa', now: T0 }), false);
  assert.equal(claimAutoReload({ storage: memStorage({}, { throwOnSet: true }), running: 'aaa', now: T0 }), false);
  assert.equal(claimAutoReload({ storage: memStorage({}, { dropWrites: true }), running: 'aaa', now: T0 }), false);
  // A corrupt record is replaced, not trusted.
  const s = memStorage({ [RELOAD_KEY]: '{oops' });
  assert.equal(claimAutoReload({ storage: s, running: 'aaa', now: T0 }), true);
});

function el(tagName, props = {}) {
  return { tagName, type: tagName === 'INPUT' ? 'text' : undefined, value: '', textContent: '', isContentEditable: false, getClientRects: () => [1], ...props };
}
const doc = (els, activeElement = null) => ({ activeElement, querySelectorAll: () => els });

test('mightLoseInput: focused editables and visible fields with text block the automatic reload', () => {
  assert.equal(mightLoseInput(doc([el('INPUT'), el('TEXTAREA')])), false, 'empty fields');
  assert.equal(mightLoseInput(doc([el('TEXTAREA', { value: 'half a message' })])), true);
  assert.equal(mightLoseInput(doc([el('INPUT', { value: '  ' })])), false, 'whitespace only');
  assert.equal(mightLoseInput(doc([el('DIV', { isContentEditable: true, textContent: 'code' })])), true);
  assert.equal(mightLoseInput(doc([], el('TEXTAREA'))), true, 'focused editor, even empty');
  assert.equal(mightLoseInput(doc([], el('BUTTON'))), false);
  assert.equal(mightLoseInput(doc([el('INPUT', { type: 'checkbox', value: 'on' })])), false);
  assert.equal(mightLoseInput(doc([el('INPUT', { readOnly: true, value: 'https://invite' })])), false);
  assert.equal(mightLoseInput(doc([el('INPUT', { disabled: true, value: 'x' })])), false);
  assert.equal(mightLoseInput(doc([el('TEXTAREA', { value: 'hidden', getClientRects: () => [] })])), false, 'not rendered');
  assert.equal(mightLoseInput(null), true);
});

function harness({ remote = v('aaa', T0), ok = true, storage = memStorage(), busy = false, online = true } = {}) {
  const calls = { fetch: [], reload: 0 };
  const h = { remote, ok, busy, online };
  const w = createUpdateWatcher({
    running: v('aaa', T0),
    url: (now) => `https://me.github.io/codehub/version.json?t=${now}`,
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      if (h.ok === 'throw') throw new TypeError('Failed to fetch');
      return { ok: h.ok, json: async () => h.remote };
    },
    storage,
    reload: () => { calls.reload += 1; },
    busy: () => h.busy,
    online: () => h.online,
    now: () => T0 + 1,
  });
  return { w, h, calls, storage };
}

test('watcher: a new build shows the banner, Later hides it until the next build', async () => {
  const { w, h, calls } = harness();
  const seen = [];
  w.subscribe((s) => seen.push(s.kind));
  await w.check();
  assert.deepEqual(w.getState(), { kind: null });
  assert.equal(calls.fetch[0].init.cache, 'no-store');
  assert.match(calls.fetch[0].url, /version\.json\?t=\d+$/);

  h.remote = v('bbb', T0 + 5);
  await w.check();
  assert.deepEqual(w.getState(), { kind: 'update', v: 'bbb' });
  w.dismiss();
  assert.deepEqual(w.getState(), { kind: null });
  await w.check();
  assert.equal(w.getState().kind, null, 'Later holds for the same build');
  h.remote = v('ccc', T0 + 9);
  await w.check();
  assert.deepEqual(w.getState(), { kind: 'update', v: 'ccc' });
  // Back to the running build (rollback of an identical build): nothing to reload.
  h.remote = v('aaa', T0);
  await w.check();
  assert.equal(w.getState().kind, null);
  assert.deepEqual(seen, ['update', null, 'update', null]);
  w.reload();
  assert.equal(calls.reload, 1);
});

test('watcher: failed or odd responses are ignored and checks share one request', async () => {
  const { w, h, calls } = harness({ remote: { nope: true } });
  await w.check();
  h.ok = false;
  h.remote = v('bbb', T0 + 5);
  await w.check();
  h.ok = 'throw';
  await w.check();
  assert.equal(w.getState().kind, null);
  h.ok = true;
  await Promise.all([w.check(), w.check(), w.check()]);
  assert.equal(calls.fetch.length, 4);
  assert.equal(w.getState().kind, 'update');
});

test('watcher: a chunk failure reloads once, then asks; unrelated errors are ignored', async () => {
  const storage = memStorage();
  const first = harness({ storage });
  assert.equal(first.w.loadFailed(new Error('boom')), false);
  assert.equal(first.w.loadFailed(new TypeError('Failed to fetch dynamically imported module: x.js')), true);
  assert.equal(first.calls.reload, 1, 'automatic reload');
  assert.equal(first.w.getState().kind, null);
  // The page came back on the same build and the chunk is still missing.
  const second = harness({ storage });
  second.w.loadFailed(new Error('anything'), true); // vite:preloadError
  assert.equal(second.calls.reload, 0);
  assert.deepEqual(second.w.getState(), { kind: 'chunk', offline: false });
  second.w.dismiss();
  assert.equal(second.w.getState().kind, null);
});

test('watcher: no automatic reload while typing or offline', async () => {
  const busy = harness({ busy: true });
  busy.w.loadFailed(new TypeError('Importing a module script failed.'));
  assert.equal(busy.calls.reload, 0);
  assert.deepEqual(busy.w.getState(), { kind: 'chunk', offline: false });
  assert.equal(busy.storage.m.size, 0, 'the one automatic reload is kept for later');

  const off = harness({ online: false });
  off.w.loadFailed(new TypeError('Importing a module script failed.'));
  assert.equal(off.calls.reload, 0);
  assert.deepEqual(off.w.getState(), { kind: 'chunk', offline: true });
  // A new build found meanwhile doesn't replace the load-failure message.
  off.h.remote = v('bbb', T0 + 5);
  await off.w.check();
  assert.equal(off.w.getState().kind, 'chunk');
  off.w.dismiss();
  await off.w.check();
  assert.equal(off.w.getState().kind, null, 'Later also covers the build found meanwhile');
});

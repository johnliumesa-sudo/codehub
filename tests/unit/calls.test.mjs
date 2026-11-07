// Calls (round 3): call health (slot liveness, ICE servers, the per-peer recovery state machine,
// connection generations), in-call event validation and rate limits, voice & video prefs, and speaking
// detection from receiver audio levels.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKOFF_MS, CONNECT_TIMEOUT_MS, DISCONNECT_GRACE_MS, FIRST_CONNECT_PATIENCE_MS, HB_STALE_MS, MAX_ICE_RESTARTS, POLITE_DELAY_MS,
  STATUS_TEXT, STUN_URLS, bindRemote, buildIceServers, classifySignal, newPeerHealth, noteRebuilt, slotLiveness, stepPeerHealth,
} from '../../src/lib/calls/health.js';
import { REACTIONS, createRateLimiter, encodeEvent, fixRaiseTime, orderHands, parseCallEvent } from '../../src/lib/calls/events.js';
import {
  DEFAULT_PREFS, PREFS_KEY, _resetPrefsCache, audioConstraints, isValidPttKey, keyLabel, loadPrefs, normalizePrefs, savePrefs, subscribePrefs,
} from '../../src/lib/calls/prefs.js';
import { SPEAK_HOLD_MS, SPEAK_THRESHOLD, speakingGate, ssrcLevel, statsLevel, watchRemoteSpeaking } from '../../src/lib/calls/media.js';

// ---------- slots ----------

test('slot liveness: heartbeat age, offline marker, older clients', () => {
  const now = 1_000_000;
  assert.equal(slotLiveness({ uid: 'a', hb: now - 1000 }, now), 'live');
  assert.equal(slotLiveness({ uid: 'a', hb: now - HB_STALE_MS }, now), 'live');
  assert.equal(slotLiveness({ uid: 'a', hb: now - HB_STALE_MS - 1 }, now), 'stale');
  assert.equal(slotLiveness({ uid: 'a', hb: now - 1000, away: true }, now), 'away', 'offline marker (onDisconnect)');
  assert.equal(slotLiveness({ uid: 'a', hb: now - HB_STALE_MS - 1, away: true }, now), 'stale', 'away for 45 s: gone');
  assert.equal(slotLiveness({ uid: 'a', hb: 0 }, now), 'stale', 'legacy offline marker (hb = 0)');
  assert.equal(slotLiveness({ uid: 'a', joinedAt: 1 }, now), 'live', 'no hb: written by an older client, trusted');
  assert.equal(slotLiveness(null, now), 'stale');
  assert.equal(slotLiveness({ hb: now }, now), 'stale', 'no uid');
});

// ---------- ICE servers ----------

test('ICE servers: five Google STUN servers plus at most 4 valid TURN entries', () => {
  assert.deepEqual(STUN_URLS, ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302']);
  assert.deepEqual(buildIceServers(null), [{ urls: STUN_URLS }]);
  const turn = [
    { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' },
    { urls: ['turns:relay.example.com:5349', 'turn:relay.example.com:3478?transport=tcp'] },
    { urls: 'javascript:alert(1)' },
    { urls: 42 },
    null,
    { urls: 'turn:fifth.example.com' },
  ];
  const out = buildIceServers(turn);
  assert.equal(out.length, 3, 'invalid entries dropped, only the first 4 entries considered');
  assert.deepEqual(out[1], { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' });
  assert.deepEqual(out[2], { urls: ['turns:relay.example.com:5349', 'turn:relay.example.com:3478?transport=tcp'] });
  assert.equal(buildIceServers({ a: { urls: 'turn:x.example.com' } }).length, 2, 'RTDB object form accepted');
});

// ---------- recovery state machine ----------

const pcState = (o = {}) => ({ conn: 'new', ice: 'new', signaling: 'stable', hasRemote: false, ...o });

test('recovery: connecting -> connected, statuses and the 20 s timeout', () => {
  const h = newPeerHealth(0);
  assert.deepEqual(stepPeerHealth(h, pcState({ conn: 'connecting', ice: 'checking', hasRemote: true }), { now: 1000, polite: false }), { status: 'connecting', action: null });
  assert.deepEqual(stepPeerHealth(h, pcState({ conn: 'connected', ice: 'connected', hasRemote: true }), { now: 2000, polite: false }), { status: 'connected', action: null });
  assert.equal(h.everConnected, true);
  // Drops: reconnecting, then "couldn't connect" after 20 s down (and keeps trying).
  assert.equal(stepPeerHealth(h, pcState({ conn: 'connecting', ice: 'checking', hasRemote: true }), { now: 3000, polite: false }).status, 'reconnecting');
  assert.equal(stepPeerHealth(h, pcState({ conn: 'connecting', ice: 'checking', hasRemote: true }), { now: 3000 + CONNECT_TIMEOUT_MS, polite: false }).status, 'failed');
  assert.ok(STATUS_TEXT.failed.includes('TURN relay'));
  // Firefox-style: no connectionState, ICE state only.
  const f = newPeerHealth(0);
  assert.equal(stepPeerHealth(f, { ice: 'completed', signaling: 'stable', hasRemote: true }, { now: 10, polite: true }).status, 'connected');
});

test('recovery: failed -> impolite restarts ICE at once, polite 5 s later', () => {
  const imp = newPeerHealth(0);
  stepPeerHealth(imp, pcState({ conn: 'connected', hasRemote: true }), { now: 100, polite: false });
  assert.deepEqual(stepPeerHealth(imp, pcState({ conn: 'failed', ice: 'failed', hasRemote: true }), { now: 5000, polite: false }), { status: 'reconnecting', action: 'restart' });
  const pol = newPeerHealth(0);
  stepPeerHealth(pol, pcState({ conn: 'connected', hasRemote: true }), { now: 100, polite: true });
  assert.equal(stepPeerHealth(pol, pcState({ conn: 'failed', hasRemote: true }), { now: 5000, polite: true }).action, null);
  assert.equal(stepPeerHealth(pol, pcState({ conn: 'failed', hasRemote: true }), { now: 5000 + POLITE_DELAY_MS - 1, polite: true }).action, null);
  assert.equal(stepPeerHealth(pol, pcState({ conn: 'failed', hasRemote: true }), { now: 5000 + POLITE_DELAY_MS, polite: true }).action, 'restart');
});

test('recovery: disconnected for more than 4 s -> ICE restart', () => {
  const h = newPeerHealth(0);
  stepPeerHealth(h, pcState({ conn: 'connected', hasRemote: true }), { now: 100, polite: false });
  const disc = pcState({ conn: 'disconnected', ice: 'disconnected', hasRemote: true });
  assert.equal(stepPeerHealth(h, disc, { now: 1000, polite: false }).action, null);
  assert.equal(stepPeerHealth(h, disc, { now: 1000 + DISCONNECT_GRACE_MS - 1, polite: false }).action, null);
  assert.equal(stepPeerHealth(h, disc, { now: 1000 + DISCONNECT_GRACE_MS, polite: false }).action, 'restart');
  // Coming back resets everything.
  stepPeerHealth(h, pcState({ conn: 'connected', hasRemote: true }), { now: 7000, polite: false });
  assert.equal(h.attempts, 0);
  assert.equal(h.iceRestarts, 0);
  assert.equal(h.downSince, null);
});

test('recovery: capped ICE restarts, then a fresh connection, with backoff; never gives up', () => {
  const h = newPeerHealth(0);
  stepPeerHealth(h, pcState({ conn: 'connected', hasRemote: true }), { now: 0, polite: false });
  const failed = pcState({ conn: 'failed', ice: 'failed', hasRemote: true });
  let t = 1000;
  const actions = [];
  const times = [];
  for (let i = 0; i < 400; i++, t += 500) {
    const { action } = stepPeerHealth(h, failed, { now: t, polite: false });
    if (action) {
      actions.push(action);
      times.push(t);
      if (action === 'rebuild') noteRebuilt(h, t);
    }
  }
  assert.deepEqual(actions.slice(0, MAX_ICE_RESTARTS + 1), ['restart', 'restart', 'restart', 'rebuild']);
  assert.deepEqual(actions.slice(4, 8), ['restart', 'restart', 'restart', 'rebuild'], 'the cycle repeats');
  const gaps = times.slice(1).map((x, i) => x - times[i]);
  assert.deepEqual(gaps.slice(0, 6), [...BACKOFF_MS, 30_000]);
  assert.ok(actions.length >= 9, 'keeps retrying every 30 s');
});

test('recovery: never connected -> fresh connection (polite has no offer yet) or restart; stuck negotiation rebuilds', () => {
  const pol = newPeerHealth(0);
  const waiting = pcState({ conn: 'new', ice: 'new', hasRemote: false });
  assert.equal(stepPeerHealth(pol, waiting, { now: FIRST_CONNECT_PATIENCE_MS, polite: true }).action, null);
  assert.equal(stepPeerHealth(pol, waiting, { now: FIRST_CONNECT_PATIENCE_MS + POLITE_DELAY_MS, polite: true }).action, 'rebuild');
  const imp = newPeerHealth(0);
  const stuck = pcState({ conn: 'new', signaling: 'have-local-offer', hasRemote: false });
  assert.equal(stepPeerHealth(imp, stuck, { now: FIRST_CONNECT_PATIENCE_MS - 1, polite: false }).action, null);
  assert.equal(stepPeerHealth(imp, stuck, { now: FIRST_CONNECT_PATIENCE_MS, polite: false }).action, 'rebuild');
  const checking = newPeerHealth(0);
  assert.equal(stepPeerHealth(checking, pcState({ conn: 'connecting', ice: 'checking', hasRemote: true }), { now: FIRST_CONNECT_PATIENCE_MS, polite: false }).action, 'restart');
});

test('recovery: a closed connection object is rebuilt at once (at most once a second)', () => {
  const h = newPeerHealth(0);
  stepPeerHealth(h, pcState({ conn: 'connected', hasRemote: true }), { now: 0, polite: true });
  const closed = pcState({ conn: 'closed', ice: 'closed', signaling: 'closed' });
  assert.deepEqual(stepPeerHealth(h, closed, { now: 5000, polite: true }), { status: 'reconnecting', action: 'rebuild' });
  assert.equal(stepPeerHealth(h, closed, { now: 5500, polite: true }).action, null);
  assert.equal(stepPeerHealth(h, closed, { now: 6000, polite: true }).action, 'rebuild');
  const remoteClosed = newPeerHealth(0); // DTLS closed by the other side: signaling still stable
  stepPeerHealth(remoteClosed, pcState({ conn: 'connected', hasRemote: true }), { now: 0, polite: false });
  assert.equal(stepPeerHealth(remoteClosed, pcState({ conn: 'closed', ice: 'disconnected', hasRemote: true }), { now: 5000, polite: false }).action, 'rebuild');
});

// ---------- connection generations ----------

/** Two peers that exchange messages through classifySignal/bindRemote like CallSession does. */
function peer(name) {
  return { name, gen: 1, remoteGen: null, boundGen: null, alias: null };
}
function rebuild(p) {
  p.gen += 1;
  p.boundGen = null;
  p.alias = null;
}
const msg = (from, kind, extra = {}) => ({ g: from.gen, ...(from.remoteGen != null ? { rg: from.remoteGen } : {}), ...(kind === 'offer' || kind === 'answer' ? { desc: { type: kind } } : kind === 'cand' ? { cand: {} } : { hello: 1 }), ...extra });
function deliver(to, m) {
  const c = classifySignal(to, m);
  if (!c.ok) return c;
  if (c.fresh) {
    if (c.rebuild) rebuild(to);
    bindRemote(to, c.g, c.rg);
  }
  return c;
}

test('generations: first contact, then the impolite side starts over', () => {
  const A = peer('A'); // impolite
  const B = peer('B'); // polite
  assert.equal(deliver(B, msg(A, 'offer')).ok, true);
  assert.equal(deliver(A, msg(B, 'answer')).ok, true);
  assert.equal(B.boundGen, 1);
  assert.equal(A.boundGen, 1);
  const oldCand = msg(B, 'cand');
  // A's connection dies: it builds generation 2 and offers.
  rebuild(A);
  const offer = msg(A, 'offer');
  const lateCand = msg(A, 'cand'); // sent before A hears back: still addresses B's generation 1
  const r = deliver(B, offer);
  assert.equal(r.ok && r.rebuild, true, 'B was talking to A1, so B starts over too');
  assert.equal(B.gen, 2);
  assert.equal(deliver(B, lateCand).ok, true, 'alias: A2 may keep using B1 until it hears from B2');
  assert.equal(deliver(A, oldCand).ok, false, 'a candidate from B1 is not for A2');
  const ans = deliver(A, msg(B, 'answer'));
  assert.equal(ans.ok && !ans.rebuild, true, 'A2 was fresh: no second rebuild');
  assert.equal(deliver(B, msg(A, 'cand')).ok, true);
  assert.equal(deliver(B, { g: 1, rg: 1, cand: {} }).ok, false, 'leftover from A1 dropped');
});

test('generations: polite side starts over with hello; simultaneous restarts converge without ping-pong', () => {
  const A = peer('A');
  const B = peer('B');
  deliver(B, msg(A, 'offer'));
  deliver(A, msg(B, 'answer'));
  // B's connection object is closed: B rebuilds and says hello (it can't offer first).
  rebuild(B);
  const r = deliver(A, msg(B, 'hello'));
  assert.equal(r.ok && r.rebuild, true);
  assert.equal(A.gen, 2);
  const r2 = deliver(B, msg(A, 'offer'));
  assert.equal(r2.ok && !r2.rebuild, true);
  assert.equal(deliver(A, msg(B, 'answer')).ok, true);
  // Both give up at the same moment.
  rebuild(A);
  rebuild(B);
  const offer = msg(A, 'offer');
  const hello = msg(B, 'hello');
  const x = deliver(B, offer);
  const y = deliver(A, hello);
  assert.equal(x.ok && !x.rebuild, true);
  assert.equal(y.ok && !y.rebuild, true);
  const gens = [A.gen, B.gen];
  assert.equal(deliver(A, msg(B, 'answer')).ok, true);
  assert.deepEqual([A.gen, B.gen], gens, 'nobody rebuilt again');
});

test('generations: answers for an older connection of mine are dropped; legacy messages pass', () => {
  const A = peer('A');
  const B = peer('B');
  deliver(B, msg(A, 'offer'));
  deliver(A, msg(B, 'answer'));
  rebuild(A); // A3 would get confused by an answer to A1's offer
  assert.equal(classifySignal(A, { g: 1, rg: 1, desc: { type: 'answer' } }).ok, false);
  assert.equal(classifySignal(A, { g: 2, rg: 1, desc: { type: 'answer' } }).ok, false, 'fresh remote, but an answer for A1');
  assert.deepEqual(classifySignal(A, { desc: { type: 'offer' } }), { ok: true, legacy: true });
  assert.equal(classifySignal(A, { g: -1, desc: {} }).legacy, true, 'junk generation numbers are ignored');
});

// ---------- in-call events ----------

test('events: only well-formed, small, known events are accepted', () => {
  assert.deepEqual(parseCallEvent(encodeEvent({ t: 'hand', up: true, at: 5 })), { t: 'hand', up: true, at: 5 });
  assert.deepEqual(parseCallEvent('{"t":"hand","up":false}'), { t: 'hand', up: false, at: null });
  assert.deepEqual(parseCallEvent(encodeEvent({ t: 'react', e: '🎉' })), { t: 'react', e: '🎉' });
  assert.deepEqual(parseCallEvent(encodeEvent({ t: 'state', hand: { up: true, at: 9 } })), { t: 'state', hand: { up: true, at: 9 } });
  for (const bad of [
    '{"t":"react","e":"<img src=x>"}', '{"t":"react","e":"💩"}', '{"t":"hand","up":"yes"}', '{"t":"hand"}', '{"t":"state","hand":7}',
    '{"t":"kick","uid":"x"}', '[1]', 'null', 'not json', `{"t":"react","e":"🎉","pad":"${'x'.repeat(300)}"}`, 42, null,
  ]) assert.equal(parseCallEvent(bad), null, String(bad).slice(0, 40));
  assert.equal(parseCallEvent('{"t":"hand","up":true,"at":"soon"}').at, null);
  assert.equal(REACTIONS.length, 8);
});

test('events: rate limiter refills over time per key', () => {
  const rl = createRateLimiter({ capacity: 3, refillMs: 1000 });
  assert.deepEqual([rl.take('a', 0), rl.take('a', 1), rl.take('a', 2), rl.take('a', 3)], [true, true, true, false]);
  assert.equal(rl.take('b', 3), true, 'separate bucket per sender');
  assert.equal(rl.take('a', 999), false);
  assert.equal(rl.take('a', 1002), true, 'one token back after a second');
  assert.equal(rl.take('a', 1003), false);
  assert.equal(rl.take('a', 10_000), true);
  rl.forget('a');
  assert.equal(rl.take('a', 10_001), true);
});

test('events: raised hands ordered by time; implausible clocks replaced', () => {
  const hands = new Map([['zed', 300], ['amy', 100], ['bob', 300]]);
  assert.deepEqual(orderHands(hands).map((h) => h.uid), ['amy', 'bob', 'zed']);
  assert.equal(fixRaiseTime(1_000_000, 1_000_500), 1_000_000);
  assert.equal(fixRaiseTime(1, 1_000_000_000), 1_000_000_000);
  assert.equal(fixRaiseTime(null, 77), 77);
});

// ---------- prefs ----------

test('prefs: normalize, constraints, key labels', () => {
  assert.deepEqual(normalizePrefs(null), { ...DEFAULT_PREFS });
  const p = normalizePrefs({ audioIn: 'mic1', ec: false, ns: 'no', ptt: true, pttKey: 'Escape', junk: 1 });
  assert.deepEqual(p, { ...DEFAULT_PREFS, audioIn: 'mic1', ec: false, ptt: true });
  assert.equal(normalizePrefs({ pttKey: 'KeyT' }).pttKey, 'KeyT');
  assert.equal(normalizePrefs({ pttKey: '<b>' }).pttKey, 'Backquote');
  assert.deepEqual(audioConstraints(p), { echoCancellation: false, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'mic1' } });
  assert.deepEqual(audioConstraints(p, ''), { echoCancellation: false, noiseSuppression: true, autoGainControl: true });
  assert.equal(keyLabel('Backquote'), '` (backquote)');
  assert.equal(keyLabel('KeyV'), 'V');
  assert.equal(keyLabel('Digit4'), '4');
  assert.equal(keyLabel('ShiftLeft'), 'Shift Left');
  assert.equal(isValidPttKey('Tab'), false);
  assert.equal(isValidPttKey('F13'), true);
});

test('prefs: saved locally, merged, and broadcast to subscribers', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    _resetPrefsCache();
    store.set(PREFS_KEY, JSON.stringify({ audioIn: 'old-mic' })); // what the first calls release saved
    assert.equal(loadPrefs().audioIn, 'old-mic');
    const seen = [];
    const off = subscribePrefs((x) => seen.push(x.ptt));
    savePrefs({ ptt: true });
    off();
    savePrefs({ ns: false });
    assert.deepEqual(seen, [true]);
    assert.deepEqual(JSON.parse(store.get(PREFS_KEY)), { ...DEFAULT_PREFS, audioIn: 'old-mic', ptt: true, ns: false });
  } finally {
    delete globalThis.localStorage;
    _resetPrefsCache();
  }
});

// ---------- speaking detection ----------

test('speaking gate: on above the threshold, off once nothing loud came for the hold time', () => {
  const seen = [];
  const gate = speakingGate((on) => seen.push(on));
  gate(SPEAK_THRESHOLD, 0); // not above
  assert.deepEqual(seen, []);
  gate(0.2, 100);
  gate(0.01, 100 + SPEAK_HOLD_MS - 1);
  assert.deepEqual(seen, [true]);
  gate(0.01, 100 + SPEAK_HOLD_MS);
  assert.deepEqual(seen, [true, false]);
  gate(0.01, 5_000);
  assert.deepEqual(seen, [true, false]);
});

const ssrc = (entries) => ({ getSynchronizationSources: () => entries });

test('ssrcLevel: newest packet level, 0 before audio or once packets stop, null without levels', () => {
  const mem = {};
  assert.equal(ssrcLevel(ssrc([]), mem, 0), 0);
  const older = { source: 1, timestamp: 900, rtpTimestamp: 10, audioLevel: 0.9 };
  assert.equal(ssrcLevel(ssrc([older, { source: 2, timestamp: 1000, rtpTimestamp: 5, audioLevel: 0.2 }]), mem, 1000), 0.2);
  // The same entry 400 ms later still counts; at 500 ms without a new packet it is stale.
  const same = ssrc([{ source: 2, timestamp: 1000, rtpTimestamp: 5, audioLevel: 0.2 }]);
  assert.equal(ssrcLevel(same, mem, 1400), 0.2);
  assert.equal(ssrcLevel(same, mem, 1500), 0);
  assert.equal(ssrcLevel(ssrc([{ source: 2, timestamp: 1510, rtpTimestamp: 6, audioLevel: 0.3 }]), mem, 1510), 0.3);
  assert.equal(ssrcLevel(ssrc([{ source: 2, timestamp: 1600, rtpTimestamp: 7 }]), mem, 1600), null);
});

const report = (...entries) => new Map(entries.map((e, i) => [String(i), e]));

test('statsLevel: RMS since the last poll from audio energy, else audioLevel; null without either', () => {
  const mem = {};
  assert.equal(statsLevel(report({ type: 'outbound-rtp', kind: 'audio' }), mem), 0);
  const inbound = (e, d, extra = {}) => report({ type: 'inbound-rtp', kind: 'video', totalSamplesDuration: 99 }, { type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: e, totalSamplesDuration: d, ...extra });
  assert.equal(statsLevel(inbound(1, 10, { audioLevel: 0.4 }), mem), 0.4); // first sample: no interval yet
  assert.ok(Math.abs(statsLevel(inbound(1.004, 10.1), mem) - 0.2) < 1e-9); // 0.2^2 * 0.1 s more => RMS 0.2
  assert.equal(statsLevel(inbound(1.004, 10.1), mem), 0); // nothing new
  assert.equal(statsLevel(report({ type: 'inbound-rtp', kind: 'audio', audioLevel: 0.05 }), {}), 0.05);
  assert.equal(statsLevel(report({ type: 'inbound-rtp', kind: 'audio' }), {}), null);
});

/** Run `fn(clock)` with mocked intervals and Date; `advance(ms)` moves time in 5 ms steps. */
async function withClock(fn) {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const advance = async (ms) => {
    for (let i = 0; i < ms; i += 5) {
      mock.timers.tick(5);
      await new Promise((r) => setImmediate(r));
    }
  };
  try {
    await fn(advance);
  } finally {
    mock.timers.reset();
  }
}

test('remote speaking: a 40 ms sound in the receiver levels is caught, held, and released', async () => {
  await withClock(async (advance) => {
    let reads = 0;
    // A packet every 20 ms; loud only between 1000 and 1040 ms.
    const receiver = {
      getSynchronizationSources() {
        reads += 1;
        const t = Math.floor(Date.now() / 20) * 20;
        return t ? [{ source: 7, timestamp: t, rtpTimestamp: t * 48, audioLevel: t >= 1000 && t < 1040 ? 0.5 : 0.001 }] : [];
      },
      getStats: () => { throw new Error('not used while levels are available'); },
    };
    const seen = [];
    const stop = watchRemoteSpeaking(receiver, (on) => seen.push([on, Date.now()]), { now: () => Date.now() });
    await advance(990);
    assert.deepEqual(seen, []);
    await advance(100);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], true);
    await advance(1_000);
    assert.equal(seen.length, 2);
    assert.equal(seen[1][0], false);
    assert.ok(seen[1][1] - seen[0][1] >= SPEAK_HOLD_MS && seen[1][1] - seen[0][1] <= SPEAK_HOLD_MS + 80);
    stop();
    const n = reads;
    await advance(500);
    assert.equal(reads, n); // stopped: no more reads
  });
});

test('remote speaking: falls back to stats when packets carry no level, then to nothing it cannot read', async () => {
  await withClock(async (advance) => {
    let stats = 0;
    let energy = 0;
    const receiver = {
      getSynchronizationSources: () => [{ source: 1, timestamp: Date.now(), rtpTimestamp: Date.now() }],
      getStats: async () => {
        stats += 1;
        energy += 0.2 * 0.2 * 0.14; // RMS 0.2 over each 140 ms
        return report({ type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: energy, totalSamplesDuration: stats * 0.14 });
      },
    };
    const seen = [];
    const stop = watchRemoteSpeaking(receiver, (on) => seen.push(on), { now: () => Date.now() });
    await advance(1_000);
    assert.ok(stats >= 4 && stats <= 7, `stats polled every 140 ms (${stats})`);
    assert.deepEqual(seen, [true]);
    stop();
    const n = stats;
    await advance(500);
    assert.equal(stats, n);
    assert.deepEqual(seen, [true]);
    // No levels anywhere and no Web Audio here: stays quiet instead of throwing.
    const quiet = watchRemoteSpeaking({ getStats: async () => report({ type: 'inbound-rtp', kind: 'audio' }) }, () => assert.fail('no level'));
    await advance(500);
    quiet();
  });
});

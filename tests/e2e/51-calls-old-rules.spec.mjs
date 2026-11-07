// Calls keep working while the published database rules are older than the app.
//
// The rules are pasted into the Firebase console by hand after a deploy, so for a while the live app can
// run against rules from before call heartbeats: a slot with `hb` / `away` is refused there (`$other`
// is false). Every slot claim was then refused and the app said "This call is full (6 people max)" with
// nobody in the call. This file loads such rules (today's rules without `hb` / `away` on call slots) and
// checks that a voice channel and a DM call still connect, and that a refused write is reported as what it
// is, never as a full call.
import { readFileSync } from 'node:fs';
import { test, expect, createServer, makeInvite, joinServer, uid, adminGet } from './fixtures.mjs';
import { DB, NS, RULES } from './global-setup.mjs';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  permissions: ['camera', 'microphone'],
});

/** Today's rules as they were before call heartbeats: slots accept no `hb` / `away`. */
function rulesBeforeHeartbeats() {
  const doc = JSON.parse(readFileSync(RULES, 'utf8'));
  const slots = [doc.rules.calls.$scope.slots.$slot, doc.rules.vcalls.$sid.$cid.slots.$slot];
  for (const s of slots) {
    if (!s.hb || !s.away) throw new Error('rules layout changed: call slots have no hb/away to remove');
    delete s.hb;
    delete s.away;
    s['.write'] = s['.write'].replace(" || data.child('hb').val() < now - 45000", '');
  }
  return JSON.stringify(doc);
}

async function loadRules(text) {
  const r = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: text });
  if (!r.ok) throw new Error(`loading rules failed: ${r.status} ${await r.text()}`);
}

test.beforeAll(async () => {
  await loadRules(rulesBeforeHeartbeats());
});
test.afterAll(async () => {
  await loadRules(readFileSync(RULES, 'utf8'));
});

async function trackPeers(page) {
  await page.evaluate(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Orig {
      constructor(...a) {
        super(...a);
        window.__pcs.push(this);
      }
    };
  });
}
const live = (page) => page.evaluate(() => window.__pcs.filter((p) => p.signalingState !== 'closed').map((p) => p.connectionState).sort().join(','));

async function pair(users) {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Hub');
  await joinServer(bob, await makeInvite(alice), 'Hub');
  return { alice, bob, a: await uid(alice), b: await uid(bob) };
}

const joinVoice = (page, sid, cid, me) => page.evaluate(async ({ sid, cid, me }) => {
  const { voiceScope } = await import('/src/lib/calls/core.js');
  const { joinCall } = await import('/src/lib/calls/useCall.js');
  const s = await joinCall(voiceScope(sid, cid), me, { kind: 'audio', ring: false });
  return { status: s.status, error: s.error || '' };
}, { sid, cid, me });

test('old rules: one person can join an empty voice channel, a second one connects, leaving cleans up', async ({ users }) => {
  const { alice, bob, a, b } = await pair(users);
  await trackPeers(alice);
  await trackPeers(bob);
  const sid = Object.keys((await adminGet(`userServers/${a}`)) || {})[0];
  const cid = await alice.evaluate(async ({ sid }) => {
    const { createChannel } = await import('/src/lib/servers.js');
    return createChannel(sid, { type: 'voice', name: 'Lounge' });
  }, { sid });

  // Alone in the channel: this used to fail with "This call is full (6 people max)".
  expect(await joinVoice(alice, sid, cid, a)).toEqual({ status: 'live', error: '' });
  let slots = (await adminGet(`vcalls/${sid}/${cid}/slots`)) || {};
  expect(Object.values(slots).map((s) => s.uid)).toEqual([a]);
  expect(Object.values(slots)[0].hb).toBeUndefined(); // the shape these rules accept

  expect(await joinVoice(bob, sid, cid, b)).toEqual({ status: 'live', error: '' });
  for (const p of [alice, bob]) await expect.poll(() => live(p), { timeout: 40_000 }).toBe('connected');

  // Slots without a heartbeat count as live: nobody prunes the other as a ghost.
  await alice.waitForTimeout(3_000);
  slots = (await adminGet(`vcalls/${sid}/${cid}/slots`)) || {};
  expect(Object.values(slots).map((s) => s.uid).sort()).toEqual([a, b].sort());

  // Bob closes his tab: the legacy disconnect handler removes his slot.
  await bob.close();
  await expect.poll(async () => Object.values((await adminGet(`vcalls/${sid}/${cid}/slots`)) || {}).map((s) => s.uid), { timeout: 30_000 }).toEqual([a]);
});

test('old rules: a DM call rings, connects, and the caller is never told the call is full', async ({ users }) => {
  const { alice, bob, a, b } = await pair(users);
  await trackPeers(alice);
  await trackPeers(bob);
  const dmId = await alice.evaluate(async ({ a, b }) => {
    const { openDm } = await import('/src/lib/servers.js');
    const { joinCall } = await import('/src/lib/calls/useCall.js');
    const id = await openDm(a, b);
    const s = await joinCall(`dm_${id}`, a, { kind: 'audio', ring: true });
    if (s.status !== 'live') throw new Error(`caller session ${s.status}: ${s.error}`);
    return id;
  }, { a, b });
  await bob.getByTitle('Accept').click({ timeout: 30_000 });
  for (const p of [alice, bob]) await expect.poll(() => live(p), { timeout: 40_000 }).toBe('connected');
  const slots = (await adminGet(`calls/dm_${dmId}/slots`)) || {};
  expect(Object.values(slots).map((s) => s.uid).sort()).toEqual([a, b].sort());
  await expect(alice.getByText(/call is full/i)).toHaveCount(0);
  await expect(bob.getByText(/call is full/i)).toHaveCount(0);
});

test('a refused slot write is reported as refused, not as a full call', async ({ users }) => {
  const { alice, a } = await pair(users);
  const sid = Object.keys((await adminGet(`userServers/${a}`)) || {})[0];
  // A voice channel with no call started (no call id): the rules refuse any slot there.
  const cid = await alice.evaluate(async ({ sid }) => {
    const { createChannel } = await import('/src/lib/servers.js');
    return createChannel(sid, { type: 'voice', name: 'Quiet' });
  }, { sid });
  const msg = await alice.evaluate(async ({ sid, cid, me }) => {
    const { claimSlot, voiceScope } = await import('/src/lib/calls/core.js');
    try {
      await claimSlot(voiceScope(sid, cid), me, { mic: true, cam: false, screen: false });
      return 'joined';
    } catch (e) {
      return e.message;
    }
  }, { sid, cid, me: a });
  expect(msg).not.toMatch(/full/i);
  expect(msg).toMatch(/refused|permission/i);
});

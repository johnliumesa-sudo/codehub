// Two- and three-browser WebRTC calls with fake camera + mic. Calls are started through the app's own
// modules (the same instances Vite serves to the page) and answered through the real incoming-call UI.
// Regression: signals carry the sender's slot joinedAt; it must be the server-stored value or every
// signal is dropped and peers sit at "Connecting…" forever.
import { test, expect, createServer, makeInvite, joinServer, uid, adminGet } from './fixtures.mjs';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['camera', 'microphone'] });

async function watchPeers(page) {
  const log = [];
  // Signaling and slot writes must never be refused. (A ring refused by the 3 s notification
  // throttle is an `update at /` and is retried by ringCall, so it isn't counted here.)
  page.on('console', (m) => { if (/(signal|calls)\/.*permission_denied/.test(m.text())) log.push(m.text().slice(0, 240)); });
  await page.evaluate(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    const t0 = Date.now();
    window.RTCPeerConnection = class extends Orig {
      constructor(...a) {
        super(...a);
        this.__log = [];
        const L = (x) => this.__log.push(`${Date.now() - t0}:${x}`);
        this.__L = L;
        window.__pcs.push(this);
        this.addEventListener('signalingstatechange', () => L(`sig=${this.signalingState}`));
        this.addEventListener('connectionstatechange', () => L(`conn=${this.connectionState}`));
        this.addEventListener('icecandidate', (e) => L(e.candidate ? 'lcand' : 'lcand-end'));
      }
      async setRemoteDescription(d) { this.__L(`setRemote(${d?.type})`); try { return await super.setRemoteDescription(d); } catch (e) { this.__L(`setRemote-ERR ${e.name}`); throw e; } }
      async setLocalDescription(d) { this.__L(`setLocal(${d?.type || ''})`); try { return await super.setLocalDescription(d); } catch (e) { this.__L(`setLocal-ERR ${e.name}`); throw e; } }
      async addIceCandidate(c) { this.__L('rcand'); try { return await super.addIceCandidate(c); } catch (e) { this.__L(`rcand-ERR ${e.name}`); throw e; } }
      close() { this.__L('close'); return super.close(); }
    };
  });
  return log;
}
const states = (page) => page.evaluate(() => window.__pcs.filter((p) => p.signalingState !== 'closed').map((p) => p.connectionState).sort().join(','));
const liveVideo = (page) => page.evaluate(() => window.__pcs.filter((p) => p.signalingState !== 'closed')
  .every((p) => p.getReceivers().some((r) => r.track?.kind === 'video' && r.track.readyState === 'live')));

const dump = (page) => page.evaluate(() => window.__pcs.map((p) => p.__log.join(' ')).join('\n   '));
async function expectUp(pages, peersEach, video) {
  const want = Array(peersEach).fill('connected').join(',');
  try {
    for (const p of pages) await expect.poll(() => states(p), { timeout: 30_000 }).toBe(want);
  } catch (e) {
    for (const [i, p] of pages.entries()) console.log(`### page ${i}\n   ${await dump(p)}`);
    throw e;
  }
  await pages[0].waitForTimeout(10_000); // the old bug showed up as a drop shortly after "Connecting…"
  for (const p of pages) expect(await states(p)).toBe(want);
  if (video) for (const p of pages) expect(await liveVideo(p)).toBe(true);
}

async function pair(users) {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Hub');
  await joinServer(bob, await makeInvite(alice), 'Hub');
  return { alice, bob, a: await uid(alice), b: await uid(bob) };
}

for (const kind of ['audio', 'video']) {
  test(`DM ${kind} call connects and stays up`, async ({ users }) => {
    const { alice, bob, a, b } = await pair(users);
    const logs = [await watchPeers(alice), await watchPeers(bob)];
    const dmId = await alice.evaluate(async ({ a, b, kind }) => {
      const { openDm } = await import('/src/lib/servers.js');
      const { joinCall } = await import('/src/lib/calls/useCall.js');
      const id = await openDm(a, b);
      const s = await joinCall(`dm_${id}`, a, { kind, ring: true });
      if (s.status !== 'live') throw new Error(`caller session ${s.status}: ${s.error}`);
      return id;
    }, { a, b, kind });
    await bob.getByTitle('Accept').click({ timeout: 30_000 });
    await expectUp([alice, bob], 1, kind === 'video');
    const slots = (await adminGet(`calls/dm_${dmId}/slots`)) || {};
    expect(Object.values(slots).map((s) => s.uid).sort()).toEqual([a, b].sort());
    if (kind === 'audio') {
      // Camera switched on mid-call (renegotiation, offered by whichever side needs it) reaches the other side.
      await bob.evaluate(async () => (await import('/src/lib/calls/useCall.js')).callActions.toggleCam());
      await expect.poll(() => liveVideo(alice), { timeout: 20_000 }).toBe(true);
      expect(await states(alice)).toBe('connected');
    }
    expect(logs.flat()).toEqual([]);
  });
}

test('group video call: three people form a full mesh', async ({ users }) => {
  const { alice, bob, a, b } = await pair(users);
  const carol = await users('carol');
  const c = await uid(carol);
  const logs = [await watchPeers(alice), await watchPeers(bob), await watchPeers(carol)];
  await alice.evaluate(async ({ a, b, c }) => {
    const { createGroup } = await import('/src/lib/groups.js');
    const { joinCall } = await import('/src/lib/calls/useCall.js');
    const gid = await createGroup(a, { name: 'Trio', memberUids: [b, c] });
    const s = await joinCall(`grp_${gid}`, a, { kind: 'video', ring: true });
    if (s.status !== 'live') throw new Error(`caller session ${s.status}: ${s.error}`);
  }, { a, b, c });
  await bob.getByTitle('Accept').click({ timeout: 30_000 });
  await carol.getByTitle('Accept').click({ timeout: 30_000 });
  await expectUp([alice, bob, carol], 2, true);
  expect(logs.flat()).toEqual([]);
});

test('server voice channel: two members connect', async ({ users }) => {
  const { alice, bob, a, b } = await pair(users);
  const logs = [await watchPeers(alice), await watchPeers(bob)];
  const sid = Object.keys((await adminGet(`userServers/${a}`)) || {})[0]; // alice's only server
  const cid = await alice.evaluate(async ({ sid }) => {
    const { createChannel } = await import('/src/lib/servers.js');
    return createChannel(sid, { type: 'voice', name: 'Lounge' });
  }, { sid });
  for (const [page, me] of [[alice, a], [bob, b]]) {
    await page.evaluate(async ({ sid, cid, me }) => {
      const { voiceScope } = await import('/src/lib/calls/core.js');
      const { joinCall } = await import('/src/lib/calls/useCall.js');
      const s = await joinCall(voiceScope(sid, cid), me, { kind: 'audio', ring: false });
      if (s.status !== 'live') throw new Error(`voice session ${s.status}: ${s.error}`);
    }, { sid, cid, me });
  }
  await expectUp([alice, bob], 1, false);
  const slots = (await adminGet(`vcalls/${sid}/${cid}/slots`)) || {};
  expect(Object.values(slots).length).toBe(2);
  expect(logs.flat()).toEqual([]);
});

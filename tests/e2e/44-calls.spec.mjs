// Round 3 calls: reliability (a killed connection comes back on either side, "couldn't connect" status
// with retries until the network allows it, ghost slots of closed / crashed / frozen tabs disappear and
// a frozen tab rejoins, leaving cleans up, audio never waits for a camera), device settings, push-to-talk
// and speaking rings, raise hand and reactions, spotlight / fullscreen / picture-in-picture and screen
// share auto-spotlight. Two real browsers with fake camera + mic.
import { test, expect, createServer, makeInvite, joinServer, uid, adminGet } from './fixtures.mjs';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  permissions: ['camera', 'microphone'],
});

/** Track every RTCPeerConnection the page creates (window.__pcs). */
async function trackPeers(page) {
  await page.evaluate(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.__sld = 0;
    window.RTCPeerConnection = class extends Orig {
      constructor(...a) {
        super(...a);
        window.__pcs.push(this);
      }
      setLocalDescription(...a) {
        window.__sld += 1; // every offer or answer, including ICE restarts
        return super.setLocalDescription(...a);
      }
    };
  });
}
const negotiations = async (...pages) => {
  let n = 0;
  for (const p of pages) n += await p.evaluate(() => window.__sld);
  return n;
};
const live = (page) => page.evaluate(() => window.__pcs.filter((p) => p.signalingState !== 'closed').map((p) => p.connectionState).sort().join(','));
const pcCount = (page) => page.evaluate(() => window.__pcs.length);
async function waitUp(pages, peersEach = 1, timeout = 40_000) {
  const want = Array(peersEach).fill('connected').join(',');
  for (const p of pages) await expect.poll(() => live(p), { timeout }).toBe(want);
}
/** Bytes of audio received over the live connections (grows while audio flows). */
const audioIn = (page) => page.evaluate(async () => {
  let n = 0;
  for (const pc of window.__pcs.filter((p) => p.connectionState === 'connected')) {
    (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.bytesReceived || 0; });
  }
  return n;
});
async function expectAudioFlowing(page) {
  const before = await audioIn(page);
  await expect.poll(() => audioIn(page), { timeout: 10_000 }).toBeGreaterThan(before + 1000);
}
/** Highest value a level meter shows over `ms` (the fake microphone beeps, so sample often). */
const meterPeak = (page, selector, ms = 4_000) => page.evaluate(async ({ selector, ms }) => {
  let peak = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    peak = Math.max(peak, Number(document.querySelector(selector)?.getAttribute('aria-valuenow')) || 0);
    await new Promise((r) => setTimeout(r, 40));
  }
  return peak;
}, { selector, ms });
const micEnabled = (page) => page.evaluate(() => {
  const pc = window.__pcs.find((p) => p.signalingState !== 'closed');
  return pc?.getSenders().find((s) => s.track?.kind === 'audio')?.track.enabled ?? null;
});
const senderTrackId = (page) => page.evaluate(() => {
  const pc = window.__pcs.find((p) => p.signalingState !== 'closed');
  return pc?.getSenders().find((s) => s.track?.kind === 'audio')?.track.id ?? null;
});

async function pair(users) {
  const alice = await users('alice');
  const bob = await users('bob');
  await createServer(alice, 'Hub');
  await joinServer(bob, await makeInvite(alice), 'Hub');
  return { alice, bob, a: await uid(alice), b: await uid(bob) };
}

/** Alice calls Bob in their DM; Bob accepts in the UI. Both call views are open. */
async function dmCall(users, kind = 'audio', before) {
  const ctx = await pair(users);
  const { alice, bob, a, b } = ctx;
  await trackPeers(alice);
  await trackPeers(bob);
  if (before) await before(ctx);
  ctx.dmId = await alice.evaluate(async ({ a, b, kind }) => {
    const { openDm } = await import('/src/lib/servers.js');
    const { joinCall } = await import('/src/lib/calls/useCall.js');
    const id = await openDm(a, b);
    const s = await joinCall(`dm_${id}`, a, { kind, ring: true });
    if (s.status !== 'live') throw new Error(`caller session ${s.status}: ${s.error}`);
    return id;
  }, { a, b, kind });
  await bob.getByTitle('Accept').click({ timeout: 30_000 });
  await alice.getByTitle('Open call').click();
  await expect(alice.locator('.call-view')).toBeVisible();
  await expect(bob.locator('.call-view')).toBeVisible();
  ctx.scope = `dm_${ctx.dmId}`;
  return ctx;
}
const tile = (page, u) => page.locator(`.call-tile[data-uid="${u}"]`);

// ---------- reliability ----------

test('a killed peer connection comes back, on either side, with audio flowing', async ({ users }) => {
  test.setTimeout(180_000);
  const { alice, bob, a, b, scope } = await dmCall(users, 'audio');
  await waitUp([alice, bob]);
  await expect(tile(bob, a).locator('.call-tile-ok')).toHaveCount(1);
  const slotsBefore = await adminGet(`calls/${scope}/slots`);
  for (const [page, other] of [[alice, bob], [bob, alice]]) {
    const before = await pcCount(page);
    const otherBefore = await pcCount(other);
    await page.evaluate(() => window.__pcs.filter((p) => p.signalingState !== 'closed').forEach((p) => p.close()));
    await waitUp([page, other]);
    expect(await pcCount(page)).toBeGreaterThan(before); // a fresh connection on the killed side…
    expect(await pcCount(other)).toBeGreaterThan(otherBefore); // …and the other side started over too
    await expectAudioFlowing(page);
    await expectAudioFlowing(other);
  }
  await expect(tile(alice, b).locator('.call-tile-ok')).toHaveCount(1);
  await expect(tile(bob, a).locator('.call-tile-ok')).toHaveCount(1);
  // Only the media connection was rebuilt: both keep the slot they joined with.
  const slotsAfter = await adminGet(`calls/${scope}/slots`);
  const key = (x) => Object.entries(x || {}).map(([i, v]) => `${i}:${v.uid}:${v.joinedAt}`).sort();
  expect(key(slotsAfter)).toEqual(key(slotsBefore));
});

test('a network that blocks the connection shows "Couldn\'t connect" and keeps retrying until it works', async ({ users }) => {
  test.setTimeout(180_000);
  const { alice, bob, a, b } = await dmCall(users, 'audio', async ({ bob: page }) => {
    // Bob's network: no ICE candidates in or out (as if every path were blocked).
    await page.evaluate(() => {
      window.__blockIce = true;
      const strip = (sdp) => sdp.replace(/a=candidate:[^\r\n]*\r\n/g, '').replace(/a=end-of-candidates\r\n/g, '');
      const Base = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Base {
        addIceCandidate(c) { return window.__blockIce ? Promise.resolve() : super.addIceCandidate(c); }
        setRemoteDescription(d) { return super.setRemoteDescription(window.__blockIce && d?.sdp ? { type: d.type, sdp: strip(d.sdp) } : d); }
        get localDescription() {
          const d = super.localDescription;
          return window.__blockIce && d ? { type: d.type, sdp: strip(d.sdp), toJSON() { return { type: this.type, sdp: this.sdp }; } } : d;
        }
        set onicecandidate(fn) { super.onicecandidate = fn && ((e) => { if (!(window.__blockIce && e.candidate)) fn(e); }); }
        get onicecandidate() { return super.onicecandidate; }
      };
    });
  });
  await expect(tile(alice, b).locator('.call-tile-state')).toHaveText(/Connecting/, { timeout: 10_000 });
  await expect(tile(alice, b).locator('.call-tile-state.failed')).toHaveText(/Couldn.t connect — this network may need a TURN relay/, { timeout: 30_000 });
  await expect(tile(bob, a).locator('.call-tile-state.failed')).toBeVisible({ timeout: 15_000 });
  // It keeps retrying (ICE restarts / fresh connections) after showing the message.
  const atFailure = await negotiations(alice, bob);
  await expect.poll(() => negotiations(alice, bob), { timeout: 30_000 }).toBeGreaterThan(atFailure);
  expect(await live(alice)).not.toBe('connected');
  // The network opens up: the next retry connects without anyone doing anything.
  await bob.evaluate(() => { window.__blockIce = false; });
  await waitUp([alice, bob], 1, 60_000);
  await expect(tile(alice, b).locator('.call-tile-ok')).toHaveCount(1);
  await expect(tile(bob, a).locator('.call-tile-state')).toHaveCount(0);
  await expectAudioFlowing(alice);
});

async function voiceRoom(users) {
  const ctx = await pair(users);
  const { alice, bob, a, b } = ctx;
  await trackPeers(alice);
  await trackPeers(bob);
  ctx.sid = Object.keys((await adminGet(`userServers/${a}`)) || {})[0];
  ctx.cid = await alice.evaluate(async ({ sid }) => (await import('/src/lib/servers.js')).createChannel(sid, { type: 'voice', name: 'Lounge' }), { sid: ctx.sid });
  for (const [page, me] of [[alice, a], [bob, b]]) {
    await page.evaluate(async ({ sid, cid, me }) => {
      const { voiceScope } = await import('/src/lib/calls/core.js');
      const { joinCall } = await import('/src/lib/calls/useCall.js');
      const s = await joinCall(voiceScope(sid, cid), me, { kind: 'audio', ring: false });
      if (s.status !== 'live') throw new Error(`voice session ${s.status}: ${s.error}`);
    }, { sid: ctx.sid, cid: ctx.cid, me });
    await page.getByTitle('Open call').click();
  }
  await waitUp([alice, bob]);
  ctx.slots = async () => Object.values((await adminGet(`vcalls/${ctx.sid}/${ctx.cid}/slots`)) || {}).map((s) => s.uid);
  return ctx;
}

test('closing a tab removes its slot and tile; leaving cleans up slot and signaling inbox', async ({ users }) => {
  const { alice, bob, a, b, sid, cid, slots } = await voiceRoom(users);
  expect((await slots()).sort()).toEqual([a, b].sort());
  await expect(tile(alice, b)).toBeVisible();
  await bob.close();
  await expect(tile(alice, b)).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(slots, { timeout: 20_000 }).toEqual([a]);
  // Explicit leave: slot and inbox are gone.
  await alice.getByRole('button', { name: 'Leave call' }).first().click();
  await expect.poll(slots, { timeout: 10_000 }).toEqual([]);
  expect(await adminGet(`vsignal/${sid}/${cid}/${a}`)).toBeNull();
  await expect(alice.locator('.call-view')).toHaveCount(0);
  expect(await alice.evaluate(() => window.__pcs.every((p) => p.signalingState === 'closed'))).toBe(true);
});

test('a crashed tab leaves no ghost: its slot is removed by the others', async ({ users }) => {
  const { alice, bob, a, b, slots } = await voiceRoom(users);
  const cdp = await bob.context().newCDPSession(bob);
  cdp.send('Page.crash').catch(() => {});
  // The server marks the slot offline (hb = 0); once the media path is gone too, Alice removes it.
  await expect(tile(alice, b)).toHaveCount(0, { timeout: 45_000 });
  await expect.poll(slots, { timeout: 10_000 }).toEqual([a]);
  await expect(alice.locator('.call-head')).toContainText('1 in call');
});

test('a stalled tab stops its heartbeat: its slot is cleared after 45 s, and it rejoins when it recovers', async ({ users }) => {
  test.setTimeout(240_000);
  const { alice, bob, a, b, scope } = await dmCall(users, 'audio');
  await waitUp([alice, bob]);
  const slotUids = async () => Object.values((await adminGet(`calls/${scope}/slots`)) || {}).map((s) => s.uid).sort();
  expect(await slotUids()).toEqual([a, b].sort());
  // Bob's main thread hangs (a frozen or stuck tab): no heartbeats, but its database connection and its
  // media connection stay open, so the server never runs his onDisconnect.
  const stall = bob.evaluate(() => { const end = Date.now() + 75_000; while (Date.now() < end) { /* stuck */ } }).catch(() => {});
  await expect(tile(alice, b)).toHaveCount(0, { timeout: 80_000 });
  expect(await slotUids()).toEqual([a]);
  await expect(alice.locator('.call-head')).toContainText('1 in call');
  await stall;
  // Bob's session notices its slot is gone while it was away and claims a new one.
  try {
    await expect.poll(slotUids, { timeout: 30_000 }).toEqual([a, b].sort());
  } catch (e) {
    console.log('bob after stall:', JSON.stringify(await bob.evaluate(async () => {
      const c = (await import('/src/lib/calls/useCall.js')).getActiveCall();
      return c && { status: c.status, error: c.error, rejoining: c.rejoining, slots: c.slots };
    })), (bob.__errors || []).slice(-5));
    throw e;
  }
  await expect(tile(alice, b)).toBeVisible({ timeout: 20_000 });
  await waitUp([alice, bob]);
  await expectAudioFlowing(alice);
  await expectAudioFlowing(bob);
});

test('a video call never waits for the camera: audio connects while it is still starting', async ({ users }) => {
  const { alice, bob, a } = await dmCall(users, 'video', async ({ bob: page }) => {
    await page.evaluate(() => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => (c && c.video ? new Promise(() => {}) : orig(c));
    });
  });
  await waitUp([alice, bob]);
  await expectAudioFlowing(alice);
  await expectAudioFlowing(bob);
  await expect(bob.getByRole('button', { name: 'Camera' })).toHaveAttribute('title', /Camera starting/);
  // Bob still sees Alice's video.
  await expect.poll(() => bob.evaluate(() => window.__pcs.filter((p) => p.signalingState !== 'closed')
    .some((p) => p.getReceivers().some((r) => r.track?.kind === 'video' && r.track.readyState === 'live'))), { timeout: 20_000 }).toBe(true);
  await expect(tile(bob, a).locator('video')).toHaveCount(1, { timeout: 20_000 });
});

// ---------- features ----------

test('voice & video settings: devices, mic meter, camera preview, processing, push-to-talk key; live device switch in a call', async ({ users }) => {
  const { alice, bob } = await pair(users);
  await alice.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await alice.locator('.settings-nav-item', { hasText: 'Voice & video' }).click();
  const dlg = alice.getByRole('dialog', { name: 'Settings' });
  const mic = dlg.getByLabel('Microphone', { exact: true });
  await expect.poll(async () => (await mic.locator('option').allTextContents()).length, { timeout: 15_000 }).toBeGreaterThan(1);
  // The level meter gets a known signal: microphones return a steady tone (the fake device's beep is
  // unreliable for local analysis), with a fresh track for every capture.
  await alice.evaluate(() => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__tones = [];
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (!c?.audio || c.video) return gum(c);
      const ac = new AudioContext();
      const o = ac.createOscillator();
      const g = ac.createGain();
      g.gain.value = 0.3;
      const d = ac.createMediaStreamDestination();
      o.connect(g).connect(d);
      o.start();
      window.__tones.push(ac);
      return d.stream;
    };
  });
  await dlg.getByLabel('Noise suppression').uncheck();
  await dlg.getByLabel('Echo cancellation').uncheck();
  await dlg.getByLabel('Automatic gain control').uncheck();
  await dlg.getByRole('button', { name: 'Test microphone' }).click();
  await expect.poll(() => meterPeak(alice, '[role="meter"][aria-label="Microphone level"]'), { timeout: 20_000 }).toBeGreaterThan(5);
  await dlg.getByRole('button', { name: 'Stop test' }).click();
  await dlg.getByRole('button', { name: 'Preview camera' }).click();
  await expect.poll(() => alice.evaluate(() => document.querySelector('video[aria-label="Camera preview"]')?.videoWidth || 0), { timeout: 15_000 }).toBeGreaterThan(0);
  await dlg.getByRole('button', { name: 'Stop preview' }).click();
  await dlg.getByLabel('Use push-to-talk').check();
  await dlg.getByRole('button', { name: 'Change key' }).click();
  await alice.keyboard.press('KeyK');
  await expect(dlg.locator('kbd')).toHaveText('K');
  await dlg.getByRole('button', { name: 'Play test sound' }).click();
  await expect(dlg.getByRole('button', { name: 'Play test sound' })).toBeEnabled({ timeout: 5_000 });
  const prefs = await alice.evaluate(() => JSON.parse(localStorage.getItem('codehub.callDevices')));
  expect(prefs).toMatchObject({ ns: false, ec: false, agc: false, ptt: true, pttKey: 'KeyK' });
  await dlg.getByLabel('Use push-to-talk').uncheck();
  await dlg.getByLabel('Echo cancellation').check();
  await alice.getByRole('button', { name: 'Close settings' }).click();

  // In a call: switching processing or the microphone swaps the sent track without reconnecting.
  await trackPeers(alice);
  await trackPeers(bob);
  const a = await uid(alice);
  const b = await uid(bob);
  await alice.evaluate(async ({ a, b }) => {
    const { openDm } = await import('/src/lib/servers.js');
    const { joinCall } = await import('/src/lib/calls/useCall.js');
    await joinCall(`dm_${await openDm(a, b)}`, a, { kind: 'audio', ring: true });
  }, { a, b });
  await bob.getByTitle('Accept').click({ timeout: 30_000 });
  await alice.getByTitle('Open call').click();
  await waitUp([alice, bob]);
  const pcsBefore = await pcCount(alice);
  const t1 = await senderTrackId(alice);
  await alice.getByRole('button', { name: 'Audio and video settings' }).click();
  const menu = alice.getByRole('dialog', { name: 'Audio and video settings' });
  await expect.poll(() => meterPeak(alice, '[role="meter"][aria-label="Your microphone level"]'), { timeout: 20_000 }).toBeGreaterThan(5);
  await menu.getByLabel('Echo cancellation').uncheck();
  await expect.poll(() => senderTrackId(alice), { timeout: 10_000 }).not.toBe(t1);
  const options = await menu.getByLabel('Microphone', { exact: true }).locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  if (options.length > 1) {
    const t2 = await senderTrackId(alice);
    await menu.getByLabel('Microphone', { exact: true }).selectOption(options[1]);
    await expect.poll(() => senderTrackId(alice), { timeout: 10_000 }).not.toBe(t2);
    expect(await alice.evaluate(() => JSON.parse(localStorage.getItem('codehub.callDevices')).audioIn)).toBe(options[1]);
  }
  await menu.getByRole('button', { name: 'Done' }).click();
  expect(await pcCount(alice)).toBe(pcsBefore);
  expect(await live(alice)).toBe('connected');
  await expectAudioFlowing(bob);
});

test('push-to-talk: the mic is only sent while the key or button is held; speaking rings follow the audio', async ({ users }) => {
  const { alice, bob, a } = await dmCall(users, 'audio', async ({ alice: page }) => {
    await page.evaluate(async () => (await import('/src/lib/calls/prefs.js')).savePrefs({ ptt: true }));
  });
  await waitUp([alice, bob]);
  await expect(alice.locator('.call-ptt-tag')).toContainText('Push-to-talk: hold');
  expect(await micEnabled(alice)).toBe(false);
  await alice.locator('.call-head').click();
  await alice.keyboard.down('Backquote');
  await expect.poll(() => micEnabled(alice)).toBe(true);
  await expect(alice.locator('.call-ptt-tag')).toHaveText('Talking');
  // Bob's browser hears Alice: her tile gets the speaking ring (local audio analysis, nothing sent).
  await expect(tile(bob, a)).toHaveClass(/speaking/, { timeout: 15_000 });
  await alice.keyboard.up('Backquote');
  await expect.poll(() => micEnabled(alice)).toBe(false);
  await expect(tile(bob, a)).not.toHaveClass(/speaking/, { timeout: 10_000 });
  // Typing the key in a text field never opens the mic.
  await alice.evaluate(() => {
    const i = document.createElement('input');
    i.id = 'ptt-probe';
    i.setAttribute('aria-label', 'probe');
    document.querySelector('.call-head').appendChild(i);
  });
  await alice.locator('#ptt-probe').focus();
  await alice.keyboard.down('Backquote');
  await alice.waitForTimeout(300);
  expect(await micEnabled(alice)).toBe(false);
  await alice.keyboard.up('Backquote');
  await alice.evaluate(() => document.getElementById('ptt-probe').remove());
  // The on-screen button works with a pointer too.
  const talk = alice.getByRole('button', { name: 'Hold to talk' });
  await talk.hover();
  await alice.mouse.down();
  await expect.poll(() => micEnabled(alice)).toBe(true);
  await alice.mouse.up();
  await expect.poll(() => micEnabled(alice)).toBe(false);
});

test('raise hand (ordered) and reactions travel over the data channel', async ({ users }) => {
  const { alice, bob, a, b } = await dmCall(users, 'audio');
  await waitUp([alice, bob]);
  await alice.getByRole('button', { name: 'Raise hand' }).click();
  await expect(tile(bob, a).locator('.call-tile-hand')).toBeVisible({ timeout: 10_000 });
  await bob.getByRole('button', { name: 'Raise hand' }).click();
  await alice.locator('.call-head').getByRole('button', { name: /People/ }).click();
  const raised = alice.locator('.call-people ol.raised > li');
  await expect(raised).toHaveCount(2, { timeout: 10_000 });
  await expect(raised.nth(0)).toHaveAttribute('data-uid', a);
  await expect(raised.nth(1)).toHaveAttribute('data-uid', b);
  await expect(tile(alice, b).locator('.call-tile-hand')).toContainText('2');
  await alice.getByRole('button', { name: 'Raise hand' }).click(); // lower
  await expect(tile(bob, a).locator('.call-tile-hand')).toHaveCount(0, { timeout: 10_000 });
  await expect(raised).toHaveCount(1);

  await alice.getByRole('button', { name: 'Send a reaction' }).click();
  await alice.getByRole('group', { name: 'Reactions' }).getByRole('button', { name: 'Party' }).click();
  await expect(tile(bob, a).locator('.call-float')).toHaveText('🎉', { timeout: 10_000 });
  await expect(tile(alice, a).locator('.call-float')).toHaveCount(1);
  await expect(tile(bob, a).locator('.call-float')).toHaveCount(0, { timeout: 8_000 }); // floats for 3 s
});

test('spotlight, fullscreen, picture-in-picture, and screen shares take the spotlight', async ({ users }) => {
  const { alice, bob, a, b } = await dmCall(users, 'video', async ({ alice: page }) => {
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 360;
        const g = c.getContext('2d');
        let i = 0;
        setInterval(() => { g.fillStyle = `hsl(${(i += 15) % 360} 60% 50%)`; g.fillRect(0, 0, 640, 360); }, 100);
        return c.captureStream(10);
      };
    });
  });
  await waitUp([alice, bob]);
  try {
    await expect(tile(bob, a).locator('video')).toHaveCount(1, { timeout: 20_000 });
  } catch (e) {
    const diag = (p) => p.evaluate(async () => {
      const c = (await import('/src/lib/calls/useCall.js')).getActiveCall();
      return JSON.stringify({ slots: c?.slots, camOn: c?.camOn, camPending: c?.camPending, err: c?.error,
        peers: c?.peers.map((x) => ({ st: x.status, tracks: x.stream.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted}`) })),
        pcs: window.__pcs.map((pc) => `${pc.signalingState}/${pc.connectionState} tx=${pc.getTransceivers().map((t) => `${t.mid}:${t.direction}:${t.currentDirection}:${t.receiver.track?.kind}`).join(',')}`) });
    });
    console.log('DIAG alice', await diag(alice));
    console.log('DIAG bob', await diag(bob));
    throw e;
  }
  await bob.getByRole('button', { name: 'Spotlight Alice' }).click();
  await expect(bob.locator('.call-view.spotlight')).toBeVisible();
  await expect(bob.locator('.call-tile.main')).toHaveAttribute('data-uid', a);
  await expect(bob.locator('.call-strip .call-tile')).toHaveAttribute('data-uid', b);
  const pipOk = await bob.evaluate(() => !!document.pictureInPictureEnabled);
  if (pipOk) {
    await bob.getByRole('button', { name: 'Picture-in-picture' }).click();
    await expect.poll(() => bob.evaluate(() => !!document.pictureInPictureElement), { timeout: 10_000 }).toBe(true);
    await bob.getByRole('button', { name: 'Close picture-in-picture' }).click();
    await expect.poll(() => bob.evaluate(() => !!document.pictureInPictureElement)).toBe(false);
  }
  await bob.getByRole('button', { name: 'Back to grid' }).click();
  await expect(bob.locator('.call-view.spotlight')).toHaveCount(0);

  await bob.getByRole('button', { name: 'Full screen' }).click();
  await expect.poll(() => bob.evaluate(() => document.fullscreenElement?.classList.contains('call-view') || false)).toBe(true);
  await bob.getByRole('button', { name: 'Exit full screen' }).click();
  await expect.poll(() => bob.evaluate(() => !!document.fullscreenElement)).toBe(false);

  await alice.getByRole('button', { name: 'Share screen' }).click();
  await expect(bob.locator('.call-tile.main')).toHaveAttribute('data-uid', a, { timeout: 15_000 });
  await expect(bob.locator('.call-tile.main .call-live-tag')).toBeVisible();
  await alice.getByRole('button', { name: 'Share screen' }).click(); // stop
  await expect(bob.locator('.call-view.spotlight')).toHaveCount(0, { timeout: 15_000 });
});

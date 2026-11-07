// Calls (features 2–5): call meta, slot cap of 6, encrypted signaling inbox, voice channels.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
const SID = 'srvAAAAAAAAAAAAAAAAA';
const VC = 'chVOICEAAAAAAAAAAAAA';
const TC = 'chTEXTAAAAAAAAAAAAAA';
const vc = `${SID}/${VC}`;
const vt = `${SID}/${TC}`;
const SEVEN = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina'];
const meta = (by, kind = 'audio') => ({ id: 'call12345678', startedBy: by, ts: TS, kind });
const slot = (uid) => ({ uid, joinedAt: TS, mic: true, cam: false, screen: false });
const sig = { ...box, ts: TS };

before(getEnv); after(cleanup);
beforeEach(() => reset((w) => {
  const members = {};
  for (const u of SEVEN) members[u] = { role: u === 'alice' ? 'owner' : 'member', joinedAt: 1 };
  w.servers[SID] = { meta: { ownerId: 'alice', nameEnc: box, createdAt: 1 }, members,
    channels: { [VC]: { type: 'voice', enc: box, position: 0 }, [TC]: { type: 'text', enc: box, position: 1 } } };
}));

describe('calls', () => {
  it('ALLOW DM member to start a DM call and claim a slot; DENY outsider', async () => {
    await ok(db('dave').ref('calls/dm_dave_zoe').update(meta('dave')));
    await ok(db('dave').ref('calls/dm_dave_zoe/slots/0').set(slot('dave')));
    await ok(db('zoe').ref('calls/dm_dave_zoe/slots/1').set(slot('zoe')));
    await deny(db('erin').ref('calls/dm_dave_zoe').once('value'));
    await deny(db('erin').ref('calls/dm_dave_zoe/slots/2').set(slot('erin')));
  });
  it('DENY slot without call meta, bad slot index, someone else\'s slot, second slot, fake joinedAt', async () => {
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/0').set(slot('dave')));
    await ok(db('dave').ref('calls/dm_dave_zoe').update(meta('dave')));
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/6').set(slot('dave')));
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/0').set(slot('zoe')));
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/0').set({ ...slot('dave'), joinedAt: 5 }));
    await ok(db('dave').ref('calls/dm_dave_zoe/slots/0').set(slot('dave')));
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/3').set(slot('dave')));
    await deny(db('zoe').ref('calls/dm_dave_zoe/slots/0').set(slot('zoe')));
    await deny(db('zoe').ref('calls/dm_dave_zoe/slots/0').remove());
    await ok(db('dave').ref('calls/dm_dave_zoe/slots/0').update({ mic: false, screen: true }));
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/0').update({ x: 1 }));
    await ok(db('dave').ref('calls/dm_dave_zoe/slots/0').remove());
  });
  it('caps a voice channel at 6 (7th refused), DENY call in a text channel', async () => {
    await ok(db('alice').ref(`vcalls/${vc}`).update(meta('alice')));
    for (let i = 0; i < 6; i++) await ok(db(SEVEN[i]).ref(`vcalls/${vc}/slots/${i}`).set(slot(SEVEN[i])));
    for (let i = 0; i < 6; i++) await deny(db('gina').ref(`vcalls/${vc}/slots/${i}`).set(slot('gina')));
    await deny(db('hank').ref(`vcalls/${vc}`).once('value'));
    await deny(db('alice').ref(`vcalls/${vt}`).update(meta('alice')));
  });
  it('DENY overwriting a live call meta; ALLOW starter cleanup once empty', async () => {
    await ok(db('alice').ref('calls/grp_g1').update(meta('alice', 'video')));
    await ok(db('alice').ref('calls/grp_g1/slots/0').set(slot('alice')));
    await deny(db('dave').ref('calls/grp_g1').update(meta('dave')));
    await deny(db('alice').ref('calls/grp_g1').update({ id: null, startedBy: null, ts: null, kind: null }));
    await ok(db('alice').ref('calls/grp_g1/slots/0').remove());
    await deny(db('dave').ref('calls/grp_g1').update({ id: null, startedBy: null, ts: null, kind: null }));
    await ok(db('alice').ref('calls/grp_g1').update({ id: null, startedBy: null, ts: null, kind: null }));
    await deny(db('alice').ref('calls/grp_g1').update({ ...meta('alice'), kind: 'screen' }));
  });
  it('ALLOW stale meta (>60 s, no slots) to be replaced by any member', async () => {
    await admin((d) => d.ref('calls/grp_g1').set({ id: 'oldcall12345', startedBy: 'alice', ts: Date.now() - 120000, kind: 'audio' }));
    await ok(db('dave').ref('calls/grp_g1').update(meta('dave')));
  });
  it('signal: member→member write, only the recipient reads/deletes; DENY spoofed from/outsider/text channel', async () => {
    // Regression: no signaling into an inbox unless a call is in progress for that scope.
    await deny(db('dave').ref('signal/dm_dave_zoe/zoe/dave').push(sig));
    await deny(db('bob').ref(`vsignal/${vc}/carol/bob`).push(sig));
    await admin((d) => d.ref().update({ 'calls/dm_dave_zoe/id': 'call12345678', 'calls/grp_g1/id': 'call12345679', [`vcalls/${vc}/id`]: 'call12345670' }));
    await ok(db('dave').ref('signal/dm_dave_zoe/zoe/dave').push(sig));
    await deny(db('dave').ref('signal/dm_dave_zoe/zoe/zoe').push(sig));
    await deny(db('erin').ref('signal/dm_dave_zoe/zoe/erin').push(sig));
    await deny(db('dave').ref('signal/dm_dave_zoe/erin/dave').push(sig));
    await ok(db('zoe').ref('signal/dm_dave_zoe/zoe').once('value'));
    await deny(db('dave').ref('signal/dm_dave_zoe/zoe').once('value'));
    await deny(db('dave').ref('signal/dm_dave_zoe/zoe').remove());
    await ok(db('zoe').ref('signal/dm_dave_zoe/zoe').remove());
    await ok(db('dave').ref('signal/grp_g1/alice/dave').push({ ...sig, epoch: 1 }));
    await deny(db('dave').ref('signal/grp_g1/alice/dave').push({ ...sig, extra: 1 }));
    await deny(db('dave').ref('signal/grp_g1/alice/dave').push({ ...box, ts: 5 }));
    await ok(db('bob').ref(`vsignal/${vc}/carol/bob`).push(sig));
    await deny(db('bob').ref(`vsignal/${vt}/carol/bob`).push(sig));
    await deny(db('bob').ref(`vsignal/${vc}/hank/bob`).push(sig));
  });
  it('ALLOW voice channel type', async () => {
    await ok(db('alice').ref(`servers/${SID}/channels/chNEWVOICEAAAAAAAAAA`).set({ type: 'voice', enc: box, position: 3, createdAt: TS }));
  });
});
describe('calls: channel type', () => {
  it('DENY unknown channel type', async () => {
    await deny(db('alice').ref(`servers/${SID}/channels/chBADAAAAAAAAAAAAAAA`).set({ type: 'stage', enc: box, position: 4, createdAt: TS }));
  });
});

// Round 3: slot heartbeat (`hb`) and removal of ghost slots left by crashed or frozen tabs.
describe('calls: heartbeat and ghost slots', () => {
  const live = (uid, hb = TS) => ({ ...slot(uid), hb });
  const seed = (path, s) => admin((d) => d.ref(path).set(s));
  it('ALLOW hb = server time or 0 (set by onDisconnect); DENY any other value', async () => {
    await ok(db('dave').ref('calls/dm_dave_zoe').update(meta('dave')));
    await ok(db('dave').ref('calls/dm_dave_zoe/slots/0').set(live('dave')));
    await ok(db('dave').ref('calls/dm_dave_zoe/slots/0').update({ hb: TS }));
    await ok(db('dave').ref('calls/dm_dave_zoe/slots/0/hb').set(0));
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/0/hb').set(Date.now() - 60000));
    await deny(db('dave').ref('calls/dm_dave_zoe/slots/0/hb').set('now'));
    await deny(db('zoe').ref('calls/dm_dave_zoe/slots/0/hb').set(TS));
    await ok(db('bob').ref(`vcalls/${vc}`).update(meta('bob')));
    await ok(db('bob').ref(`vcalls/${vc}/slots/0`).set(live('bob')));
    await deny(db('bob').ref(`vcalls/${vc}/slots/0/hb`).set(12345));
  });
  it('ALLOW a member to remove a slot whose heartbeat is 45 s old or 0; DENY a fresh one or one without hb', async () => {
    await ok(db('dave').ref('calls/dm_dave_zoe').update(meta('dave')));
    await seed('calls/dm_dave_zoe/slots/0', { ...slot('dave'), joinedAt: 1, hb: Date.now() - 10000 });
    await deny(db('zoe').ref('calls/dm_dave_zoe/slots/0').remove());
    await seed('calls/dm_dave_zoe/slots/0', { ...slot('dave'), joinedAt: 1 });
    await deny(db('zoe').ref('calls/dm_dave_zoe/slots/0').remove()); // older clients' slots: only onDisconnect removes them
    await seed('calls/dm_dave_zoe/slots/0', { ...slot('dave'), joinedAt: 1, hb: Date.now() - 46000 });
    await deny(db('erin').ref('calls/dm_dave_zoe/slots/0').remove()); // not in the DM
    await ok(db('zoe').ref('calls/dm_dave_zoe/slots/0').remove());
    await seed('calls/grp_g1/slots/1', { ...slot('erin'), joinedAt: 1, hb: 0 });
    await admin((d) => d.ref('calls/grp_g1').update({ id: 'call12345678', startedBy: 'erin', ts: 1, kind: 'audio' }));
    await deny(db('zoe').ref('calls/grp_g1/slots/1').remove());
    await ok(db('dave').ref('calls/grp_g1/slots/1').remove());
  });
  it('voice channels: stale slot removable by members (not outsiders), fresh one only by its owner or moderators', async () => {
    await ok(db('alice').ref(`vcalls/${vc}`).update(meta('alice')));
    await seed(`vcalls/${vc}/slots/2`, { ...slot('carol'), joinedAt: 1, hb: Date.now() - 5000 });
    await deny(db('dave').ref(`vcalls/${vc}/slots/2`).remove());
    await seed(`vcalls/${vc}/slots/2`, { ...slot('carol'), joinedAt: 1, hb: Date.now() - 50000 });
    await deny(db('hank').ref(`vcalls/${vc}/slots/2`).remove());
    await ok(db('dave').ref(`vcalls/${vc}/slots/2`).remove());
    // The freed index can be reclaimed at once.
    await ok(db('dave').ref(`vcalls/${vc}/slots/2`).set(live('dave')));
  });
  it('a dangling onDisconnect (hb = 0) never recreates a removed or reassigned slot', async () => {
    const dave = db('dave');
    await ok(dave.ref('calls/grp_g1').update(meta('dave')));
    await ok(dave.ref('calls/grp_g1/slots/0').set(live('dave')));
    await dave.ref('calls/grp_g1/slots/0/hb').onDisconnect().set(0);
    await ok(dave.ref('calls/grp_g1/slots/0').remove());
    const erin = db('erin');
    await ok(erin.ref('calls/grp_g1/slots/0').set(live('erin')));
    dave.goOffline();
    await new Promise((r) => setTimeout(r, 1500));
    let v;
    await admin(async (d) => { v = (await d.ref('calls/grp_g1/slots/0').get()).val(); });
    assert.equal(v.uid, 'erin');
    assert.notEqual(v.hb, 0, "erin's heartbeat untouched");
  });
});

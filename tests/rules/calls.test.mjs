// Calls (features 2–5): call meta, slot cap of 6, encrypted signaling inbox, voice channels.
import { describe, it, before, after, beforeEach } from 'node:test';
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

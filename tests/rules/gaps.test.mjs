// Follow-up fixes after the overnight round: cleanup of data kept outside a deleted server / channel /
// group, group mention + reply notifications, category references, profile link shape.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails as deny, assertSucceeds as ok } from './helpers.mjs';

before(getEnv); after(cleanup);

const side = (w) => {
  w.emotes = { s1: { e1: { iv: box.iv, ct: box.ct, by: 'alice', ts: 1 } } };
  w.vcalls = { s1: { c1: { id: 'call12345', startedBy: 'dave', ts: 1, kind: 'audio' }, gone: { id: 'call12345', startedBy: 'dave', ts: 1, kind: 'audio' } } };
  w.vsignal = { s1: { c1: { dave: { erin: { p1: { iv: box.iv, ct: box.ct } } } }, gone: { dave: { erin: { p1: { iv: box.iv, ct: box.ct } } } } } };
  w.lastPost = { s1: { c1: { dave: 1 }, gone: { dave: 1 } } };
  w.votes = { ch: { s1: { c1: { m1: { dave: 0 } }, gone: { m9: { dave: 1 } } } }, grp: { g1: { gm1: { dave: 1 } } } };
};

describe('cleanup when the owner of the data is gone', () => {
  beforeEach(() => reset(side));

  it('DENY clearing voice/slowmode/vote data of a channel or server that still exists', async () => {
    for (const p of ['vcalls/s1/c1', 'vsignal/s1/c1', 'lastPost/s1/c1', 'votes/ch/s1/c1', 'vcalls/s1', 'lastPost/s1', 'votes/ch/s1', 'vsignal/s1']) {
      await deny(db('alice').ref(p).remove());
    }
    await deny(db('dave').ref('lastPost/s1/c1/dave').remove()); // would reset slowmode
    await deny(db('dave').ref('votes/grp/g1').remove());
  });

  it('ALLOW any signed-in user to clear leftovers of a channel that no longer exists; DENY signed out', async () => {
    for (const p of ['vcalls/s1/gone', 'vsignal/s1/gone', 'lastPost/s1/gone', 'votes/ch/s1/gone']) {
      await deny(db(null).ref(p).remove());
      await ok(db('zoe').ref(p).remove());
    }
  });

  it('ALLOW the owner to delete a channel together with its side data (deleteChannel)', async () => {
    await ok(db('alice').ref().update({
      'messages/s1/c1': null, 'collab/s1/c1': null, 'servers/s1/channels/c1': null,
      'vcalls/s1/c1': null, 'vsignal/s1/c1': null, 'lastPost/s1/c1': null, 'votes/ch/s1/c1': null,
    }));
    await deny(db('dave').ref().update({ 'servers/s1/channels/c2': null, 'vcalls/s1/c2': null }));
  });

  it('ALLOW the owner to delete a server with emotes, voice, slowmode and votes (deleteServer); DENY an admin', async () => {
    const all = {
      'messages/s1': null, 'collab/s1': null, 'audit/s1': null, 'servers/s1': null, 'userServers/alice/s1': null,
      'emotes/s1': null, 'vcalls/s1': null, 'vsignal/s1': null, 'lastPost/s1': null, 'votes/ch/s1': null,
    };
    const { 'userServers/alice/s1': _mine, ...asBob } = all;
    await deny(db('bob').ref().update({ ...asBob, 'userServers/bob/s1': null }));
    await ok(db('alice').ref().update(all));
    let left = null;
    await admin(async (d) => { left = (await d.ref().get()).val(); });
    for (const k of ['emotes', 'vcalls', 'vsignal', 'lastPost']) if (left[k]) throw new Error(`${k} left behind`);
    if (left.votes?.ch) throw new Error('votes/ch left behind');
  });

  it('ALLOW the group owner to delete a group with its votes (deleteGroup)', async () => {
    await ok(db('alice').ref().update({
      'groupMessages/g1': null, 'typing/grp/g1': null, 'groups/g1': null, 'votes/grp/g1': null,
      'reads/alice/grp_g1': null, 'userGroups/alice/g1': null, 'userGroups/dave/g1': null, 'userGroups/erin/g1': null,
    }));
  });
});

describe('group mention and reply notifications', () => {
  beforeEach(() => reset());
  const send = (from, to, nid, kind, ref) =>
    db(from).ref().update({ [`notifs/${to}/${nid}`]: { kind, from, ts: TS, ref }, [`notifLog/${from}/${to}`]: TS });

  it('ALLOW between members of the same group; DENY outsiders either way', async () => {
    await ok(send('dave', 'erin', 'n1', 'mention', { gid: 'g1', mid: 'gm1' }));
    await ok(send('erin', 'dave', 'n2', 'reply', { gid: 'g1', mid: 'gm1' }));
    await deny(send('zoe', 'dave', 'n3', 'mention', { gid: 'g1', mid: 'gm1' }));
    await deny(send('dave', 'zoe', 'n4', 'reply', { gid: 'g1', mid: 'gm1' }));
  });
  it('DENY a mention with no server or group, and server mentions still need both members', async () => {
    await deny(send('dave', 'erin', 'n1', 'mention', { mid: 'gm1' }));
    await ok(send('alice', 'dave', 'n2', 'mention', { sid: 's1', cid: 'c1', mid: 'm1' }));
    await deny(send('alice', 'zoe', 'n3', 'mention', { sid: 's1', cid: 'c1', mid: 'm1' }));
  });
});

describe('profile links match cleanLink()', () => {
  beforeEach(() => reset());
  const P = (links) => db('dave').ref('users/dave/profile').set({ links });
  it('ALLOW normal https links; DENY credentials, dotless hosts and a non-list value', async () => {
    await ok(P(['https://example.com/', 'https://a.dev:8443/x?y=1#z', 'https://sub.my_host.io/']));
    await deny(P(['https://user:pw@evil.com/']));
    await deny(P(['https://localhost/']));
    await deny(P(['https://evil.com@good.com/']));
    await deny(db('dave').ref('users/dave/profile').set({ links: 'https://example.com/' }));
  });
});

describe('call signaling inbox', () => {
  const seed = (w) => {
    w.calls = { dm_dave_zoe: { id: 'call12345', startedBy: 'dave', ts: 1, kind: 'audio' } };
    w.signal = { dm_dave_zoe: { zoe: { dave: { p1: { iv: box.iv, ct: box.ct, ts: 1 }, p2: { iv: box.iv, ct: box.ct, ts: 1 } } } } };
    w.vcalls = { s1: { c1: { id: 'call12345', startedBy: 'dave', ts: 1, kind: 'audio' } } };
    w.vsignal = { s1: { c1: { erin: { dave: { p1: { iv: box.iv, ct: box.ct, ts: 1 }, p2: { iv: box.iv, ct: box.ct, ts: 1 } } } } } };
  };
  beforeEach(() => reset(seed));
  it('ALLOW the recipient to delete one handled message while others are waiting; DENY sender/third party', async () => {
    await ok(db('zoe').ref('signal/dm_dave_zoe/zoe/dave/p1').remove());
    await deny(db('dave').ref('signal/dm_dave_zoe/zoe/dave/p2').remove());
    await deny(db('erin').ref('signal/dm_dave_zoe/zoe/dave/p2').remove());
    await deny(db('zoe').ref('signal/dm_dave_zoe/zoe/dave/p2').set({ iv: box.iv, ct: box.ct, ts: TS }));
    await ok(db('erin').ref('vsignal/s1/c1/erin/dave/p1').remove());
    await deny(db('alice').ref('vsignal/s1/c1/erin/dave/p2').remove());
  });
});

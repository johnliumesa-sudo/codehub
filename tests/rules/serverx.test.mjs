// Tier 2 (serverx): slowmode, channel categories, richer profiles.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);
const msg = (uid) => ({ uid, ts: TS, iv: box.iv, ct: box.ct });
const post = (u, slow = true) => ({
  [`messages/s1/c1/${'m' + Math.random().toString(36).slice(2, 10)}`]: msg(u),
  ...(slow ? { [`lastPost/s1/c1/${u}`]: TS } : {}),
});
const setSlow = (w, sec) => { w.servers.s1.channels.c1.slowmode = sec; };

describe('slowmode', () => {
  beforeEach(() => reset());
  it('ALLOW admin/owner to set slowmode; DENY plain member, range, non-number', async () => {
    await ok(db('alice').ref('servers/s1/channels/c1/slowmode').set(30));
    await ok(db('bob').ref('servers/s1/channels/c1/slowmode').set(21600));
    await deny(db('bob').ref('servers/s1/channels/c1/slowmode').set(21601));
    await deny(db('bob').ref('servers/s1/channels/c1/slowmode').set('5'));
    await deny(db('dave').ref('servers/s1/channels/c1/slowmode').set(5));
  });
  it('no slowmode: plain post still works without lastPost', async () => {
    await ok(db('dave').ref().update(post('dave', false)));
  });
  it('slowmode on: post WITHOUT lastPost denied; WITH lastPost allowed (first post)', async () => {
    await reset((w) => setSlow(w, 60));
    await deny(db('dave').ref().update(post('dave', false)));
    await ok(db('dave').ref().update(post('dave')));
  });
  it('slowmode on: second post inside the window denied, after the window allowed', async () => {
    await reset((w) => setSlow(w, 60));
    await admin((d) => d.ref('lastPost/s1/c1/dave').set(Date.now() - 5_000));
    await deny(db('dave').ref().update(post('dave')));
    await admin((d) => d.ref('lastPost/s1/c1/dave').set(Date.now() - 61_000));
    await ok(db('dave').ref().update(post('dave')));
  });
  it('DENY forging lastPost (not now), someone else\'s lastPost, deleting lastPost', async () => {
    await reset((w) => setSlow(w, 60));
    await admin((d) => d.ref('lastPost/s1/c1/dave').set(Date.now() - 5_000));
    await deny(db('dave').ref('lastPost/s1/c1/dave').set(1));
    await deny(db('dave').ref('lastPost/s1/c1/dave').remove());
    await deny(db('mallory').ref('lastPost/s1/c1/mallory').set(TS));
    await deny(db('dave').ref('lastPost/s1/c1/erin').set(TS));
  });
  it('moderators (owner, admin, manageMessages) are exempt', async () => {
    await reset((w) => setSlow(w, 60));
    for (const u of ['alice', 'bob', 'carol']) await ok(db(u).ref().update(post(u, false)));
  });
  it('lastPost readable only by its owner', async () => {
    await admin((d) => d.ref('lastPost/s1/c1/dave').set(1));
    await ok(db('dave').ref('lastPost/s1/c1/dave').once('value'));
    await deny(db('erin').ref('lastPost/s1/c1/dave').once('value'));
  });
  it('editing an existing message is not blocked by slowmode', async () => {
    await reset((w) => { setSlow(w, 60); });
    await ok(db('dave').ref('messages/s1/c1/m1/ct').set('Y2lwaGVy'));
  });
});

describe('categories', () => {
  beforeEach(() => reset());
  const cat = { enc: box, position: 1 };
  it('ALLOW owner/admin create + member read; DENY member write, outsider read, bad shape', async () => {
    await ok(db('alice').ref('servers/s1/categories/k1').set(cat));
    await ok(db('bob').ref('servers/s1/categories/k2').set(cat));
    await ok(db('dave').ref('servers/s1/categories').once('value'));
    await deny(db('mallory').ref('servers/s1/categories').once('value'));
    await deny(db('dave').ref('servers/s1/categories/k3').set(cat));
    await deny(db('alice').ref('servers/s1/categories/k3').set({ enc: box }));
    await deny(db('alice').ref('servers/s1/categories/k3').set({ ...cat, evil: 1 }));
    await deny(db('alice').ref('servers/s1/categories/k3').set({ enc: { iv: 'x', ct: 'y' }, position: 1 }));
  });
  it('channel cat field: manager only, string <= 32', async () => {
    await ok(db('alice').ref('servers/s1/channels/c1/cat').set('k1'));
    await deny(db('alice').ref('servers/s1/channels/c1/cat').set(5));
    await deny(db('alice').ref('servers/s1/channels/c1/cat').set('x'.repeat(33)));
    await deny(db('dave').ref('servers/s1/channels/c1/cat').set('k1'));
  });
  it('delete category + clear channel cat in one update', async () => {
    await admin((d) => d.ref('servers/s1/categories/k1').set(cat));
    await admin((d) => d.ref('servers/s1/channels/c1/cat').set('k1'));
    await ok(db('alice').ref().update({ 'servers/s1/categories/k1': null, 'servers/s1/channels/c1/cat': null }));
    await deny(db('dave').ref('servers/s1/categories/k1').remove());
  });
});

describe('richer profiles', () => {
  beforeEach(() => reset());
  const P = (o) => db('dave').ref('users/dave/profile').set(o);
  it('ALLOW a full valid profile; owner only', async () => {
    await ok(P({ bio: 'hi', pronouns: 'they/them', links: ['https://a.dev', 'https://b.dev/x?y=1'], banner: '#aabbcc' }));
    await deny(db('erin').ref('users/dave/profile').set({ bio: 'x' }));
    await ok(db('erin').ref('users/dave/profile').once('value'));
  });
  it('DENY long bio/pronouns, bad banner, >3 links, non-https, javascript:, unknown key', async () => {
    await deny(P({ bio: 'x'.repeat(191) }));
    await ok(P({ bio: 'x'.repeat(190) }));
    await deny(P({ pronouns: 'x'.repeat(41) }));
    await deny(P({ banner: 'red' }));
    await deny(P({ banner: '#abc' }));
    await deny(P({ links: ['https://a.dev', 'https://b.dev', 'https://c.dev', 'https://d.dev'] }));
    await deny(P({ links: ['http://a.dev'] }));
    await deny(P({ links: ['javascript:alert(1)'] }));
    await deny(P({ links: ['https://a b.dev'] }));
    await deny(P({ nope: 1 }));
  });
  it('profile can be removed', async () => {
    await ok(P({ bio: 'hi' }));
    await ok(db('dave').ref('users/dave/profile').remove());
  });
});

// Round 3 security fixes (sec-misc, R1): size and rate limits on the generic blocks. The reviewer's
// emulator probes (scratchpad secreview/probe1.test.mjs P1-P4) are kept here as deny tests, next to the
// legitimate writes each limit must still allow.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, TS, pubStamp, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
const big = (n) => 'x'.repeat(n);
const manyFields = (n, len) => {
  const o = {};
  for (let i = 0; i < n; i++) o[`f${i}`] = big(len);
  return o;
};
const bot = (by, extra = {}) => ({ by, ts: TS, name: 'Bot', ver: 1, created: TS, ...extra });
const create = (uid, path, value, id = path.split('/').pop()) => db(uid).ref().update({ [path]: value, ...pubStamp(uid, id) });

describe('sec-misc: size and rate limits', () => {
  before(getEnv);
  after(cleanup);
  beforeEach(() => reset());

  describe('reviewer probes (all refused now)', () => {
    it('P1: a pub entry with 250 x 20000-char fields (~5 MB), with or without the publish stamp', async () => {
      await deny(db('zoe').ref('pub/bots/huge').set({ by: 'zoe', ts: TS, ...manyFields(250, 20000) }));
      await deny(create('zoe', 'pub/bots/huge', { by: 'zoe', ts: TS, ...manyFields(250, 20000) }));
      await deny(create('zoe', 'pub/addons/huge2', { by: 'zoe', ts: TS, ...manyFields(250, 20000) }));
      await deny(create('zoe', 'pub/bots/huge', bot('zoe', { name: big(20000) })), 'name is capped at 1000');
    });
    it('P2: one update creating 150 pub/bots entries (with or without a stamp)', async () => {
      const u = {};
      for (let i = 0; i < 150; i++) u[`pub/bots/spam${i}`] = { by: 'zoe', ts: TS, name: 'spam' };
      await deny(db('zoe').ref().update(u));
      await deny(db('zoe').ref().update({ ...u, ...pubStamp('zoe', 'spam0') }));
      await deny(db('zoe').ref().update({ 'pub/bots/spam0': bot('zoe'), 'pub/bots/spam1': bot('zoe'), ...pubStamp('zoe', 'spam0') }),
        'one stamp creates entries with one id only');
    });
    it('P3: a bare 2 MB string at upub/{uid} or udata/{uid}', async () => {
      await deny(db('zoe').ref('upub/zoe').set(big(2_000_000)));
      await deny(db('zoe').ref('udata/zoe').set(big(2_000_000)));
      await deny(db('zoe').ref('upub/zoe').set('x'));
      await deny(db('zoe').ref('udata/zoe').set(5));
    });
    it('P4: a sitems item with 250 fields, or any field outside the allowlist', async () => {
      await deny(db('dave').ref('sitems/s1/events/e1').set({ by: 'dave', ...manyFields(250, 20000) }));
      await deny(db('dave').ref('sitems/s1/events/e1').set({ by: 'dave', iv: 'a'.repeat(16), ct: 'Y3Q', title: 'plain' }));
    });
  });

  describe('what the features write still works', () => {
    it('udata/upub: objects of features (and removal of the whole node)', async () => {
      await ok(db('zoe').ref('udata/zoe').set({ drafts: { k1: 'x' }, rsvp: { 's1~e1': 'going' } }));
      await ok(db('zoe').ref('upub/zoe').set({ status: { now: { text: 'coding' } } }));
      await ok(db('zoe').ref('udata/zoe/drafts/k2').set('y'));
      await ok(db('zoe').ref('udata/zoe').remove());
      await ok(db('zoe').ref('upub/zoe').remove());
    });
    it('sitems: events { by, iv, ct } (ct up to 20000), RSVPs { by, s, ts }, rules markers { by, v, ts }', async () => {
      await ok(db('dave').ref('sitems/s1/events/e1').set({ by: 'dave', iv: 'a'.repeat(16), ct: big(20000) }));
      await ok(db('dave').ref('sitems/s1/rsvp/e1~dave').set({ by: 'dave', s: 'going', ts: Date.now() }));
      await ok(db('dave').ref('sitems/s1/accepted/dave').set({ by: 'dave', v: 3, ts: Date.now() }));
      await deny(db('dave').ref('sitems/s1/rsvp/e1~dave').set({ by: 'dave', s: big(201), ts: 1 }), 'small fields are capped at 200');
    });
    it('pub: every field the bots, add-ons and discovery code writes', async () => {
      await ok(create('zoe', 'pub/bots/b1', bot('zoe', { def: big(20000), desc: big(300), glyph: '🛠', img: big(20000), imgType: 'image/png' })));
      await ok(db('mallory').ref().update({
        'pub/addons/a1': { by: 'mallory', ts: TS, name: 'Timer', icon: '⏱', version: '1.0.0', sha: 'ab'.repeat(32), size: 9, desc: big(500), perms: 'storage', seed: 'pomodoro', rt: 2 },
        'pub/addonCode/a1': { by: 'mallory', ts: TS, code: big(65536), sha: 'ab'.repeat(32) },
        ...pubStamp('mallory', 'a1'),
      }));
      await ok(create('alice', 'pub/servers/s1', { by: 'alice', ts: TS, name: 'Lobby', desc: big(300), tags: 'a,b', glyph: 'L', color: '#ff8f4d', members: 3, iid: 'inv1', k: 'k'.repeat(43) }));
    });
  });

  describe('pub creates: one per minute per account (publishLog), bound to one id', () => {
    it('DENY a create without the stamp, or with the stamp bound to another id', async () => {
      await deny(db('zoe').ref('pub/bots/b1').set(bot('zoe')));
      await deny(db('zoe').ref().update({ 'pub/bots/b1': bot('zoe'), 'publishLog/zoe': TS }));
      await deny(db('zoe').ref().update({ 'pub/bots/b1': bot('zoe'), ...pubStamp('zoe', 'other') }));
      await ok(create('zoe', 'pub/bots/b1', bot('zoe')));
    });
    it('DENY a second create within 60 s (shared with games and shop items); ALLOW after the window', async () => {
      await ok(create('zoe', 'pub/bots/b1', bot('zoe')));
      await deny(create('zoe', 'pub/bots/b2', bot('zoe')));
      await deny(db('zoe').ref().update({ 'pub/bots/b2': bot('zoe'), [`udata/zoe/pub/last`]: 'b2' }), 'the previous stamp does not count');
      await deny(create('erin', 'pub/bots/b3', bot('erin')), "erin published a game a second ago (helpers' world)");
      await admin((d) => d.ref('publishLog/zoe').set(Date.now() - 61000));
      await ok(create('zoe', 'pub/bots/b2', bot('zoe')));
    });
    it('ALLOW updates of my existing entry without a stamp (any number of times)', async () => {
      await admin((d) => d.ref('pub/bots/b1').set({ by: 'erin', ts: 1, name: 'Old', ver: 1 }));
      await ok(db('erin').ref('pub/bots/b1').update({ name: 'New', ver: 2, ts: TS }));
      await ok(db('erin').ref('pub/bots/b1').set({ by: 'erin', ts: TS, name: 'Again', ver: 3 }));
      await deny(db('zoe').ref('pub/bots/b1').update({ name: 'mine', ts: TS }));
    });
    it('ALLOW app admins to create without the stamp (first-party add-on examples)', async () => {
      await ok(db('admin1').ref().update({
        'pub/addons/x1': { by: 'admin1', ts: TS, name: 'Pomodoro', icon: '🍅', version: '1.0.0', sha: 'ab'.repeat(32), size: 9 },
        'pub/addonCode/x1': { by: 'admin1', ts: TS, code: '<p>1</p>', sha: 'ab'.repeat(32) },
      }));
      await ok(db('admin1').ref('pub/bots/x2').set(bot('admin1')));
    });
  });
});

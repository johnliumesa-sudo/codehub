// Bots (round 3) use only the generic rules blocks; these tests pin down the exact shapes and
// permissions the feature relies on: the public directory (pub/bots), server installs
// (sconf/{sid}/bots, "Manage apps") and the per-member welcome markers (udata/{uid}/botWelcome).
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
const big = (n, ch = 'x') => ch.repeat(n);
const def = (extra = '') => JSON.stringify({ v: 1, name: 'Helper', glyph: '🛠', desc: extra, commands: [{ name: 'hello', usage: '', desc: '', response: 'Hi {mention}' }], triggers: [], welcome: '' });
// A directory entry exactly as publishBot / saveBotVersion write it.
const entry = (by, patch = {}) => ({ def: def(), name: 'Helper', desc: '', glyph: '🛠', ver: 1, created: TS, by, ts: TS, ...patch });
// A server install exactly as installBot writes it.
const install = (author, patch = {}) => ({ def: def(), ver: 1, by: 'dave', author, at: TS, ...patch });
const appsRole = { nameEnc: box, color: '#00ff00', position: 40, perms: { manageApps: true }, createdAt: 1 };

const seed = (w) => {
  w.servers.s1.roles.rApps = appsRole;
  w.servers.s1.members.erin.roleId = 'rApps';
  w.pub = { bots: { b1: { ...entry('dave'), created: 1, ts: 1 } } };
  w.sconf = { s1: { bots: { b1: { ...install('alice'), at: 1 } } } };
};

describe('bots: generic blocks as used by the bots feature', () => {
  before(getEnv);
  after(cleanup);
  beforeEach(() => reset(seed));

  describe('pub/bots (public directory)', () => {
    it('ALLOW any signed-in user to publish a full-size definition and image', async () => {
      const fullDef = def(big(20000 - def('').length));
      await ok(db('erin').ref('pub/bots/b2').set(entry('erin', { def: fullDef, img: big(20000, 'A'), imgType: 'image/webp' })));
      await ok(db('mallory').ref('pub/bots/b3').set(entry('mallory')));
    });
    it('DENY definitions or images over one 20000-character leaf, nested values, forged by and stale ts', async () => {
      await deny(db('erin').ref('pub/bots/b2').set(entry('erin', { def: def(big(20001)) })));
      await deny(db('erin').ref('pub/bots/b2').set(entry('erin', { img: big(20001, 'A') })));
      await deny(db('erin').ref('pub/bots/b2').set(entry('erin', { commands: { hello: 'x' } })));
      await deny(db('erin').ref('pub/bots/b2').set(entry('dave')));
      await deny(db('erin').ref('pub/bots/b2').set(entry('erin', { ts: 5 })));
      await deny(db(null).ref('pub/bots/b2').set(entry('erin')));
    });
    it('ALLOW reading the directory by update time and by publisher; DENY signed-out reads', async () => {
      await ok(db('mallory').ref('pub/bots').orderByChild('ts').limitToLast(60).get());
      await ok(db('mallory').ref('pub/bots').orderByChild('by').equalTo('dave').get());
      await ok(db('mallory').ref('pub/bots/b1').get());
      await deny(db(null).ref('pub/bots').orderByChild('ts').limitToLast(60).get());
    });
    it('ALLOW the publisher to save a new version (and drop the image); DENY anyone else', async () => {
      await ok(db('dave').ref('pub/bots/b1').update({ def: def('v2'), ver: 2, img: null, imgType: null, by: 'dave', ts: TS }));
      await deny(db('erin').ref('pub/bots/b1').update({ def: def('hijack'), ver: 3, by: 'erin', ts: TS }));
      await deny(db('erin').ref('pub/bots/b1').update({ def: def('hijack'), ver: 3, by: 'dave', ts: TS }));
      await deny(db('dave').ref('pub/bots/b1').update({ ver: 3, by: 'dave' }), 'every write refreshes ts');
    });
    it('ALLOW the publisher to unpublish and an app admin to remove; DENY other users', async () => {
      await deny(db('erin').ref('pub/bots/b1').remove());
      await deny(db('alice').ref('pub/bots/b1').remove(), 'a server owner who installed it cannot remove it from the directory');
      await ok(db('admin1').ref('pub/bots/b1').remove());
      await reset(seed);
      await ok(db('dave').ref('pub/bots/b1').remove());
    });
  });

  describe('sconf/{sid}/bots (installed bots)', () => {
    it('ALLOW every member to read the installed bots; DENY non-members', async () => {
      await ok(db('dave').ref('sconf/s1/bots').get());
      await ok(db('frank').ref('sconf/s1/bots/b1').get());
      await deny(db('mallory').ref('sconf/s1/bots').get());
      await deny(db(null).ref('sconf/s1/bots').get());
    });
    it('ALLOW the owner, admins and "Manage apps" roles to install, update and uninstall', async () => {
      await ok(db('alice').ref('sconf/s1/bots/b2').set(install('alice')));
      await ok(db('bob').ref('sconf/s1/bots/b3').set(install('bob', { def: def(big(20000 - def('').length)), img: big(20000, 'A'), imgType: 'image/png' })));
      await ok(db('erin').ref('sconf/s1/bots/b4').set(install('erin')));
      await ok(db('erin').ref('sconf/s1/bots/b1').update({ def: def('v2'), ver: 2, by: 'dave', author: 'erin', img: null, imgType: null }));
      await ok(db('erin').ref('sconf/s1/bots/b1').remove());
      await ok(db('bob').ref('sconf/s1/bots/b2').remove());
    });
    it('DENY plain members, custom roles without "Manage apps", non-members and oversized copies', async () => {
      await deny(db('dave').ref('sconf/s1/bots/b2').set(install('dave')));
      await deny(db('carol').ref('sconf/s1/bots/b2').set(install('carol')), 'manageMessages is not manageApps');
      await deny(db('dave').ref('sconf/s1/bots/b1').remove());
      await deny(db('dave').ref('sconf/s1/bots/b1').update({ ver: 99 }));
      await deny(db('mallory').ref('sconf/s1/bots/b2').set(install('mallory')));
      await deny(db('alice').ref('sconf/s1/bots/b2').set(install('alice', { def: def(big(20001)) })));
      await deny(db('alice').ref('sconf/s1/bots/b2').set(install('alice', { triggers: { t: { match: 'x' } } })));
    });
  });

  describe('udata/{uid}/botWelcome (welcome handled once per member and bot)', () => {
    it('ALLOW the member to claim and read their own markers', async () => {
      const key = `-NsidAbcdefghijklmno~-NbotAbcdefghijklmn`;
      await ok(db('frank').ref(`udata/frank/botWelcome/${key}`).set(Date.now()));
      await ok(db('frank').ref(`udata/frank/botWelcome/${key}`).get());
      await ok(db('frank').ref(`udata/frank/botWelcome/${key}`).transaction((cur) => (cur === null ? 1 : undefined)));
    });
    it('DENY other users, including server owners', async () => {
      await deny(db('alice').ref('udata/frank/botWelcome/s1~b1').set(1));
      await deny(db('alice').ref('udata/frank/botWelcome').get());
    });
  });
});

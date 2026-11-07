// Add-ons on the generic rules blocks: the exact writes src/features/addons/lib/store.js makes
// (publish, edit, unpublish, admin removal, personal installs with pinned copies, sealed storage,
// consent, server installs) plus the report filed for an add-on.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, TS, assertFails, assertSucceeds } from './helpers.mjs';
import { packChunks } from '../../src/features/addons/lib/chunks.js';

const ok = assertSucceeds, deny = assertFails;
const SHA = 'ab'.repeat(32);
const SHA2 = 'cd'.repeat(32);
const manifest = (by, extra = {}) => ({ name: 'Timer', icon: '⏱', version: '1.0.0', perms: 'storage', sha: SHA, size: 10, by, ts: TS, ...extra });
const codeRec = (by, code = '<p>hi</p>', sha = SHA) => ({ code, sha, by, ts: TS });
const publish = (uid, id, m = manifest(uid), c = codeRec(uid)) => db(uid).ref().update({ [`pub/addons/${id}`]: m, [`pub/addonCode/${id}`]: c });
const appsRole = { nameEnc: box, color: '#00ff00', position: 40, perms: { manageApps: true }, createdAt: 1 };

const seed = (w) => {
  w.servers.s1.roles.rApps = appsRole;
  w.servers.s1.members.erin.roleId = 'rApps';
  w.pub = {
    addons: { a1: { name: 'Clock', icon: '🕐', version: '1.0.0', sha: SHA, size: 9, by: 'dave', ts: 1 } },
    addonCode: { a1: { code: '<p>hi</p>', sha: SHA, by: 'dave', ts: 1 } },
  };
  w.sconf = { s1: { addons: { a1: { sha: SHA, by: 'alice', at: 1, v: '1.0.0', name: 'Clock', icon: '🕐' } } } };
};

describe('add-ons', () => {
  before(getEnv);
  after(cleanup);
  beforeEach(() => reset(seed));

  describe('directory (pub/addons + pub/addonCode)', () => {
    it('ALLOW publishing manifest + code in one update (64 KB of code)', async () => {
      await ok(publish('erin', 'a2'));
      await ok(publish('erin', 'a3', manifest('erin', { desc: 'd'.repeat(500), seed: 'pomodoro' }), codeRec('erin', 'x'.repeat(65536))));
      await ok(db('mallory').ref('pub/addons').orderByChild('ts').limitToLast(100).get());
      await ok(db('mallory').ref('pub/addons').orderByChild('by').equalTo('erin').get());
      await ok(db('mallory').ref('pub/addonCode/a1').get());
    });
    it('DENY reading signed out, forged publisher, stale ts, code over 65536 chars, nested fields', async () => {
      await deny(db(null).ref('pub/addons').get());
      await deny(db(null).ref('pub/addonCode/a1').get());
      await deny(publish('erin', 'a2', manifest('dave'), codeRec('erin')));
      await deny(publish('erin', 'a2', manifest('erin'), codeRec('dave')));
      await deny(publish('erin', 'a2', manifest('erin', { ts: 5 }), codeRec('erin')));
      await deny(publish('erin', 'a2', manifest('erin'), codeRec('erin', 'x'.repeat(65537))));
      await deny(publish('erin', 'a2', manifest('erin', { perms: { storage: true } }), codeRec('erin')));
    });
    it('ALLOW the publisher to replace both records; DENY anyone else (even with by = themselves)', async () => {
      await ok(publish('dave', 'a1', manifest('dave', { version: '1.1.0', sha: SHA2 }), codeRec('dave', '<p>v2</p>', SHA2)));
      await deny(publish('erin', 'a1', manifest('erin', { sha: SHA2 }), codeRec('erin', '<p>evil</p>', SHA2)));
      await deny(db('erin').ref('pub/addonCode/a1').set(codeRec('erin', '<p>evil</p>')));
      await deny(db('erin').ref('pub/addonCode/a1').update({ code: '<p>evil</p>', ts: TS }));
    });
    it('ALLOW unpublish by the publisher or an app admin; DENY others', async () => {
      const gone = { 'pub/addons/a1': null, 'pub/addonCode/a1': null };
      await deny(db('erin').ref().update(gone));
      await deny(db('alice').ref().update(gone));
      await ok(db('admin1').ref().update(gone));
      await reset(seed);
      await ok(db('dave').ref().update(gone));
    });
  });

  describe('personal installs (udata/{me}/addons, addonPin, addonStore, addonConsent)', () => {
    const pin = packChunks('é'.repeat(16000) + '😀'.repeat(8000) + 'x'.repeat(16000) + 'y'.repeat(1000), { sha: SHA });
    it('ALLOW install + pinned copy in one update (16000-char chunks, multi-byte text)', async () => {
      await ok(db('dave').ref().update({
        'udata/dave/addons/a1': { sha: SHA, perms: 'storage', at: 1, v: '1.0.0', name: 'Clock', icon: '🕐' },
        'udata/dave/addonPin/a1': pin,
      }));
      await ok(db('dave').ref('udata/dave/addons/a1').update({ auto: true }));
      await ok(db('dave').ref('udata/dave/addons/a1').update({ auto: null }));
      await ok(db('dave').ref('udata/dave/addonPin/a1').get());
    });
    it('ALLOW sealed storage chunks and consent; uninstall clears all three', async () => {
      await ok(db('dave').ref().update({ 'udata/dave/addonStore/a1': packChunks('Q'.repeat(43712), { iv: box.iv }) }));
      await ok(db('dave').ref().update({ 'udata/dave/addonConsent/s1~a1': { perms: 'readMessages', sha: SHA, at: 1 } }));
      await ok(db('dave').ref().update({ 'udata/dave/addons/a1': null, 'udata/dave/addonPin/a1': null, 'udata/dave/addonStore/a1': null }));
    });
    it('DENY other users reading or writing them, chunks over 20000 chars, deeper nesting', async () => {
      await ok(db('dave').ref('udata/dave/addons/a1').set({ sha: SHA }));
      await deny(db('erin').ref('udata/dave/addons').get());
      await deny(db('erin').ref('udata/dave/addonPin/a1').set(pin));
      await deny(db('erin').ref('udata/dave/addonStore/a1').get());
      await deny(db('dave').ref('udata/dave/addonPin/a1').set({ n: 1, c0: 'x'.repeat(20001) }));
      await deny(db('dave').ref('udata/dave/addons/a1').set({ sha: SHA, perms: { storage: true } }));
    });
  });

  describe('server installs (sconf/{sid}/addons, addonPin)', () => {
    const install = (by) => ({
      'sconf/s1/addons/a2': { sha: SHA, perms: 'readMessages', by, at: 1, v: '1.0.0', name: 'Cloud', icon: '☁️' },
      'sconf/s1/addonPin/a2': packChunks('<p>cloud</p>', { sha: SHA }),
    });
    it('ALLOW the owner, admins and manageApps roles to install, update and uninstall', async () => {
      await ok(db('alice').ref().update(install('alice')));
      await ok(db('bob').ref().update(install('bob')));
      await ok(db('erin').ref().update(install('erin')));
      await ok(db('erin').ref().update({ 'sconf/s1/addons/a2': null, 'sconf/s1/addonPin/a2': null }));
    });
    it('ALLOW members to read; DENY plain members writing and outsiders reading', async () => {
      await ok(db('dave').ref('sconf/s1/addons').get());
      await ok(db('dave').ref('sconf/s1/addonPin').get());
      await deny(db('dave').ref().update(install('dave')));
      await deny(db('carol').ref().update(install('carol'))); // manageMessages/manageRoles, not manageApps
      await deny(db('dave').ref('sconf/s1/addons/a1').remove());
      await deny(db('mallory').ref('sconf/s1/addons').get());
    });
  });

  describe('reports', () => {
    it('ALLOW reporting an add-on as kind shopItem with target addon:{id}', async () => {
      await ok(db('mallory').ref().update({
        'reports/rA': { by: 'mallory', kind: 'shopItem', target: 'addon:a1', reason: 'malware', note: 'steals messages', ts: TS },
        'reportLog/mallory': TS,
      }));
      await ok(db('admin1').ref('reports/rA').get());
    });
  });
});

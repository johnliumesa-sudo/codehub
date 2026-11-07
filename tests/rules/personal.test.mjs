// Round 3, personal: status modes, custom status, favorites, server folders, private notes and synced
// appearance. No new rules (0-byte budget): these pin the exact shapes the feature writes to the
// generic udata / upub blocks and to presence, and who can read or write them.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
const DM = 'dave_zoe';
const seed = (w) => {
  w.udata = {
    dave: {
      status: { mode: 'dnd' },
      favorites: { c_s1_c1: { kind: 'channel', sid: 's1', cid: 'c1', pos: 0 }, [`d_${DM}`]: { kind: 'dm', dmId: DM, pos: 1 } },
      userNotes: { erin: { iv: box.iv, ct: box.ct } },
    },
  };
  w.upub = { dave: { status: { now: { mode: 'dnd', emoji: '💻', text: 'Coding', until: Date.now() + 3_600_000 } } } };
  w.presence = { dave: { state: 'online', lastChanged: 1 } };
};

describe('personal: status, favorites, folders, notes, appearance', () => {
  before(getEnv);
  after(cleanup);
  beforeEach(() => reset(seed));

  describe('status mode (udata/{me}/status/mode) + public record (upub/{uid}/status/now)', () => {
    it('ALLOW the owner to switch modes with the private mode and public DND flag in one update', async () => {
      for (const m of ['online', 'idle', 'invisible', 'dnd']) {
        await ok(db('dave').ref().update({ 'udata/dave/status/mode': m, 'upub/dave/status/now/mode': m === 'dnd' ? 'dnd' : null }));
      }
      await ok(db('dave').ref('udata/dave/status/mode').get());
    });
    it('DENY reading or changing someone else’s private mode (invisible stays private)', async () => {
      await deny(db('erin').ref('udata/dave/status/mode').get());
      await deny(db('erin').ref('udata/dave/status').get());
      await deny(db('erin').ref('udata/dave/status/mode').set('online'));
      await deny(db(null).ref('udata/dave/status/mode').get());
      await deny(db('erin').ref().update({ 'udata/erin/status/mode': 'dnd', 'upub/dave/status/now/mode': null }));
    });
    it('ALLOW any signed-in user to read a custom status; DENY signed-out reads', async () => {
      await ok(db('mallory').ref('upub/dave/status/now').get());
      await ok(db('erin').ref('upub/dave/status').get());
      await deny(db(null).ref('upub/dave/status/now').get());
    });
    it('ALLOW the owner to set and clear emoji, text and expiry; DENY others', async () => {
      await ok(db('dave').ref('upub/dave/status/now').update({ emoji: '🌴', text: 'On vacation', until: null }));
      await ok(db('dave').ref('upub/dave/status/now').update({ emoji: null, text: null, until: null }));
      await ok(db('dave').ref('upub/dave/status/now').remove());
      await deny(db('mallory').ref('upub/dave/status/now').update({ text: 'hacked' }));
      await deny(db('mallory').ref('upub/dave/status/now/mode').remove());
      await deny(db('mallory').ref('upub/dave/status/now').remove());
    });
    it('DENY nested or oversized public status values (the client caps text at 80)', async () => {
      await deny(db('dave').ref('upub/dave/status/now').set({ text: { nested: 'x' } }));
      await deny(db('dave').ref('upub/dave/status/now/text').set('x'.repeat(2001)));
    });
  });

  describe('presence for modes', () => {
    it('ALLOW an invisible user to keep writing offline, and idle on demand', async () => {
      await ok(db('dave').ref('presence/dave').set({ state: 'offline', lastChanged: TS }));
      await ok(db('dave').ref('presence/dave').set({ state: 'idle', lastChanged: TS }));
    });
    it('DENY a dnd presence state (DND is the public upub flag) and writing another user’s presence', async () => {
      await deny(db('dave').ref('presence/dave').set({ state: 'dnd', lastChanged: TS }));
      await deny(db('dave').ref('presence/dave').set({ state: 'invisible', lastChanged: TS }));
      await deny(db('erin').ref('presence/dave').set({ state: 'offline', lastChanged: TS }));
    });
  });

  describe('favorites (udata/{me}/favorites)', () => {
    it('ALLOW starring, reordering in one update and unstarring', async () => {
      await ok(db('dave').ref('udata/dave/favorites/g_g1').set({ kind: 'group', gid: 'g1', pos: 2 }));
      await ok(db('dave').ref().update({
        'udata/dave/favorites/g_g1/pos': 0,
        'udata/dave/favorites/c_s1_c1/pos': 1,
        [`udata/dave/favorites/d_${DM}/pos`]: 2,
      }));
      await ok(db('dave').ref('udata/dave/favorites/g_g1').remove());
      await ok(db('dave').ref('udata/dave/favorites').get());
    });
    it('DENY other users and deeper shapes', async () => {
      await deny(db('erin').ref('udata/dave/favorites').get());
      await deny(db('erin').ref('udata/dave/favorites/g_g1').set({ kind: 'group', gid: 'g1', pos: 0 }));
      await deny(db('dave').ref('udata/dave/favorites/c_s1_c1').set({ kind: 'channel', ids: { sid: 's1' } }));
      await deny(db('dave').ref(`udata/dave/favorites/${'k'.repeat(129)}`).set({ kind: 'dm', pos: 0 }));
    });
  });

  describe('server folders (udata/{me}/serverFolders)', () => {
    const folder = (sids) => ({ iv: box.iv, ct: box.ct, color: '#5b8cff', sids, collapsed: false, at: 1 });
    it('ALLOW creating a folder while taking its servers out of another, renaming, collapsing, deleting', async () => {
      await ok(db('dave').ref('udata/dave/serverFolders/f1').set(folder('s1,s2,s3')));
      await ok(db('dave').ref().update({
        'udata/dave/serverFolders/f2': folder('s3'),
        'udata/dave/serverFolders/f1/sids': 's1,s2',
      }));
      await ok(db('dave').ref().update({ 'udata/dave/serverFolders/f1/iv': 'n'.repeat(16), 'udata/dave/serverFolders/f1/ct': 'bmV3' }));
      await ok(db('dave').ref('udata/dave/serverFolders/f1').update({ collapsed: true, color: '#3ccf91' }));
      await ok(db('dave').ref().update({ 'udata/dave/serverFolders/f2': null, 'udata/dave/serverFolders/f1/sids': 's1,s2,s3' }));
    });
    it('DENY other users, nested server lists and oversized lists', async () => {
      await ok(db('dave').ref('udata/dave/serverFolders/f1').set(folder('s1')));
      await deny(db('mallory').ref('udata/dave/serverFolders').get());
      await deny(db('mallory').ref('udata/dave/serverFolders/f1/sids').set('s9'));
      await deny(db('dave').ref('udata/dave/serverFolders/f1/sids').set({ 0: 's1' }));
      await deny(db('dave').ref('udata/dave/serverFolders/f1/sids').set('s'.repeat(20001)));
    });
  });

  describe('private notes (udata/{me}/userNotes/{uid})', () => {
    it('ALLOW the owner to save, read and delete a sealed note', async () => {
      await ok(db('dave').ref('udata/dave/userNotes/zoe').set({ iv: box.iv, ct: box.ct }));
      await ok(db('dave').ref('udata/dave/userNotes').get());
      await ok(db('dave').ref('udata/dave/userNotes/erin').remove());
    });
    it('DENY the subject (and anyone else) reading or writing my note about them', async () => {
      await deny(db('erin').ref('udata/dave/userNotes/erin').get());
      await deny(db('erin').ref('udata/dave/userNotes').get());
      await deny(db('erin').ref('udata/dave/userNotes/erin').remove());
      await deny(db('mallory').ref('udata/dave/userNotes/erin').set({ iv: box.iv, ct: box.ct }));
    });
  });

  describe('appearance sync (udata/{me}/appearance/prefs)', () => {
    const prefs = { density: 'compact', font: 115, reduceMotion: true, focusRings: false, chatWidth: 'narrow', clock: '24', ts: 1_700_000_000_000 };
    it('ALLOW the owner to upload, read and remove the synced copy', async () => {
      await ok(db('dave').ref('udata/dave/appearance/prefs').set(prefs));
      await ok(db('dave').ref('udata/dave/appearance/prefs').get());
      await ok(db('dave').ref('udata/dave/appearance/prefs').remove());
    });
    it('DENY other users', async () => {
      await ok(db('dave').ref('udata/dave/appearance/prefs').set(prefs));
      await deny(db('erin').ref('udata/dave/appearance/prefs').get());
      await deny(db('erin').ref('udata/dave/appearance/prefs').set(prefs));
    });
  });

  it('account deletion can remove all of it (udata and upub)', async () => {
    await ok(db('dave').ref().update({ 'udata/dave': null, 'upub/dave': null }));
    await admin(async (a) => {
      const [u, p] = await Promise.all([a.ref('udata/dave').get(), a.ref('upub/dave').get()]);
      if (u.exists() || p.exists()) throw new Error('udata/upub should be gone');
    });
  });
});

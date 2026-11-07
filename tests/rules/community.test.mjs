// Round 3 community workstream: the rules gate on channel messages (sconf welcome/req + the
// sitems accepted marker), RSVP/accepted keys bound to their author, events (author edits,
// moderator replacement), welcome/AutoMod config, discovery listings and saved templates.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, pubStamp, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
const appsRole = { nameEnc: box, color: '#00ff00', position: 40, perms: { manageApps: true }, createdAt: 1 };
const msg = (uid) => ({ uid, ts: TS, iv: box.iv, ct: box.ct });
const ev = (by) => ({ by, iv: box.iv, ct: box.ct });
const rsvp = (by, s = 'going') => ({ by, s, ts: 1 });
const welcome = (req) => ({ msg: { iv: box.iv, ct: box.ct, v: 1, by: 'alice' }, ...(req ? { req: true } : {}) });

// erin: custom role with manageApps; carol: rMod (manageMessages); frank: timed out.
const seed = (w) => {
  w.servers.s1.roles.rApps = appsRole;
  w.servers.s1.members.erin.roleId = 'rApps';
  w.servers.s1.timeouts = { frank: Date.now() + 60_000 };
  w.sconf = { s1: { welcome: welcome(true) } };
  w.sitems = { s1: {
    events: { e1: ev('dave') },
    rsvp: { 'e1~erin': rsvp('erin', 'maybe') },
    accepted: { gina: { by: 'gina', v: 1, ts: 1 } },
  } };
  w.pub = { servers: {} };
};

describe('community rules', () => {
  before(getEnv);
  after(cleanup);
  beforeEach(() => reset(seed));

  describe('rules gate on channel messages', () => {
    it('DENY a plain member who has not accepted; ALLOW after they accept', async () => {
      await deny(db('dave').ref('messages/s1/c1/mA').set(msg('dave')));
      await ok(db('dave').ref('sitems/s1/accepted/dave').set({ by: 'dave', v: 1, ts: 1 }));
      await ok(db('dave').ref('messages/s1/c1/mA').set(msg('dave')));
    });
    it('ALLOW owner and admins without accepting', async () => {
      await ok(db('alice').ref('messages/s1/c1/mA').set(msg('alice')));
      await ok(db('bob').ref('messages/s1/c1/mB').set(msg('bob')));
    });
    it('DENY custom-role members (even moderators) until they accept; ALLOW members who accepted', async () => {
      await deny(db('carol').ref('messages/s1/c1/mA').set(msg('carol')));
      await deny(db('erin').ref('messages/s1/c1/mA').set(msg('erin')));
      await ok(db('gina').ref('messages/s1/c1/mA').set(msg('gina')));
    });
    it('ALLOW everyone when acceptance is not required (flag absent or false)', async () => {
      await admin((d) => d.ref('sconf/s1/welcome/req').remove());
      await ok(db('dave').ref('messages/s1/c1/mA').set(msg('dave')));
      await admin((d) => d.ref('sconf/s1/welcome/req').set(false));
      await ok(db('dave').ref('messages/s1/c1/mB').set(msg('dave')));
    });
    it('a marker written by someone else never counts', async () => {
      await admin((d) => d.ref('sitems/s1/accepted/dave').set({ by: 'gina', v: 1, ts: 1 }));
      await deny(db('dave').ref('messages/s1/c1/mA').set(msg('dave')));
    });
    it('still ALLOW editing and deleting older messages while gated', async () => {
      await ok(db('dave').ref('messages/s1/c1/m1').update({ iv: box.iv, ct: 'bmV3', editedAt: TS }));
      await ok(db('dave').ref('messages/s1/c1/m1').remove());
    });
    it('slowmode and timeouts still apply on top of the gate', async () => {
      await deny(db('frank').ref('sitems/s1/accepted/frank').set({ by: 'frank', v: 1, ts: 1 })); // timed out
      await admin((d) => d.ref('sitems/s1/accepted/frank').set({ by: 'frank', v: 1, ts: 1 }));
      await deny(db('frank').ref('messages/s1/c1/mA').set(msg('frank')));
    });
  });

  describe('accepted markers and RSVPs are bound to their author', () => {
    it('DENY creating a marker under someone else\'s uid (even with by = self)', async () => {
      await deny(db('dave').ref('sitems/s1/accepted/erin').set({ by: 'dave', v: 1, ts: 1 }));
      await deny(db('dave').ref('sitems/s1/accepted/erin').set({ by: 'erin', v: 1, ts: 1 }));
      await deny(db('mallory').ref('sitems/s1/accepted/mallory').set({ by: 'mallory', v: 1, ts: 1 }));
      await ok(db('erin').ref('sitems/s1/accepted/erin').set({ by: 'erin', v: 1, ts: 1 }));
    });
    it('ALLOW updating my own marker; moderators may reset (delete) any marker; others may not', async () => {
      await ok(db('gina').ref('sitems/s1/accepted/gina').update({ v: 2, ts: 2 }));
      await deny(db('dave').ref('sitems/s1/accepted/gina').remove());
      await deny(db('erin').ref('sitems/s1/accepted/gina').remove()); // manageApps is not manageMessages
      await ok(db('carol').ref('sitems/s1/accepted/gina').remove());
    });
    it('RSVP: ALLOW my own key {eventId}~{me}; DENY keys of other members', async () => {
      await ok(db('dave').ref('sitems/s1/rsvp/e1~dave').set(rsvp('dave')));
      await ok(db('dave').ref('sitems/s1/rsvp/e1~dave').update({ s: 'maybe', ts: 2 }));
      await deny(db('dave').ref('sitems/s1/rsvp/e1~bob').set(rsvp('dave')));
      await deny(db('dave').ref('sitems/s1/rsvp/e1~bob').set(rsvp('bob')));
      await deny(db('dave').ref('sitems/s1/rsvp/e1~erin').set(rsvp('dave', 'not'))); // taken by erin
      await deny(db('frank').ref('sitems/s1/rsvp/e1~frank').set(rsvp('frank'))); // timed out
      await deny(db('mallory').ref('sitems/s1/rsvp/e1~mallory').set(rsvp('mallory')));
    });
    it('RSVP: ALLOW removing my own and moderators removing any; DENY other members', async () => {
      await deny(db('dave').ref('sitems/s1/rsvp/e1~erin').remove());
      await ok(db('erin').ref('sitems/s1/rsvp/e1~erin').remove());
      await reset(seed);
      await ok(db('carol').ref('sitems/s1/rsvp/e1~erin').remove());
    });
    it('my private RSVP index in udata is mine only, written with the RSVP', async () => {
      await ok(db('dave').ref().update({ 'sitems/s1/rsvp/e1~dave': rsvp('dave'), 'udata/dave/rsvp/s1~e1': 'going' }));
      await deny(db('erin').ref('udata/dave/rsvp').get());
      await deny(db('erin').ref('udata/dave/rsvp/s1~e1').set('not'));
      await ok(db('dave').ref().update({ 'sitems/s1/rsvp/e1~dave': null, 'udata/dave/rsvp/s1~e1': null }));
    });
  });

  describe('events', () => {
    it('ALLOW a member to create an event as themselves; DENY forged authors and non-members', async () => {
      await ok(db('erin').ref('sitems/s1/events/e2').set(ev('erin')));
      await deny(db('erin').ref('sitems/s1/events/e3').set(ev('dave')));
      await deny(db('mallory').ref('sitems/s1/events/e3').set(ev('mallory')));
      await deny(db('frank').ref('sitems/s1/events/e3').set(ev('frank')));
    });
    it('ALLOW the organizer to edit and cancel in place; DENY everyone else editing in place', async () => {
      await ok(db('dave').ref('sitems/s1/events/e1').set({ by: 'dave', iv: box.iv, ct: 'Y2FuY2VsbGVk' }));
      await deny(db('erin').ref('sitems/s1/events/e1').set({ by: 'erin', iv: box.iv, ct: 'x' }));
      await deny(db('carol').ref('sitems/s1/events/e1/ct').set('bW9k'));
    });
    it('ALLOW a manageMessages moderator to replace an event in one update; DENY plain members', async () => {
      await deny(db('erin').ref().update({ 'sitems/s1/events/e9': ev('erin'), 'sitems/s1/events/e1': null }));
      await ok(db('carol').ref().update({ 'sitems/s1/events/e9': ev('carol'), 'sitems/s1/events/e1': null }));
    });
    it('ALLOW the organizer and moderators to delete; a moderator also clears the RSVPs', async () => {
      await deny(db('erin').ref('sitems/s1/events/e1').remove());
      await ok(db('dave').ref().update({ 'sitems/s1/events/e1': null }));
      await reset(seed);
      await ok(db('carol').ref().update({ 'sitems/s1/events/e1': null, 'sitems/s1/rsvp/e1~erin': null }));
      await reset(seed);
      await deny(db('dave').ref().update({ 'sitems/s1/events/e1': null, 'sitems/s1/rsvp/e1~erin': null })); // not a moderator
    });
  });

  describe('welcome and AutoMod config (sconf)', () => {
    it('ALLOW owner, admins and manageApps roles to write; members read', async () => {
      await ok(db('alice').ref('sconf/s1/welcome').set(welcome(false)));
      await ok(db('bob').ref('sconf/s1/welcome/req').set(true));
      await ok(db('erin').ref('sconf/s1/automod/cfg').set({ iv: box.iv, ct: box.ct }));
      await ok(db('dave').ref('sconf/s1/welcome').get());
      await ok(db('dave').ref('sconf/s1/automod/cfg').get());
    });
    it('DENY plain members and moderators without manageApps (no lifting the gate yourself)', async () => {
      await deny(db('dave').ref('sconf/s1/welcome/req').remove());
      await deny(db('dave').ref('sconf/s1/welcome/req').set(false));
      await deny(db('carol').ref('sconf/s1/welcome/req').remove());
      await deny(db('carol').ref('sconf/s1/automod/cfg').set({ iv: box.iv, ct: box.ct }));
      await deny(db('mallory').ref('sconf/s1/welcome').get());
    });
  });

  describe('discovery listings (pub/servers)', () => {
    const listing = (by, extra = {}) => ({ by, ts: TS, name: 'Rustaceans', desc: 'Learn Rust', tags: 'rust,beginners', glyph: '🦀', color: '#ff8f4d', members: 7, iid: 'pubInv', k: 'a'.repeat(43), ...extra });
    it('ALLOW the owner to list, update and unlist (removing the invite in the same update)', async () => {
      await ok(db('alice').ref().update({
        'servers/s1/invites/pubInv': { createdBy: 'alice', createdAt: TS, expiresAt: 0, maxUses: 0, uses: 0 },
      }));
      await deny(db('alice').ref('pub/servers/s1').set(listing('alice')), 'a new listing must stamp the publish window');
      await ok(db('alice').ref().update({ 'pub/servers/s1': listing('alice'), ...pubStamp('alice', 's1') }));
      await ok(db('alice').ref('pub/servers/s1').set(listing('alice')), 'replacing it (new invite) needs no stamp');
      await ok(db('alice').ref('sconf/s1/discovery/listing').set({ iid: 'pubInv' }));
      await ok(db('alice').ref('pub/servers/s1').update({ members: 8, ts: TS, by: 'alice' }));
      await ok(db('mallory').ref('pub/servers').get());
      await deny(db(null).ref('pub/servers').get());
      await ok(db('alice').ref().update({ 'pub/servers/s1': null, 'servers/s1/invites/pubInv': null, 'sconf/s1/discovery': null }));
    });
    it('DENY admins, members and outsiders listing someone else\'s server', async () => {
      for (const u of ['bob', 'erin', 'mallory']) await deny(db(u).ref().update({ 'pub/servers/s1': listing(u), ...pubStamp(u, 's1') }));
      await deny(db('mallory').ref().update({ 'pub/servers/s1': listing('alice'), ...pubStamp('mallory', 's1') }));
    });
    it('ALLOW an app admin to remove a listing; DENY other users', async () => {
      await admin((d) => d.ref('pub/servers/s1').set({ ...listing('alice'), ts: 1 }));
      await deny(db('bob').ref('pub/servers/s1').remove());
      await deny(db('mallory').ref('pub/servers/s1').remove());
      await ok(db('admin1').ref('pub/servers/s1').remove());
    });
    it('a listed invite works through the normal join rules', async () => {
      await admin((d) => d.ref('servers/s1/invites/pubInv').set({ createdBy: 'alice', createdAt: 1, expiresAt: 0, maxUses: 0, uses: 3 }));
      await ok(db('newbie').ref('servers/s1/invites/pubInv').get());
      await ok(db('newbie').ref().update({
        'servers/s1/members/newbie': { role: 'member', joinedAt: TS, invite: 'pubInv' },
        'servers/s1/keys/newbie': { epk: { kty: 'EC', crv: 'P-256', x: 'xx', y: 'yy' }, iv: 'b'.repeat(16), ct: 'd3JhcA' },
        'servers/s1/invites/pubInv/uses': 4,
        'userServers/newbie/s1': { joinedAt: TS },
      }));
    });
  });

  describe('saved templates (udata)', () => {
    it('ALLOW me to save, read and delete my templates; DENY anyone else', async () => {
      await ok(db('dave').ref('udata/dave/templates/t1').set({ iv: box.iv, ct: box.ct }));
      await ok(db('dave').ref('udata/dave/templates').get());
      await deny(db('erin').ref('udata/dave/templates').get());
      await deny(db('erin').ref('udata/dave/templates/t2').set({ iv: box.iv, ct: box.ct }));
      await ok(db('dave').ref('udata/dave/templates/t1').remove());
    });
    it('my welcome-seen marker is private too', async () => {
      await ok(db('dave').ref('udata/dave/welcomeSeen/s1').set(1));
      await deny(db('erin').ref('udata/dave/welcomeSeen/s1').get());
    });
  });
});

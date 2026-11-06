// Regression tests for the verifier findings fixed after integration.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);
beforeEach(() => reset());

describe('verifier fixes', () => {
  it('DENY game owner wiping gameLikes alone (like inflation); ALLOW with the game', async () => {
    await ok(db('dave').ref().update({ 'games/gm1/likes': 1, 'gameLikes/gm1/dave': true }));
    await deny(db('dave').ref('gameLikes/gm1').remove());
    await deny(db('admin1').ref('gameLikes/gm1').remove());
    await ok(db('dave').ref().update({ 'games/gm1': null, 'gameCode/gm1': null, 'gameLikes/gm1': null }));
  });
  it('DENY plain string at equipped/{uid}, equipped/{uid}/ext, users/{uid}, snippets/{uid}', async () => {
    await deny(db('erin').ref('equipped/erin').set('x'.repeat(1000)));
    await deny(db('erin').ref('equipped/erin/ext').set('x'));
    await deny(db('erin').ref('users/erin').set('x'));
    await deny(db('erin').ref('snippets/erin').set('x'));
    await deny(db('erin').ref('reads/erin').set(5));
    await deny(db('erin').ref('notifPrefs/erin/settings').set(true));
    await ok(db('erin').ref('equipped/erin/badge').set('itemA'));
    await ok(db('erin').ref('users/erin/name').set('Erin'));
    await ok(db('erin').ref('equipped/erin').remove());
  });
  it('DENY kick holder removing a current member\'s userServers entry; ALLOW as part of a kick', async () => {
    await deny(db('carol').ref('userServers/alice/s1').remove());
    await deny(db('carol').ref('userServers/dave/s1').remove());
    await deny(db('bob').ref('userServers/dave/s1').remove());
    await ok(db('carol').ref().update({ 'servers/s1/members/dave': null, 'servers/s1/keys/dave': null, 'userServers/dave/s1': null }));
  });
  it('ALLOW ban (root update incl. userServers) by ban-role holder', async () => {
    await ok(db('gina').ref().update({
      'servers/s1/bans/dave': true, 'servers/s1/members/dave': null, 'servers/s1/keys/dave': null, 'userServers/dave/s1': null,
    }));
  });
  it('DENY custom-role ban of a non-member; ALLOW admin/owner pre-emptive ban', async () => {
    await deny(db('gina').ref('servers/s1/bans/zoe').set(true));
    await ok(db('bob').ref('servers/s1/bans/zoe').set(true));
    await ok(db('alice').ref('servers/s1/bans/mallory').set(true));
  });
  it('DENY audit append by a role with no moderation permission; ALLOW mod-perm role', async () => {
    await deny(db('erin').ref('audit/s1').push({ by: 'erin', ts: TS, iv: box.iv, ct: box.ct }));
    await ok(db('gina').ref('audit/s1').push({ by: 'gina', ts: TS, iv: box.iv, ct: box.ct }));
  });
  it('DENY member wiping all checkpoints of a live file; ALLOW with the file / by admin', async () => {
    await deny(db('erin').ref('collab/s1/c2/checkpoints/f1').remove());
    await ok(db('bob').ref('collab/s1/c2/checkpoints/f1').remove());
  });
  it('DENY codespace editor wiping checkpoints of a live file; ALLOW owner', async () => {
    await admin((d) => d.ref('csCollab/cs1/checkpoints/f1/cp1').set({ uid: 'alice', ts: 1, iv: box.iv, ct: box.ct }));
    await deny(db('bob').ref('csCollab/cs1/checkpoints/f1').remove());
    await ok(db('bob').ref().update({ 'csCollab/cs1/files/f1': null, 'csCollab/cs1/checkpoints/f1': null }));
  });
  it('DENY becoming admin when config/adminPromo is shorter than 8 chars', async () => {
    await reset((w) => { w.config.adminPromo = 'short12'; });
    await ok(db('mallory').ref('promoAttempts/mallory').set({ code: 'short12', at: TS }));
    await deny(db('mallory').ref('admins/mallory').set({ at: TS }));
  });
  it('ALLOW a 13-char promo code (the owner\'s real code length)', async () => {
    await reset((w) => { w.config.adminPromo = 'Abcdefgh12345'; });
    await ok(db('mallory').ref('promoAttempts/mallory').set({ code: 'Abcdefgh12345', at: TS }));
    await ok(db('mallory').ref('admins/mallory').set({ at: TS }));
  });
});

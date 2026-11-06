import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, wrap, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);
beforeEach(() => reset());

describe('extra attack probes', () => {
  it('DENY write to unknown top-level path (root deny-all)', async () => {
    await deny(db('dave').ref('pwn').set(1));
    await deny(db('admin1').ref().once('value'));
  });
  it('DENY joining with a smuggled roleId', async () => {
    await deny(db('mallory').ref().update({
      'servers/s1/members/mallory': { role: 'member', joinedAt: 1, invite: 'i1', roleId: 'rHigh' },
      'servers/s1/keys/mallory': wrap, 'userServers/mallory/s1': { joinedAt: 1 }, 'servers/s1/invites/i1/uses': 1,
    }));
  });
  it('DENY existing member re-joins to reset record', async () => {
    await deny(db('dave').ref().update({
      'servers/s1/members/dave': { role: 'member', joinedAt: 2, invite: 'i1' }, 'servers/s1/invites/i1/uses': 1,
    }));
  });
  it('DENY plain member creates invites / channels', async () => {
    await deny(db('dave').ref('servers/s1/invites/iX').set({ createdBy: 'dave', createdAt: 1, expiresAt: 0, maxUses: 0, uses: 0 }));
    await deny(db('dave').ref('servers/s1/channels/cX').set({ type: 'text', enc: box, position: 3, createdAt: 1 }));
  });
  it('DENY app admin moderates inside a server', async () => {
    await deny(db('admin1').ref('messages/s1/c1/m1').remove());
    await deny(db('admin1').ref('servers/s1/members/dave').remove());
  });
  it('DENY viewer writes codespace repo link; ALLOW viewer leaves', async () => {
    await deny(db('dave').ref('csCollab/cs1/repo').set(box));
    await ok(db('dave').ref().update({
      'codespaces/cs1/members/dave': null, 'codespaces/cs1/keys/dave': null, 'userCodespaces/dave/cs1': null,
    }));
  });
  it('DENY codespace owner role for a non-owner at creation', async () => {
    await deny(db('mallory').ref('codespaces/cs3').set({
      meta: { ownerId: 'mallory', nameEnc: box, createdAt: Date.now() },
      members: { mallory: { role: 'owner', joinedAt: 1, addedBy: 'mallory' }, dave: { role: 'owner', joinedAt: 1, addedBy: 'mallory' } },
      keys: { mallory: wrap },
    }));
  });
  it('DENY buying two items with one payment', async () => {
    await reset((w) => { w.wallets.dave.balance = 200; });
    await deny(db('dave').ref().update({
      'wallets/dave/balance': 150, 'wallets/dave/lastItem': 'itemA',
      'inventory/dave/itemA': { at: TS, price: 50 }, 'inventory/dave/itemTheme': { at: TS, price: 10 },
    }));
  });
  it('DENY claim that also changes lastItem', async () => {
    await deny(db('erin').ref('wallets/erin').set({ balance: 120, lastClaim: TS, lastItem: 'itemBig' }));
  });
  it('DENY writing gameLikes in bulk / resetting likes as owner', async () => {
    await deny(db('mallory').ref('gameLikes/gm1').set({ mallory: true }));
    await reset((w) => { w.games.gm1.likes = 3; });
    await deny(db('dave').ref().update({
      'games/gm1': { ownerId: 'dave', title: 'T', desc: '', createdAt: 1, updatedAt: TS, likes: 999, size: 5 },
      'gameCode/gm1': { html: 'x' }, 'publishLog/dave': TS,
    }));
  });
  it('DENY report as another user (reportLog of victim)', async () => {
    await deny(db('mallory').ref().update({
      'reports/rX': { by: 'mallory', kind: 'user', target: 'dave', reason: 'spam', ts: TS }, 'reportLog/dave': TS,
    }));
  });
  it('DENY group member reading after leaving', async () => {
    await ok(db('dave').ref().update({
      'groups/g1/members/dave': null, 'groups/g1/keys/1/dave': null, 'userGroups/dave/g1': null,
      'groups/g1/meta/needsRotate': true,
    }));
    await deny(db('dave').ref('groupMessages/g1').once('value'));
  });
});

import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, wrap, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);
beforeEach(() => reset());

describe('regression: servers, invites, messages', () => {
  it('ALLOW create server in one multi-path update', async () => {
    await ok(db('mallory').ref().update({
      'servers/s2': {
        meta: { nameEnc: box, ownerId: 'mallory', color: '#0f0', createdAt: Date.now() },
        members: { mallory: { role: 'owner', joinedAt: Date.now() } },
        keys: { mallory: wrap },
        channels: { general: { type: 'text', enc: box, position: 0, createdAt: 1 },
          workspace: { type: 'code', enc: box, position: 1, createdAt: 1 } },
      },
      'userServers/mallory/s2': { joinedAt: Date.now() },
    }));
  });
  it('DENY create server claiming another owner', async () => {
    await deny(db('mallory').ref('servers/s2').set({
      meta: { nameEnc: box, ownerId: 'alice', createdAt: 1 },
      members: { mallory: { role: 'owner', joinedAt: 1 } }, keys: { mallory: wrap },
    }));
  });
  const join = (uid, iid, uses) => ({
    [`servers/s1/members/${uid}`]: { role: 'member', joinedAt: Date.now(), invite: iid },
    [`servers/s1/keys/${uid}`]: wrap,
    [`userServers/${uid}/s1`]: { joinedAt: Date.now() },
    [`servers/s1/invites/${iid}/uses`]: uses,
  });
  it('ALLOW join via invite with atomic uses+1', async () => { await ok(db('mallory').ref().update(join('mallory', 'i1', 1))); });
  it('DENY join without incrementing uses', async () => {
    const u = join('mallory', 'i1', 1); delete u['servers/s1/invites/i1/uses'];
    await deny(db('mallory').ref().update(u));
  });
  it('DENY join with expired invite', async () => { await deny(db('mallory').ref().update(join('mallory', 'iExp', 1))); });
  it('DENY join with used-up invite', async () => { await deny(db('mallory').ref().update(join('mallory', 'iFull', 2))); });
  it('DENY banned user joining', async () => { await deny(db('hank').ref().update(join('hank', 'i1', 1))); });
  it('DENY joining as admin', async () => {
    const u = join('mallory', 'i1', 1); u['servers/s1/members/mallory'].role = 'admin';
    await deny(db('mallory').ref().update(u));
  });
  it('ALLOW member sends message', async () => {
    await ok(db('dave').ref('messages/s1/c1').push({ uid: 'dave', ts: TS, iv: box.iv, ct: box.ct }));
  });
  it('DENY message forging another author', async () => {
    await deny(db('dave').ref('messages/s1/c1').push({ uid: 'alice', ts: TS, iv: box.iv, ct: box.ct }));
  });
  it('DENY non-member sends message', async () => {
    await deny(db('mallory').ref('messages/s1/c1').push({ uid: 'mallory', ts: TS, iv: box.iv, ct: box.ct }));
  });
  it('DENY non-member reads server / messages / collab', async () => {
    await deny(db('mallory').ref('servers/s1').once('value'));
    await deny(db('mallory').ref('messages/s1/c1').once('value'));
    await deny(db('mallory').ref('collab/s1/c2').once('value'));
  });
  it('ALLOW member reads server and messages', async () => {
    await ok(db('dave').ref('servers/s1').once('value'));
    await ok(db('dave').ref('messages/s1/c1').once('value'));
  });
  it('DENY plain member edits someone else\'s message', async () => {
    await deny(db('erin').ref('messages/s1/c1/m1/ct').set('aGFjaw'));
  });
  it('ALLOW manageMessages role deletes a message', async () => {
    await ok(db('carol').ref('messages/s1/c1/m1').remove());
  });
});

describe('roles (F5): escalation and rank', () => {
  it('DENY member sets own role to admin', async () => {
    await deny(db('dave').ref('servers/s1/members/dave/role').set('admin'));
  });
  it('DENY member rewrites own member record as admin', async () => {
    await deny(db('dave').ref('servers/s1/members/dave').set({ role: 'admin', joinedAt: 1 }));
  });
  it('DENY member assigns themselves a custom role', async () => {
    await deny(db('dave').ref('servers/s1/members/dave/roleId').set('rHigh'));
  });
  it('DENY manageRoles member assigns themselves a higher role', async () => {
    await deny(db('carol').ref('servers/s1/members/carol/roleId').set('rHigh'));
  });
  it('DENY plain member creates a role', async () => {
    await deny(db('dave').ref('servers/s1/roles/rX').set({ nameEnc: box, color: '#00ff00', position: 5, perms: {}, createdAt: 1 }));
  });
  it('ALLOW manageRoles member creates lower role with subset perms', async () => {
    await ok(db('carol').ref('servers/s1/roles/rX').set({ nameEnc: box, color: '#00ff00', position: 40, perms: { kick: true }, createdAt: 1 }));
  });
  it('DENY manageRoles member creates role at/above own position', async () => {
    await deny(db('carol').ref('servers/s1/roles/rX').set({ nameEnc: box, color: '#00ff00', position: 50, perms: {}, createdAt: 1 }));
    await deny(db('carol').ref('servers/s1/roles/rX').set({ nameEnc: box, color: '#00ff00', position: 70, perms: {}, createdAt: 1 }));
  });
  it('DENY manageRoles member grants a perm they lack (ban)', async () => {
    await deny(db('carol').ref('servers/s1/roles/rX').set({ nameEnc: box, color: '#00ff00', position: 5, perms: { ban: true }, createdAt: 1 }));
  });
  it('DENY manageRoles member edits own role (raise position / add perms)', async () => {
    await deny(db('carol').ref('servers/s1/roles/rMod/position').set(85));
    await deny(db('carol').ref('servers/s1/roles/rMod/perms/ban').set(true));
  });
  it('DENY manageRoles member edits higher role', async () => {
    await deny(db('carol').ref('servers/s1/roles/rHigh/perms/kick').set(true));
  });
  it('ALLOW manageRoles member assigns lower role to plain member', async () => {
    await ok(db('carol').ref('servers/s1/members/dave/roleId').set('rLow'));
  });
  it('DENY manageRoles member assigns equal/higher role', async () => {
    await deny(db('carol').ref('servers/s1/members/dave/roleId').set('rMod'));
    await deny(db('carol').ref('servers/s1/members/dave/roleId').set('rHigh'));
  });
  it('DENY assigning a non-existent role', async () => {
    await deny(db('alice').ref('servers/s1/members/dave/roleId').set('nope'));
  });
  it('DENY lower role changes higher member\'s role', async () => {
    await deny(db('carol').ref('servers/s1/members/frank/roleId').remove());
    await deny(db('erin').ref('servers/s1/members/carol/roleId').remove());
  });
  it('DENY admin promotes a member to admin; ALLOW owner does', async () => {
    await deny(db('bob').ref('servers/s1/members/dave/role').set('admin'));
    await ok(db('alice').ref('servers/s1/members/dave/role').set('admin'));
  });
  const kick = (uid) => ({ [`servers/s1/members/${uid}`]: null, [`servers/s1/keys/${uid}`]: null, [`userServers/${uid}/s1`]: null });
  it('ALLOW kick-role member kicks lower member', async () => { await ok(db('carol').ref().update(kick('dave'))); });
  it('DENY kick-role member kicks admin / owner / higher role', async () => {
    await deny(db('carol').ref().update(kick('bob')));
    await deny(db('carol').ref().update(kick('alice')));
    await deny(db('carol').ref().update(kick('frank')));
  });
  it('DENY role without kick perm kicks', async () => { await deny(db('erin').ref().update(kick('dave'))); });
  it('DENY admin kicks admin; ALLOW admin kicks member', async () => {
    await reset((w) => { w.servers.s1.members.hank = { role: 'admin', joinedAt: 1 }; delete w.servers.s1.bans; });
    await deny(db('bob').ref().update(kick('hank')));
    await ok(db('bob').ref().update(kick('dave')));
  });
  it('ALLOW ban-role member bans (remove + bans in one update)', async () => {
    await ok(db('gina').ref().update({ ...kick('dave'), 'servers/s1/bans/dave': true }));
  });
  it('DENY ban-role member removes without writing ban', async () => {
    await deny(db('gina').ref().update(kick('dave')));
  });
  it('DENY plain member bans someone', async () => {
    await deny(db('dave').ref('servers/s1/bans/erin').set(true));
  });
});

describe('timeouts (F14)', () => {
  it('ALLOW timeout-role member times out lower member', async () => {
    await ok(db('carol').ref('servers/s1/timeouts/dave').set(Date.now() + 3600e3));
  });
  it('DENY timeout over 28 days', async () => {
    await deny(db('carol').ref('servers/s1/timeouts/dave').set(Date.now() + 30 * 86400e3));
  });
  it('DENY plain member times out others / higher roles', async () => {
    await deny(db('dave').ref('servers/s1/timeouts/erin').set(Date.now() + 3600e3));
    await deny(db('carol').ref('servers/s1/timeouts/bob').set(Date.now() + 3600e3));
  });
  describe('while timed out', () => {
    beforeEach(() => reset((w) => { w.servers.s1.timeouts = { dave: Date.now() + 3600e3 }; }));
    it('DENY send, react, type, edit', async () => {
      await deny(db('dave').ref('messages/s1/c1').push({ uid: 'dave', ts: TS, iv: box.iv, ct: box.ct }));
      await deny(db('dave').ref('messages/s1/c1/m1/reactions/x/dave').set(true));
      await deny(db('dave').ref('typing/ch/s1/c1/dave').set(Date.now()));
      await deny(db('dave').ref('messages/s1/c1/m1/ct').set('bmV3'));
    });
    it('DENY clearing own timeout', async () => {
      await deny(db('dave').ref('servers/s1/timeouts/dave').remove());
    });
    it('ALLOW still reading', async () => { await ok(db('dave').ref('messages/s1/c1').once('value')); });
  });
});

describe('audit log (F15)', () => {
  it('ALLOW owner reads audit; DENY plain member / role without viewAudit', async () => {
    await ok(db('alice').ref('audit/s1').once('value'));
    await deny(db('dave').ref('audit/s1').once('value'));
    await deny(db('carol').ref('audit/s1').once('value'));
  });
  it('ALLOW role holder appends entry; DENY plain member', async () => {
    await ok(db('carol').ref('audit/s1').push({ by: 'carol', ts: TS, iv: box.iv, ct: box.ct }));
    await deny(db('dave').ref('audit/s1').push({ by: 'dave', ts: TS, iv: box.iv, ct: box.ct }));
  });
  it('DENY forging by / editing / deleting entries', async () => {
    await deny(db('carol').ref('audit/s1').push({ by: 'alice', ts: TS, iv: box.iv, ct: box.ct }));
    await deny(db('bob').ref('audit/s1/a1/ct').set('ZWRpdA'));
    await deny(db('bob').ref('audit/s1/a1').remove());
  });
});

describe('channel workspace (collab) and checkpoints (F9)', () => {
  it('ALLOW plain member deletes a workspace file (+checkpoints)', async () => {
    await ok(db('dave').ref().update({
      'collab/s1/c2/files/f1': null, 'collab/s1/c2/updates/f1': null,
      'collab/s1/c2/snapshots/f1': null, 'collab/s1/c2/checkpoints/f1': null,
    }));
  });
  it('ALLOW member creates checkpoint; DENY overwrite / non-member', async () => {
    await ok(db('erin').ref('collab/s1/c2/checkpoints/f1').push({ uid: 'erin', ts: TS, iv: box.iv, ct: box.ct }));
    await deny(db('erin').ref('collab/s1/c2/checkpoints/f1/cp1').set({ uid: 'erin', ts: TS, iv: box.iv, ct: box.ct }));
    await deny(db('mallory').ref('collab/s1/c2/checkpoints/f1').push({ uid: 'mallory', ts: TS, iv: box.iv, ct: box.ct }));
  });
});

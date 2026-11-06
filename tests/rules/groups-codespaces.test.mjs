import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, wrap, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);
beforeEach(() => reset());

describe('groups (F1)', () => {
  const create = (owner, others) => {
    const members = { [owner]: { role: 'owner', joinedAt: 1, addedBy: owner } };
    const keys = { [owner]: wrap };
    const u = {};
    for (const o of others) {
      members[o] = { role: 'member', joinedAt: 1, addedBy: owner }; keys[o] = wrap;
      u[`userGroups/${o}/g2`] = { addedAt: 1 };
    }
    u['groups/g2'] = { meta: { ownerId: owner, nameEnc: box, epoch: 1, createdAt: 1 }, members, keys: { 1: keys },
      last: { ts: TS, uid: owner } };
    u[`userGroups/${owner}/g2`] = { addedAt: 1 };
    u[`reads/${owner}/grp_g2`] = 1;
    return u;
  };
  it('ALLOW create group in one update', async () => { await ok(db('dave').ref().update(create('dave', ['erin', 'bob']))); });
  it('DENY creating group that includes someone who blocked me', async () => {
    await deny(db('mallory').ref().update(create('mallory', ['zoe'])));
  });
  it('DENY group created with epoch != 1 or another owner', async () => {
    const u = create('dave', ['erin']); u['groups/g2'].meta.epoch = 5;
    await deny(db('dave').ref().update(u));
    const v = create('dave', ['erin']); v['groups/g2'].meta.ownerId = 'erin';
    await deny(db('dave').ref().update(v));
  });
  it('DENY non-member reads group / messages / typing', async () => {
    await deny(db('mallory').ref('groups/g1').once('value'));
    await deny(db('mallory').ref('groupMessages/g1').once('value'));
    await deny(db('mallory').ref('typing/grp/g1').once('value'));
  });
  it('ALLOW member reads and sends with current epoch', async () => {
    await ok(db('dave').ref('groups/g1').once('value'));
    await ok(db('dave').ref('groupMessages/g1').once('value'));
    await ok(db('dave').ref().update({
      'groupMessages/g1/gmNew': { uid: 'dave', ts: TS, epoch: 1, iv: box.iv, ct: box.ct },
      'groups/g1/last': { ts: TS, uid: 'dave' }, 'reads/dave/grp_g1': Date.now(),
    }));
  });
  it('DENY message with stale/future epoch or forged author', async () => {
    await deny(db('dave').ref('groupMessages/g1').push({ uid: 'dave', ts: TS, epoch: 2, iv: box.iv, ct: box.ct }));
    await deny(db('dave').ref('groupMessages/g1').push({ uid: 'erin', ts: TS, epoch: 1, iv: box.iv, ct: box.ct }));
    await deny(db('mallory').ref('groupMessages/g1').push({ uid: 'mallory', ts: TS, epoch: 1, iv: box.iv, ct: box.ct }));
  });
  const removeErin = (extra = {}) => ({
    'groups/g1/members/erin': null, 'groups/g1/keys/1/erin': null, 'userGroups/erin/g1': null,
    'groups/g1/meta/epoch': 2, 'groups/g1/meta/nameEnc': box, 'groups/g1/meta/needsRotate': null,
    'groups/g1/keys/2/alice': wrap, 'groups/g1/keys/2/dave': wrap, ...extra,
  });
  it('ALLOW owner removes member with epoch+1 rotation', async () => {
    await ok(db('alice').ref().update(removeErin()));
    await deny(db('erin').ref('groups/g1').once('value'));
    await deny(db('erin').ref('groupMessages/g1').once('value'));
  });
  it('DENY owner removes member without rotating epoch', async () => {
    await deny(db('alice').ref().update({ 'groups/g1/members/erin': null, 'userGroups/erin/g1': null }));
  });
  it('DENY owner rotation that skips epochs', async () => {
    await deny(db('alice').ref().update(removeErin({ 'groups/g1/meta/epoch': 3 })));
  });
  it('DENY rotation that re-keys the removed member', async () => {
    await deny(db('alice').ref().update(removeErin({ 'groups/g1/keys/2/erin': wrap })));
  });
  it('DENY non-owner member removes another member', async () => {
    await deny(db('dave').ref().update({ 'groups/g1/members/erin': null, 'groups/g1/meta/epoch': 2 }));
    await deny(db('dave').ref('groups/g1/members/erin').remove());
  });
  it('ALLOW member leaves and flags rotation', async () => {
    await ok(db('dave').ref().update({
      'groups/g1/members/dave': null, 'groups/g1/keys/1/dave': null, 'userGroups/dave/g1': null,
      'groups/g1/meta/needsRotate': true,
    }));
  });
  it('DENY owner leaves by deleting own member entry', async () => {
    await deny(db('alice').ref('groups/g1/members/alice').remove());
  });
  it('DENY non-owner adds a member; ALLOW owner adds', async () => {
    const add = (by) => ({
      'groups/g1/members/mallory': { role: 'member', joinedAt: 1, addedBy: by },
      'groups/g1/keys/1/mallory': wrap, 'userGroups/mallory/g1': { addedAt: 1 }, 'groups/g1/meta/epoch': 1,
    });
    await deny(db('dave').ref().update(add('dave')));
    await ok(db('alice').ref().update(add('alice')));
  });
  it('DENY member self-promotes to owner or overwrites keys/meta', async () => {
    await deny(db('dave').ref('groups/g1/members/dave/role').set('owner'));
    await deny(db('dave').ref('groups/g1/meta/ownerId').set('dave'));
    await deny(db('dave').ref('groups/g1/keys/1/erin').set(wrap));
  });
  it('DENY adding a blocker to a group', async () => {
    await reset((w) => { w.groups.g9 = { meta: { ownerId: 'mallory', nameEnc: box, epoch: 1, createdAt: 1 },
      members: { mallory: { role: 'owner', joinedAt: 1, addedBy: 'mallory' } }, keys: { 1: { mallory: wrap } } }; });
    await deny(db('mallory').ref().update({
      'groups/g9/members/zoe': { role: 'member', joinedAt: 1, addedBy: 'mallory' },
      'groups/g9/keys/1/zoe': wrap, 'groups/g9/meta/epoch': 1,
    }));
  });
  it('ALLOW any member pins; DENY member edits others\' messages', async () => {
    await ok(db('erin').ref('groupMessages/g1/gm1/pinned').set(true));
    await deny(db('erin').ref('groupMessages/g1/gm1/ct').set('aGFjaw'));
  });
});

describe('codespaces (F2)', () => {
  it('ALLOW create codespace in one update', async () => {
    await ok(db('dave').ref().update({
      'codespaces/cs2': { meta: { ownerId: 'dave', nameEnc: box, createdAt: Date.now(), template: 'web-basic' },
        members: { dave: { role: 'owner', joinedAt: Date.now(), addedBy: 'dave' } }, keys: { dave: wrap } },
      'userCodespaces/dave/cs2': { addedAt: Date.now() },
    }));
  });
  it('DENY non-member reads codespace / csCollab', async () => {
    await deny(db('mallory').ref('codespaces/cs1').once('value'));
    await deny(db('mallory').ref('csCollab/cs1').once('value'));
  });
  it('ALLOW viewer reads; DENY viewer writes files/updates/snapshots', async () => {
    await ok(db('dave').ref('csCollab/cs1').once('value'));
    await deny(db('dave').ref('csCollab/cs1/updates/f1').push({ iv: box.iv, ct: box.ct, uid: 'dave', ts: TS }));
    await deny(db('dave').ref('csCollab/cs1/files/f2').set({ enc: box, createdBy: 'dave', createdAt: 1 }));
    await deny(db('dave').ref('csCollab/cs1/snapshots/f1').set({ iv: box.iv, ct: box.ct, upTo: 'x', ts: 1 }));
    await deny(db('dave').ref('csCollab/cs1/files/f1').remove());
  });
  it('ALLOW viewer sends own awareness', async () => {
    await ok(db('dave').ref('csCollab/cs1/awareness/f1/dave').set({ iv: box.iv, ct: box.ct, ts: Date.now() }));
  });
  it('ALLOW editor writes updates and files', async () => {
    await ok(db('bob').ref('csCollab/cs1/updates/f1').push({ iv: box.iv, ct: box.ct, uid: 'bob', ts: TS }));
    await ok(db('bob').ref('csCollab/cs1/files/f2').set({ enc: box, createdBy: 'bob', createdAt: 1 }));
  });
  it('DENY viewer/editor self-promotion and editor adding members', async () => {
    await deny(db('dave').ref('codespaces/cs1/members/dave/role').set('editor'));
    await deny(db('bob').ref('codespaces/cs1/members/bob/role').set('owner'));
    await deny(db('bob').ref().update({
      'codespaces/cs1/members/mallory': { role: 'editor', joinedAt: 1, addedBy: 'bob' },
      'codespaces/cs1/keys/mallory': wrap,
    }));
  });
  it('ALLOW owner adds a member', async () => {
    await ok(db('alice').ref().update({
      'codespaces/cs1/members/erin': { role: 'viewer', joinedAt: Date.now(), addedBy: 'alice' },
      'codespaces/cs1/keys/erin': wrap, 'userCodespaces/erin/cs1': { addedAt: Date.now() },
    }));
  });
  it('DENY adding a blocker to my codespace', async () => {
    await deny(db('mallory').ref().update({
      'codespaces/cs3': { meta: { ownerId: 'mallory', nameEnc: box, createdAt: Date.now() },
        members: { mallory: { role: 'owner', joinedAt: 1, addedBy: 'mallory' },
          zoe: { role: 'editor', joinedAt: 1, addedBy: 'mallory' } },
        keys: { mallory: wrap, zoe: wrap } },
    }));
  });
  it('DENY forging a codespace index entry for someone else', async () => {
    await deny(db('mallory').ref('userCodespaces/dave/csX').set({ addedAt: 1 }));
  });
  it('ALLOW owner deletes codespace; DENY editor deletes', async () => {
    await deny(db('bob').ref().update({ 'codespaces/cs1': null, 'csCollab/cs1': null }));
    await ok(db('alice').ref().update({
      'codespaces/cs1': null, 'csCollab/cs1': null,
      'userCodespaces/alice/cs1': null, 'userCodespaces/bob/cs1': null, 'userCodespaces/dave/cs1': null,
    }));
  });
  it('ALLOW editor checkpoint; DENY viewer checkpoint', async () => {
    await ok(db('bob').ref('csCollab/cs1/checkpoints/f1').push({ uid: 'bob', ts: TS, iv: box.iv, ct: box.ct }));
    await deny(db('dave').ref('csCollab/cs1/checkpoints/f1').push({ uid: 'dave', ts: TS, iv: box.iv, ct: box.ct }));
  });
  it('DENY removed member reads after owner removes them', async () => {
    await ok(db('alice').ref().update({ 'codespaces/cs1/members/bob': null, 'codespaces/cs1/keys/bob': null, 'userCodespaces/bob/cs1': null }));
    await deny(db('bob').ref('csCollab/cs1').once('value'));
  });
});

// Notification center: notifs/{uid}/{nid} + notifLog/{from}/{uid} rate limit.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, TS, assertFails as deny, assertSucceeds as ok, seedFriendReq } from './helpers.mjs';

const send = (from, to, nid, kind, ref) =>
  db(from).ref().update({ [`notifs/${to}/${nid}`]: { kind, from, ts: TS, ...(ref ? { ref } : {}) }, [`notifLog/${from}/${to}`]: TS });

before(getEnv); after(cleanup);
beforeEach(() => reset(seedFriendReq));

describe('notifications', () => {
  it('ALLOW dm notif between DM members; DENY wrong dmId, forged from, missing notifLog', async () => {
    await ok(send('dave', 'zoe', 'n1', 'dm', { dmId: 'dave_zoe', mid: 'm1' }));
    await deny(send('erin', 'zoe', 'n2', 'dm', { dmId: 'dave_zoe', mid: 'm1' }));
    await deny(db('erin').ref().update({ 'notifs/zoe/n3': { kind: 'friendReq', from: 'dave', ts: TS }, 'notifLog/erin/zoe': TS }));
    await deny(db('erin').ref('notifs/zoe/n4').set({ kind: 'friendReq', from: 'erin', ts: TS }));
  });
  it('DENY a second send to the same user within 3 s', async () => {
    await ok(send('erin', 'zoe', 'n1', 'friendReq'));
    await deny(send('erin', 'zoe', 'n2', 'friendReq'));
  });
  it('recipient marks read and deletes; cannot edit kind; third party cannot read', async () => {
    await ok(send('erin', 'zoe', 'n1', 'friendReq'));
    await ok(db('zoe').ref('notifs/zoe/n1/read').set(true));
    await deny(db('zoe').ref('notifs/zoe/n1/kind').set('dm'));
    await deny(db('erin').ref('notifs/zoe').once('value'));
    await ok(db('zoe').ref('notifs/zoe/n1').remove());
  });
});

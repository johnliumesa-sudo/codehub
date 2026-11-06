// Extra attack coverage for notifications, media, appConfig, profile, calls (overnight run).
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails as deny, assertSucceeds as ok, putAttMeta, seedFriendReq } from './helpers.mjs';

before(getEnv); after(cleanup);
beforeEach(() => reset(seedFriendReq));
const send = (from, to, nid, kind, ref) =>
  db(from).ref().update({ [`notifs/${to}/${nid}`]: { kind, from, ts: TS, ...(ref ? { ref } : {}) }, [`notifLog/${from}/${to}`]: TS });

describe('notifications (extra)', () => {
  it('DENY blocked sender, self-notify, unauthenticated, announcement by non-admin', async () => {
    await deny(send('mallory', 'zoe', 'n1', 'friendReq'));
    await deny(send('dave', 'dave', 'n2', 'friendReq'));
    await deny(db(null).ref('notifs/zoe/n3').set({ kind: 'friendReq', from: 'dave', ts: TS }));
    await deny(send('dave', 'zoe', 'n4', 'announcement'));
    await ok(send('admin1', 'zoe', 'n5', 'announcement'));
  });
  it('DENY mention for a server the recipient is not in; ALLOW shared server', async () => {
    await deny(send('alice', 'zoe', 'n1', 'mention', { sid: 's1' }));
    await ok(send('alice', 'dave', 'n2', 'mention', { sid: 's1' }));
  });
  it('DENY overwriting an existing notification (forged edit) and deleting someone else\'s', async () => {
    await ok(send('erin', 'zoe', 'n1', 'friendReq'));
    await deny(db('erin').ref('notifs/zoe/n1').remove());
    await deny(db('erin').ref('notifs/zoe/n1').set({ kind: 'friendReq', from: 'erin', ts: TS }));
  });
  it('DENY notifLog forged for another sender or with a stale timestamp', async () => {
    await deny(db('erin').ref('notifLog/dave/zoe').set(TS));
    await deny(db('erin').ref('notifLog/erin/zoe').set(12345));
  });
  it('DENY group call notif by non-member; ALLOW by member', async () => {
    await deny(send('zoe', 'dave', 'n1', 'call', { gid: 'g1' }));
    await ok(send('alice', 'dave', 'n2', 'call', { gid: 'g1' }));
  });
});

describe('media (extra)', () => {
  it('avatar: DENY unauthenticated write, extra field, empty data, fake ts, bad mime gif', async () => {
    await deny(db(null).ref('avatars/dave').set({ data: 'QUJD', mime: 'image/png', ts: TS }));
    await deny(db('dave').ref('avatars/dave').set({ data: 'QUJD', mime: 'image/png', ts: TS, x: 1 }));
    await deny(db('dave').ref('avatars/dave').set({ data: '', mime: 'image/png', ts: TS }));
    await deny(db('dave').ref('avatars/dave').set({ data: 'QUJD', mime: 'image/png', ts: 5 }));
    await deny(db('dave').ref('avatars/dave').set({ data: 'QUJD', mime: 'text/html', ts: TS }));
    await ok(db('dave').ref('avatars/dave').set({ data: 'x'.repeat(65536), mime: 'image/jpeg', ts: TS }));
    await deny(db(null).ref('avatars/dave').get());
    await deny(db('zoe').ref('avatars/dave').remove());
  });
  it('server icon: DENY removing by member, extra key, unauthenticated read', async () => {
    await deny(db('dave').ref('servers/s1/icon').remove());
    await deny(db('bob').ref('servers/s1/icon').set({ ...box, extra: 1 }));
    await deny(db('bob').ref('servers/s1/icon').set({ iv: 'short', ct: box.ct }));
    await ok(db('bob').ref('servers/s1/icon').set(box));
    await deny(db(null).ref('servers/s1/icon').get());
  });
  it('emotes: owner/admin may write; manageEmotes cannot be self-granted by low role; non-owner cannot wipe', async () => {
    const e = (by) => ({ ...box, by, ts: TS });
    await ok(db('alice').ref('emotes/s1/e1').set(e('alice')));
    await deny(db('erin').ref('emotes/s1/e2').set(e('erin')));
    await deny(db('erin').ref('servers/s1/roles/rLow/perms/manageEmotes').set(true));
    await deny(db('bob').ref('emotes/s1/e3').set({ ...e('bob'), ts: 5 }));
    await deny(db('bob').ref('emotes/s1/e3').set({ ...e('bob'), ct: 'x'.repeat(90001) }));
    await deny(db('bob').ref('emotes/s1/e3').set({ ...e('bob'), extra: 1 }));
    await deny(db('bob').ref('emotes/s1').remove());
    await ok(db('alice').ref('emotes/s1').remove());
    await deny(db('mallory').ref('emotes/s1/e9').set(e('mallory')));
  });
  it('manageEmotes role perm: escalation guard (cannot grant a perm you lack), then allowed once held', async () => {
    await deny(db('carol').ref('servers/s1/roles/rLow/perms/manageEmotes').set(true));
    await admin((d) => d.ref('servers/s1/roles/rMod/perms/manageEmotes').set(true));
    await ok(db('carol').ref('servers/s1/roles/rLow/perms/manageEmotes').set(true));
    await deny(db('carol').ref('servers/s1/roles/rLow/perms/bogus').set(true));
    await deny(db('carol').ref('servers/s1/roles/rLow/perms/manageEmotes').set('yes'));
    await deny(db('carol').ref('servers/s1/roles/rHigh/perms/manageEmotes').set(true));
  });
  it('attachments: DENY meta with bad n/size/extra, chunk without meta, chunk by non-uploader, unauthenticated', async () => {
    const m = (extra = {}) => ({ by: 'dave', ts: TS, n: 1, size: 10, iv: box.iv, ct: box.ct, sid: 's1', cid: 'c1', ...extra });
    const S = 'att/ch_s1_c1/b1';
    await deny(db('dave').ref(`${S}/c/0`).set({ iv: box.iv, ct: box.ct }));
    await deny(putAttMeta('dave', `${S}`, m({ n: 0 })));
    await deny(putAttMeta('dave', `${S}`, m({ n: 9999 })));
    await deny(putAttMeta('dave', `${S}`, m({ size: -1 })));
    await deny(putAttMeta('dave', `${S}`, m({ extra: 1 })));
    await deny(putAttMeta('dave', `${S}`, m({ by: 'erin' })));
    await deny(putAttMeta(null, `${S}`, m()));
    await ok(putAttMeta('dave', `${S}`, m()));
    await deny(db('dave').ref(`${S}/c/0`).set({ iv: 'short', ct: box.ct }));
    await deny(db('dave').ref(`${S}/c/0`).set({ ...box, extra: 1 }));
    await deny(db(null).ref(`${S}/meta`).get());
    await deny(db('zoe').ref('att/ch_s1_c1').get());
  });
});

describe('appConfig (extra)', () => {
  it('turn config: admin-only, validated, capped at 4, unknown keys refused', async () => {
    const t = { urls: 'turn:t.example.com:3478', username: 'u', credential: 'p' };
    await ok(db('admin1').ref('appConfig/turn').set({ 0: t, 1: { urls: { 0: 'stun:a' } } }));
    await deny(db('dave').ref('appConfig/turn').set({ 0: t }));
    await deny(db('admin1').ref('appConfig/turn/4').set(t));
    await deny(db('admin1').ref('appConfig/turn/0').set({ username: 'x' }));
    await deny(db('admin1').ref('appConfig/turn/0').set({ ...t, evil: 1 }));
    await deny(db('admin1').ref('appConfig/turn/0').set({ ...t, urls: '' }));
    await deny(db('admin1').ref('appConfig/other').set('x'));
    await deny(db('admin1').ref('appConfig/giphyKey').set('k'.repeat(65)));
    await deny(db(null).ref('appConfig').get());
    await ok(db('dave').ref('appConfig/turn').get());
  });
});

describe('profile (extra)', () => {
  it('owner edits own profile; DENY others, bad link/banner/unknown key/overlong bio', async () => {
    await ok(db('dave').ref('users/dave/profile').set({ bio: 'hi', pronouns: 'he/him', links: { 0: 'https://x.dev' }, banner: '#aabbcc' }));
    await deny(db('erin').ref('users/dave/profile/bio').set('pwn'));
    await deny(db('dave').ref('users/dave/profile/links/0').set('javascript:alert(1)'));
    await deny(db('dave').ref('users/dave/profile/links/3').set('https://x.dev'));
    await deny(db('dave').ref('users/dave/profile/banner').set('red'));
    await deny(db('dave').ref('users/dave/profile/bio').set('x'.repeat(191)));
    await deny(db('dave').ref('users/dave/profile/evil').set('x'));
  });
});

describe('calls (extra)', () => {
  const SID = 'srvAAAAAAAAAAAAAAAAA', VC = 'chVOICEAAAAAAAAAAAAA';
  const slot = (uid, o = {}) => ({ uid, joinedAt: TS, mic: true, cam: false, screen: false, ...o });
  beforeEach(() => admin((d) => d.ref(`servers/${SID}`).set({
    meta: { ownerId: 'alice', nameEnc: box, createdAt: 1 },
    members: { alice: { role: 'owner', joinedAt: 1 }, dave: { role: 'member', joinedAt: 1 } },
    channels: { [VC]: { type: 'voice', enc: box, position: 0 } },
  })));
  it('DENY non-member starting/reading voice call; DENY hijack of a taken slot; DENY non-boolean flags', async () => {
    const meta = { id: 'call12345678', startedBy: 'alice', ts: TS, kind: 'audio' };
    await deny(db('zoe').ref(`vcalls/${SID}/${VC}`).update({ ...meta, startedBy: 'zoe' }));
    await ok(db('alice').ref(`vcalls/${SID}/${VC}`).update(meta));
    await ok(db('alice').ref(`vcalls/${SID}/${VC}/slots/0`).set(slot('alice')));
    await deny(db('dave').ref(`vcalls/${SID}/${VC}/slots/0`).set(slot('dave')));
    await deny(db('dave').ref(`vcalls/${SID}/${VC}/slots/0`).remove());
    await deny(db('dave').ref(`vcalls/${SID}/${VC}/slots/1`).set(slot('dave', { mic: 'yes' })));
    await deny(db('zoe').ref(`vcalls/${SID}/${VC}`).get());
    await deny(db('dave').ref(`vcalls/${SID}/${VC}`).update({ ...meta, startedBy: 'alice', kind: 'bogus' }));
  });
  it('DENY vsignal read by a third party or sender; ALLOW recipient; DENY oversized payload', async () => {
    const sig = { ...box, ts: TS };
    await admin((d) => d.ref(`vcalls/${SID}/${VC}/id`).set('call12345670'));
    await ok(db('dave').ref(`vsignal/${SID}/${VC}/alice/dave`).push(sig));
    await deny(db('dave').ref(`vsignal/${SID}/${VC}/alice`).get());
    await deny(db('zoe').ref(`vsignal/${SID}/${VC}/alice`).get());
    await ok(db('alice').ref(`vsignal/${SID}/${VC}/alice`).get());
    await deny(db('dave').ref(`vsignal/${SID}/${VC}/alice/dave`).push({ ...sig, ct: 'x'.repeat(20001) }));
  });
});

describe('overnight security fixes (round 2)', () => {
  const meta = (by, extra = {}) => ({ by, ts: TS, n: 1, size: 10, iv: box.iv, ct: box.ct, ...extra });
  it('attachments: DENY dm scope without a real DM, meta without attLog, batching two metas on one log, >24 per window', async () => {
    await deny(putAttMeta('mallory', 'att/dm_mallory_nobodyaN/x1', meta('mallory')));
    await deny(db('dave').ref('att/dm_dave_zoe/x2/meta').set(meta('dave')));
    await deny(db('dave').ref().update({
      'att/dm_dave_zoe/x3/meta': meta('dave'), 'att/dm_dave_zoe/x4/meta': meta('dave'),
      'attLog/dave': { ws: TS, n: 1, id: 'x3', at: TS },
    }));
    await deny(putAttMeta('dave', 'att/dm_dave_zoe/x5', meta('dave'), { ws: TS, n: 5, id: 'x5', at: TS }));
    for (let i = 0; i < 24; i++) await ok(putAttMeta('dave', `att/dm_dave_zoe/y${i}`, meta('dave')));
    await deny(putAttMeta('dave', 'att/dm_dave_zoe/y24', meta('dave')));
    await deny(putAttMeta('dave', 'att/dm_dave_zoe/y25', meta('dave'), { ws: TS, n: 1, id: 'y25', at: TS }));
    await admin((d) => d.ref('attLog/dave/ws').set(Date.now() - 700000));
    await ok(putAttMeta('dave', 'att/dm_dave_zoe/y26', meta('dave'), { ws: TS, n: 1, id: 'y26', at: TS }));
    await deny(db('erin').ref('attLog/dave').get());
    await deny(db('dave').ref('attLog/dave').remove());
  });
  it('voice: DENY timed-out member starting a call, taking a slot, or signaling', async () => {
    const SID = 'srvAAAAAAAAAAAAAAAAA', VC = 'chVOICEAAAAAAAAAAAAA';
    const m = { id: 'call12345678', startedBy: 'dave', ts: TS, kind: 'audio' };
    await admin((d) => d.ref(`servers/${SID}`).set({
      meta: { ownerId: 'alice', nameEnc: box, createdAt: 1 },
      members: { alice: { role: 'owner', joinedAt: 1 }, dave: { role: 'member', joinedAt: 1 } },
      channels: { [VC]: { type: 'voice', enc: box, position: 0 } },
    }));
    await admin((d) => d.ref(`servers/${SID}/timeouts/dave`).set(Date.now() + 1e7));
    await deny(db('dave').ref(`vcalls/${SID}/${VC}`).update(m));
    await admin((d) => d.ref(`vcalls/${SID}/${VC}`).update({ ...m, startedBy: 'alice', ts: Date.now() }));
    await deny(db('dave').ref(`vcalls/${SID}/${VC}/slots/1`).set({ uid: 'dave', joinedAt: TS, mic: true, cam: false, screen: false }));
    await deny(db('dave').ref(`vsignal/${SID}/${VC}/alice/dave`).push({ ...box, ts: TS }));
    await admin((d) => d.ref(`servers/${SID}/timeouts/dave`).remove());
    await ok(db('dave').ref(`vsignal/${SID}/${VC}/alice/dave`).push({ ...box, ts: TS }));
  });
  it('notifs: friendReq/gameLike/groupAdd/roleChange must match real data', async () => {
    await deny(send('mallory', 'alice', 'p1', 'gameLike', { gameId: 'evil' }));
    await deny(send('bob', 'dave', 'p2', 'gameLike', { gameId: 'gm1' }));
    await ok(db('bob').ref().update({
      'games/gm1/likes': 1, 'gameLikes/gm1/bob': true,
      'notifs/dave/p3': { kind: 'gameLike', from: 'bob', ts: TS, ref: { gameId: 'gm1' } }, 'notifLog/bob/dave': TS,
    }));
    await deny(send('dave', 'zoe', 'p4', 'friendReq'));
    await deny(send('dave', 'bob', 'p5', 'roleChange', { sid: 's1' }));
    await ok(send('alice', 'carol', 'p6', 'roleChange', { sid: 's1' }));
    await deny(send('alice', 'zoe', 'p7', 'groupAdd', { gid: 'g1' }));
    await ok(send('alice', 'dave', 'p8', 'groupAdd', { gid: 'g1' }));
  });
  it('calls: removed member cannot keep updating a slot; remaining members/owner can clear it', async () => {
    const sl = (uid) => ({ uid, joinedAt: 1, mic: true, cam: false, screen: false });
    await admin((d) => d.ref().update({
      'calls/grp_g1': { id: 'call12345678', startedBy: 'erin', ts: 1, kind: 'audio', slots: { 0: sl('erin'), 1: sl('dave') } },
      'groups/g1/members/erin': null,
    }));
    await deny(db('erin').ref('calls/grp_g1/slots/0/mic').set(false));
    await deny(db('zoe').ref('calls/grp_g1/slots/0').remove());
    await admin((d) => d.ref('calls/grp_g1/slots/2').set(sl('alice')));
    await deny(db('dave').ref('calls/grp_g1/slots/2').remove());
    await ok(db('dave').ref('calls/grp_g1/slots/0').remove());
    await ok(db('alice').ref('calls/grp_g1/slots/1').remove());
  });
});


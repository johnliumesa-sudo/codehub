// Round 3 messaging: self-written reminder notifications (the only rules change), reminders stored in
// udata, and voice messages riding the image attachment rules (size cap, chunks, membership, rate limit).
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails as deny, assertSucceeds as ok, putAttMeta } from './helpers.mjs';

const reminderNotif = (from, ref = { sid: 's1', cid: 'c1', mid: 'm1' }) => ({ kind: 'reminder', from, ts: TS, ref });

describe('messaging (round 3)', () => {
  before(getEnv);
  after(cleanup);
  beforeEach(() => reset());

  describe('reminder notifications (notifs/{me})', () => {
    it('ALLOW writing a reminder notification to my own list, then reading, marking read and deleting it', async () => {
      await ok(db('dave').ref('notifs/dave/n1').set(reminderNotif('dave')));
      await ok(db('dave').ref('notifs/dave/n2').set(reminderNotif('dave', { dmId: 'dave_zoe', mid: 'm9' })));
      await ok(db('dave').ref('notifs/dave/n3').set(reminderNotif('dave', { gid: 'g1' })));
      await ok(db('dave').ref('notifs/dave/n4').set({ kind: 'reminder', from: 'dave', ts: TS }));
      await ok(db('dave').ref('notifs/dave').once('value'));
      await ok(db('dave').ref('notifs/dave/n1/read').set(true));
      await ok(db('dave').ref('notifs/dave/n1').remove());
    });

    it('DENY reminder notifications to someone else, other kinds to myself, or a forged sender', async () => {
      // Another user's list, even with the per-pair stamp other kinds need.
      await deny(db('erin').ref().update({ 'notifs/dave/n1': reminderNotif('erin'), 'notifLog/erin/dave': TS }));
      await deny(db('erin').ref('notifs/dave/n1').set(reminderNotif('erin')));
      await deny(db('erin').ref('notifs/dave/n1').set(reminderNotif('dave')));
      // Self-notifications of any other kind.
      for (const kind of ['mention', 'reply', 'dm', 'call', 'announcement', 'groupAdd']) {
        await deny(db('dave').ref('notifs/dave/x').set({ kind, from: 'dave', ts: TS, ref: { sid: 's1', cid: 'c1' } }));
      }
      // Sender must be me; time must be server now; ref keys are the known ones only.
      await deny(db('dave').ref('notifs/dave/n1').set(reminderNotif('erin')));
      await deny(db('dave').ref('notifs/dave/n1').set({ kind: 'reminder', from: 'dave', ts: 5 }));
      await deny(db('dave').ref('notifs/dave/n1').set({ kind: 'reminder', from: 'dave', ts: TS, ref: { note: 'hi' } }));
      await deny(db('dave').ref('notifs/dave/n1').set({ kind: 'reminder', from: 'dave', ts: TS, text: 'secret' }));
      await deny(db(null).ref('notifs/dave/n1').set(reminderNotif('dave')));
    });

    it('DENY rewriting an existing notification and reading someone else\'s', async () => {
      await ok(db('dave').ref('notifs/dave/n1').set(reminderNotif('dave')));
      await deny(db('dave').ref('notifs/dave/n1').set(reminderNotif('dave', { dmId: 'dave_zoe' })));
      await deny(db('dave').ref('notifs/dave/n1/kind').set('mention'));
      await deny(db('erin').ref('notifs/dave').once('value'));
    });
  });

  describe('reminders (udata/{me}/reminders)', () => {
    it('ALLOW the owner to store a sealed reminder, set fired/done and delete it; DENY everyone else', async () => {
      const R = 'udata/dave/reminders/r1';
      await ok(db('dave').ref(R).set({ iv: box.iv, ct: box.ct }));
      await ok(db('dave').ref(`${R}/fired`).set(Date.now()));
      await ok(db('dave').ref(R).update({ done: Date.now() }));
      await ok(db('dave').ref(R).update({ iv: box.iv, ct: 'c2VhbGVk', fired: null, done: null }));
      await ok(db('dave').ref('udata/dave/reminders').once('value'));
      await deny(db('erin').ref('udata/dave/reminders').once('value'));
      await deny(db('erin').ref(R).set({ iv: box.iv, ct: box.ct }));
      await deny(db('erin').ref(`${R}/fired`).set(1));
      await deny(db('dave').ref(R).set({ iv: box.iv, ct: 'x'.repeat(20001) }));
      await deny(db('dave').ref(R).set({ iv: box.iv, ct: box.ct, nested: { no: 1 } }));
      await ok(db('dave').ref(R).remove());
    });
  });

  describe('voice messages (att/{scope}/{attId}, same rules as images)', () => {
    const meta = (by, extra = {}) => ({ by, ts: TS, n: 8, size: 512 * 1024, iv: box.iv, ct: box.ct, ...extra });
    const chunk = { iv: box.iv, ct: 'x'.repeat(98688) }; // 74,000 bytes encrypted + tag, base64url

    it('ALLOW a 512 KB clip in 8 chunks in a channel, DM and group; members read it', async () => {
      const S = 'att/ch_s1_c1/v1';
      await ok(putAttMeta('dave', S, meta('dave', { sid: 's1', cid: 'c1' })));
      for (let i = 0; i < 8; i++) await ok(db('dave').ref(`${S}/c/${i}`).set(chunk));
      await ok(db('erin').ref(S).once('value'));
      await deny(db('zoe').ref(S).once('value'));

      await ok(putAttMeta('dave', 'att/dm_dave_zoe/v2', meta('dave')));
      await ok(db('dave').ref('att/dm_dave_zoe/v2/c/0').set(chunk));
      await ok(db('zoe').ref('att/dm_dave_zoe/v2').once('value'));
      await deny(db('erin').ref('att/dm_dave_zoe/v2').once('value'));

      await ok(putAttMeta('dave', 'att/grp_g1/v3', meta('dave', { gid: 'g1', epoch: 1 })));
      await ok(db('erin').ref('att/grp_g1/v3/meta').once('value'));
    });

    it('DENY a ninth chunk, oversize chunks or metadata, non-members, and timed-out members', async () => {
      const S = 'att/ch_s1_c1/v1';
      await ok(putAttMeta('dave', S, meta('dave', { sid: 's1', cid: 'c1' })));
      await deny(db('dave').ref(`${S}/c/8`).set(chunk));
      await deny(db('dave').ref(`${S}/c/0`).set({ iv: box.iv, ct: 'x'.repeat(100001) }));
      await deny(putAttMeta('dave', 'att/ch_s1_c1/v2', meta('dave', { sid: 's1', cid: 'c1', n: 9 })));
      await deny(putAttMeta('dave', 'att/ch_s1_c1/v3', meta('dave', { sid: 's1', cid: 'c1', size: 600001 })));
      await deny(putAttMeta('zoe', 'att/ch_s1_c1/v4', meta('zoe', { sid: 's1', cid: 'c1' })));
      await admin((d) => d.ref('servers/s1/timeouts/dave').set(Date.now() + 60_000));
      await deny(putAttMeta('dave', 'att/ch_s1_c1/v5', meta('dave', { sid: 's1', cid: 'c1' })));
    });

    it('DENY uploads past the shared limit of 24 attachments per 10 minutes', async () => {
      await admin((d) => d.ref('attLog/dave').set({ ws: Date.now() - 1000, n: 24, id: 'old', at: Date.now() - 1000 }));
      await deny(putAttMeta('dave', 'att/dm_dave_zoe/v9', meta('dave')));
      await ok(db('dave').ref('udata/dave/reminders/r1').set({ iv: box.iv, ct: box.ct })); // unrelated writes still work
    });
  });
});

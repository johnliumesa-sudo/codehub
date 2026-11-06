import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails as deny, assertSucceeds as ok } from "./helpers.mjs";
before(getEnv); after(cleanup);
beforeEach(() => reset());
const meta = (by, extra = {}) => ({ by, ts: TS, n: 1, size: 10, iv: box.iv, ct: box.ct, ...extra });
const chunk = { iv: box.iv, ct: box.ct };
describe('media', () => {
  it('avatars', async () => {
    await ok(db('dave').ref('avatars/dave').set({ data: 'QUJD', mime: 'image/webp', ts: TS }));
    await deny(db('dave').ref('avatars/erin').set({ data: 'QUJD', mime: 'image/webp', ts: TS }));
    await deny(db('dave').ref('avatars/dave').set({ data: 'QUJD', mime: 'image/svg+xml', ts: TS }));
    await deny(db('dave').ref('avatars/dave').set({ data: 'x'.repeat(65537), mime: 'image/png', ts: TS }));
    await ok(db('zoe').ref('avatars/dave').once('value'));
    await ok(db('dave').ref('avatars/dave').remove());
  });
  it('server icon', async () => {
    await ok(db('bob').ref('servers/s1/icon').set(box));
    await deny(db('dave').ref('servers/s1/icon').set(box));
    await deny(db('bob').ref('servers/s1/icon').set({ ...box, ct: 'x'.repeat(90001) }));
    await ok(db('dave').ref('servers/s1/icon').once('value'));
  });
  it('emotes', async () => {
    const e = (by) => ({ ...box, by, ts: TS });
    await ok(db('bob').ref('emotes/s1/e1').set(e('bob')));
    await deny(db('dave').ref('emotes/s1/e2').set(e('dave')));
    await deny(db('bob').ref('emotes/s1/e3').set(e('alice')));
    await admin((d) => d.ref('servers/s1/roles/rLow/perms/manageEmotes').set(true));
    await ok(db('erin').ref('emotes/s1/e4').set(e('erin')));
    await ok(db('erin').ref('emotes/s1/e1').remove());
    await ok(db('dave').ref('emotes/s1').once('value'));
    await deny(db('zoe').ref('emotes/s1').once('value'));
  });
  it('attachments channel', async () => {
    const S = 'att/ch_s1_c1/a1';
    await deny(db('zoe').ref(`${S}/meta`).set(meta('zoe', { sid: 's1', cid: 'c1' })));
    await deny(db('dave').ref(`${S}/meta`).set(meta('dave', { sid: 's1', cid: 'c9' })));
    await deny(db('dave').ref(`${S}/c/0`).set(chunk));
    await ok(db('dave').ref(`${S}/meta`).set(meta('dave', { sid: 's1', cid: 'c1' })));
    await deny(db('dave').ref(`${S}/meta`).set(meta('dave', { sid: 's1', cid: 'c1' })));
    await ok(db('dave').ref(`${S}/c/0`).set(chunk));
    await deny(db('erin').ref(`${S}/c/1`).set(chunk));
    await deny(db('dave').ref(`${S}/c/8`).set(chunk));
    await deny(db('dave').ref(`${S}/c/1`).set({ iv: box.iv, ct: 'x'.repeat(100001) }));
    await ok(db('erin').ref(`${S}/c/0`).once('value'));
    await deny(db('zoe').ref(`${S}/meta`).once('value'));
    await deny(db('erin').ref(S).remove());
    await ok(db('carol').ref('att/ch_s1_c1').update({ a1: null }));
  });
  it('attachments dm + group', async () => {
    await ok(db('dave').ref('att/dm_dave_zoe/a1/meta').set(meta('dave')));
    await deny(db('erin').ref('att/dm_dave_zoe/a2/meta').set(meta('erin')));
    await ok(db('zoe').ref('att/dm_dave_zoe/a1/meta').once('value'));
    await deny(db('erin').ref('att/dm_dave_zoe/a1/meta').once('value'));
    await deny(db('zoe').ref('att/dm_dave_zoe/a1').remove());
    await ok(db('dave').ref('att/dm_dave_zoe/a1').remove());
    await deny(db('dave').ref('att/grp_g1/a1/meta').set(meta('dave', { gid: 'g1' })));
    await deny(db('dave').ref('att/grp_g1/a1/meta').set(meta('dave', { gid: 'g1', epoch: 2 })));
    await deny(db('zoe').ref('att/grp_g1/a1/meta').set(meta('zoe', { gid: 'g1', epoch: 1 })));
    await ok(db('dave').ref('att/grp_g1/a1/meta').set(meta('dave', { gid: 'g1', epoch: 1 })));
    await ok(db('erin').ref('att/grp_g1/a1/meta').once('value'));
    await ok(db('alice').ref('att/grp_g1/a1').remove());
  });
  it('appConfig', async () => {
    await ok(db('admin1').ref('appConfig/giphyKey').set('abc'));
    await deny(db('dave').ref('appConfig/giphyKey').set('abc'));
    await ok(db('dave').ref('appConfig/giphyKey').once('value'));
  });
});

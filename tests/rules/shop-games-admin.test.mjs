import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, TS, PROMO, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);
beforeEach(() => reset());

describe('shop (F3)', () => {
  it('ALLOW first claim creates wallet with 100', async () => {
    await ok(db('newbie').ref('wallets/newbie').set({ balance: 100, lastClaim: TS }));
  });
  it('DENY first claim with forged balance', async () => {
    await deny(db('newbie').ref('wallets/newbie').set({ balance: 100000, lastClaim: TS }));
  });
  it('DENY balance forgery on existing wallet', async () => {
    await deny(db('dave').ref('wallets/dave/balance').set(9999));
    await deny(db('dave').ref('wallets/dave').set({ balance: 9999, lastClaim: TS }));
  });
  it('DENY claim before 20h', async () => {
    await deny(db('dave').ref('wallets/dave').update({ balance: 200, lastClaim: TS }));
  });
  it('ALLOW claim after 20h', async () => {
    await ok(db('erin').ref('wallets/erin').update({ balance: 120, lastClaim: TS }));
  });
  it('DENY deleting wallet (to re-claim the 100 starter)', async () => {
    await deny(db('dave').ref('wallets/dave').remove());
  });
  const buy = (uid, item, newBal, price) => ({
    [`wallets/${uid}/balance`]: newBal, [`wallets/${uid}/lastItem`]: item,
    [`inventory/${uid}/${item}`]: { at: TS, price },
  });
  it('ALLOW purchase in one update', async () => { await ok(db('dave').ref().update(buy('dave', 'itemA', 50, 50))); });
  it('DENY purchase paying less than price', async () => {
    await deny(db('dave').ref().update(buy('dave', 'itemA', 90, 10)));
    await deny(db('dave').ref().update(buy('dave', 'itemA', 100, 50)));
  });
  it('DENY inventory grant without paying', async () => {
    await deny(db('dave').ref('inventory/dave/itemA').set({ at: TS, price: 50 }));
  });
  it('DENY purchase that would go negative', async () => {
    await deny(db('dave').ref().update(buy('dave', 'itemBig', -4900, 5000)));
  });
  it('DENY purchase of inactive item', async () => { await deny(db('dave').ref().update(buy('dave', 'itemOff', 90, 10))); });
  it('DENY buying an item already owned', async () => { await deny(db('erin').ref().update(buy('erin', 'itemA', 0, 50))); });
  it('ALLOW free item without wallet change', async () => {
    await ok(db('newbie').ref('inventory/newbie/itemFree').set({ at: TS, price: 0 }));
  });
  it('DENY inventory delete / other user wallet read', async () => {
    await deny(db('erin').ref('inventory/erin/itemA').remove());
    await deny(db('mallory').ref('wallets/dave').once('value'));
    await deny(db('mallory').ref('inventory/erin').once('value'));
  });
  it('ALLOW equip owned item; DENY equip unowned / wrong kind', async () => {
    await ok(db('erin').ref('equipped/erin/badge').set('itemA'));
    await deny(db('erin').ref('equipped/erin/badge').set('itemBig'));
    await deny(db('erin').ref('equipped/erin/theme').set('itemA'));
  });
  it('DENY non-admin edits catalog; ALLOW app admin', async () => {
    const item = { name: 'X', desc: '', kind: 'badge', price: 0, data: { glyph: 'x' }, active: true, updatedAt: TS };
    await deny(db('dave').ref('shop/items/itemX').set({ ...item, updatedBy: 'dave' }));
    await deny(db('dave').ref('shop/items/itemBig/price').set(0));
    await ok(db('admin1').ref('shop/items/itemX').set({ ...item, updatedBy: 'admin1' }));
  });
});

describe('games (F4)', () => {
  const game = (owner, extra = {}) => ({ ownerId: owner, title: 'T', desc: '', createdAt: TS, updatedAt: TS, likes: 0, size: 5, ...extra });
  it('ALLOW publish game (games + gameCode + publishLog)', async () => {
    await ok(db('mallory').ref().update({
      'games/gX': game('mallory'), 'gameCode/gX': { html: '<b>x</b>' }, 'publishLog/mallory': TS,
    }));
  });
  it('DENY publish within 60s of last publish', async () => {
    await deny(db('erin').ref().update({ 'games/gX': game('erin'), 'gameCode/gX': { html: 'x' }, 'publishLog/erin': TS }));
  });
  it('DENY publish without publishLog / with preset likes / claiming another owner', async () => {
    await deny(db('mallory').ref().update({ 'games/gX': game('mallory'), 'gameCode/gX': { html: 'x' } }));
    await deny(db('mallory').ref().update({ 'games/gX': game('mallory', { likes: 99 }), 'gameCode/gX': { html: 'x' }, 'publishLog/mallory': TS }));
    await deny(db('mallory').ref().update({ 'games/gX': game('dave'), 'gameCode/gX': { html: 'x' }, 'publishLog/mallory': TS }));
  });
  it('ALLOW owner updates game', async () => {
    await ok(db('dave').ref().update({
      'games/gm1': game('dave', { createdAt: 1, title: 'Pong 2' }), 'gameCode/gm1': { html: '<i>v2</i>' }, 'publishLog/dave': TS,
    }));
  });
  it('DENY non-owner edits game metadata or code', async () => {
    await deny(db('mallory').ref().update({
      'games/gm1': game('dave', { createdAt: 1, title: 'pwned' }), 'gameCode/gm1': { html: 'evil' }, 'publishLog/mallory': TS,
    }));
    await deny(db('mallory').ref().update({ 'gameCode/gm1': { html: 'evil' }, 'publishLog/mallory': TS }));
    await deny(db('mallory').ref('games/gm1/title').set('pwned'));
  });
  it('DENY non-owner non-admin unpublishes', async () => {
    await deny(db('mallory').ref().update({ 'games/gm1': null, 'gameCode/gm1': null, 'gameLikes/gm1': null }));
  });
  it('ALLOW app admin unpublishes', async () => {
    await ok(db('admin1').ref().update({ 'games/gm1': null, 'gameCode/gm1': null, 'gameLikes/gm1': null }));
  });
  it('ALLOW owner unpublishes', async () => {
    await ok(db('dave').ref().update({ 'games/gm1': null, 'gameCode/gm1': null, 'gameLikes/gm1': null }));
  });
  it('ALLOW like (+1 with entry) and unlike', async () => {
    await ok(db('mallory').ref().update({ 'games/gm1/likes': 1, 'gameLikes/gm1/mallory': true }));
    await ok(db('mallory').ref().update({ 'games/gm1/likes': 0, 'gameLikes/gm1/mallory': null }));
  });
  it('DENY like inflation / double like / like for someone else', async () => {
    await deny(db('mallory').ref().update({ 'games/gm1/likes': 5, 'gameLikes/gm1/mallory': true }));
    await deny(db('mallory').ref('games/gm1/likes').set(1));
    await deny(db('mallory').ref().update({ 'games/gm1/likes': 1, 'gameLikes/gm1/zoe': true }));
    await ok(db('mallory').ref().update({ 'games/gm1/likes': 1, 'gameLikes/gm1/mallory': true }));
    await deny(db('mallory').ref().update({ 'games/gm1/likes': 2, 'gameLikes/gm1/mallory': true }));
  });
  it('ALLOW signed-in read of games; DENY unauthenticated', async () => {
    await ok(db('mallory').ref('games').once('value'));
    await ok(db('mallory').ref('gameCode/gm1').once('value'));
    await deny(db(null).ref('games').once('value'));
  });
});

describe('app admin promo (F6)', () => {
  it('DENY reading config / adminPromo by anyone (incl. admin)', async () => {
    await deny(db('mallory').ref('config').once('value'));
    await deny(db('mallory').ref('config/adminPromo').once('value'));
    await deny(db('admin1').ref('config/adminPromo').once('value'));
  });
  it('DENY writing config', async () => {
    await deny(db('mallory').ref('config/adminPromo').set('mine-mine-mine'));
    await deny(db('admin1').ref('config/adminPromo').set('mine-mine-mine'));
  });
  it('DENY wrong promo code', async () => {
    await ok(db('mallory').ref('promoAttempts/mallory').set({ code: 'wrong-code-123', at: TS }));
    await deny(db('mallory').ref().update({ 'admins/mallory': { at: TS }, 'adminBadges/mallory': true }));
  });
  it('ALLOW correct promo code', async () => {
    await ok(db('mallory').ref('promoAttempts/mallory').set({ code: PROMO, at: TS }));
    await ok(db('mallory').ref().update({ 'admins/mallory': { at: TS }, 'adminBadges/mallory': true }));
  });
  it('DENY admin without any attempt / in same update as attempt', async () => {
    await deny(db('mallory').ref('admins/mallory').set({ at: TS }));
    await deny(db('mallory').ref().update({ 'promoAttempts/mallory': { code: PROMO, at: TS }, 'admins/mallory': { at: TS } }));
  });
  it('DENY stale (>2 min) correct attempt', async () => {
    await reset((w) => { w.promoAttempts = { mallory: { code: PROMO, at: Date.now() - 200000 } }; });
    await deny(db('mallory').ref('admins/mallory').set({ at: TS }));
  });
  it('DENY second guess within 30 s', async () => {
    await ok(db('mallory').ref('promoAttempts/mallory').set({ code: 'guess-one-111', at: TS }));
    await deny(db('mallory').ref('promoAttempts/mallory').set({ code: 'guess-two-222', at: TS }));
  });
  it('DENY reading promoAttempts', async () => {
    await deny(db('mallory').ref('promoAttempts/mallory').once('value'));
  });
  it('DENY granting admin to someone else', async () => {
    await deny(db('admin1').ref('admins/mallory').set({ at: TS }));
  });
  it('ALLOW self reads admins/self; DENY others / list', async () => {
    await ok(db('admin1').ref('admins/admin1').once('value'));
    await deny(db('mallory').ref('admins/admin1').once('value'));
    await deny(db('mallory').ref('admins').once('value'));
    await deny(db('admin1').ref('admins').once('value'));
  });
  it('DENY non-admin sets adminBadge', async () => {
    await deny(db('mallory').ref('adminBadges/mallory').set(true));
  });
  it('DENY admin reading E2EE paths', async () => {
    await deny(db('admin1').ref('servers/s1').once('value'));
    await deny(db('admin1').ref('messages/s1/c1').once('value'));
    await deny(db('admin1').ref('groups/g1').once('value'));
    await deny(db('admin1').ref('codespaces/cs1').once('value'));
    await deny(db('admin1').ref('vaults/dave').once('value'));
    await deny(db('admin1').ref('snippets/dave').once('value'));
    await deny(db('admin1').ref('dmMessages/dave_zoe').once('value'));
  });
});

describe('reports & announcements (F16, F17)', () => {
  it('ALLOW filing a report with reportLog', async () => {
    await ok(db('mallory').ref().update({
      'reports/rX': { by: 'mallory', kind: 'game', target: 'gm1', reason: 'malware', ts: TS }, 'reportLog/mallory': TS,
    }));
  });
  it('DENY report without reportLog / forged reporter', async () => {
    await deny(db('mallory').ref('reports/rX').set({ by: 'mallory', kind: 'game', target: 'gm1', reason: 'spam', ts: TS }));
    await deny(db('mallory').ref().update({
      'reports/rX': { by: 'dave', kind: 'game', target: 'gm1', reason: 'spam', ts: TS }, 'reportLog/mallory': TS,
    }));
  });
  it('DENY non-admin reads/deletes reports; ALLOW admin', async () => {
    await deny(db('dave').ref('reports').once('value'));
    await deny(db('dave').ref('reports/r1').remove());
    await ok(db('admin1').ref('reports').once('value'));
    await ok(db('admin1').ref('reports/r1').remove());
  });
  it('ALLOW admin announcement; DENY non-admin', async () => {
    await ok(db('admin1').ref('announcements/current').set({ text: 'maint', level: 'warn', ts: TS, by: 'admin1' }));
    await deny(db('dave').ref('announcements/current').set({ text: 'fake', level: 'warn', ts: TS, by: 'dave' }));
    await ok(db('dave').ref('announcements/current').once('value'));
  });
});

describe('safety & private prefs (F11, F12, F19, F20)', () => {
  it('DENY blocked user DMs the blocker; ALLOW unblocked user', async () => {
    await deny(db('mallory').ref('dmMessages/mallory_zoe').push({ uid: 'mallory', ts: TS, iv: box.iv, ct: box.ct }));
    await ok(db('dave').ref('dmMessages/dave_zoe').push({ uid: 'dave', ts: TS, iv: box.iv, ct: box.ct }));
  });
  it('DENY blocked user writes blocker\'s userDms / friend request', async () => {
    await deny(db('mallory').ref('userDms/zoe/mallory_zoe').set({ peer: 'mallory', lastTs: 1 }));
    await deny(db('mallory').ref().update({
      'friends/mallory/zoe': { state: 'out', ts: TS }, 'friends/zoe/mallory': { state: 'in', ts: TS },
    }));
  });
  it('DENY reading others\' blocks / verified / notifPrefs / snippets', async () => {
    await deny(db('mallory').ref('blocks/zoe').once('value'));
    await deny(db('mallory').ref('verified/dave').once('value'));
    await deny(db('mallory').ref('notifPrefs/dave').once('value'));
    await deny(db('mallory').ref('snippets/dave').once('value'));
  });
  it('DENY unblocking on someone else\'s behalf', async () => {
    await deny(db('mallory').ref('blocks/zoe/mallory').remove());
  });
  it('ALLOW own block / verify / prefs / snippet writes', async () => {
    await ok(db('dave').ref('blocks/dave/mallory').set(true));
    await ok(db('dave').ref('verified/dave/zoe').set({ fp: 'f00', ts: Date.now() }));
    await ok(db('dave').ref('notifPrefs/dave/scopes/srv_s1').set({ level: 'none' }));
    await ok(db('dave').ref('snippets/dave/sn2').set({ ts: Date.now(), iv: box.iv, ct: box.ct }));
  });
});

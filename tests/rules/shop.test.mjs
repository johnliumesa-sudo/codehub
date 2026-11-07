// Round 3 shop workstream: community items (creators), earnings without minting, collecting.
// Every allow/deny case of the economy rules has a test here; the admin-only catalog, wallet claims
// and plain purchases keep their tests in shop-games-admin.test.mjs.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getEnv, cleanup, reset, db, admin, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds;
const deny = assertFails;

// Community items: `by` = creator, push-key ids (start with '-'). Admin items (no `by`) come from helpers.world().
const comm = (by, extra = {}) => ({
  name: 'Comm', desc: 'made by a user', kind: 'badge', price: 30, data: { glyph: 'C' }, active: true,
  updatedAt: 1, updatedBy: by, by, createdAt: 1, ...extra,
});

function patch(w) {
  const now = Date.now();
  Object.assign(w.shop.items, {
    '-cBadge': comm('carol'),
    '-cFree': comm('carol', { price: 0, kind: 'nameColor', data: { color: '#00ff00' } }),
    '-cOff': comm('carol', { active: false }), // deactivated by carol herself
    '-cHeld': comm('carol', { active: false, updatedBy: 'admin1' }), // deactivated by an app admin
    '-cOld': comm('carol', { price: 25 }),
    '-xy': comm('carol', { price: 40 }),
    '-dItem': comm('dave', { price: 20 }),
  });
  w.wallets.carol = { balance: 10, lastClaim: now - 1000 };
  w.wallets.dave.lastItem = 'itemA'; // dave bought something earlier (purchase branch must not get in the way)
  w.inventory.erin['-cOld'] = { at: 1, price: 25 };
  w.inventory.dave = { itemA: { at: 1, price: 50 } };
  w.earnings = {
    carol: {
      'erin_-cOld': { price: 25, ts: 1 },
      'zoe_-cBadge': { price: 30, ts: 2 },
    },
  };
  w.publishLog.carol = now - 120000;
  w.publishLog.zoe = now - 120000;
}

before(getEnv);
after(cleanup);
beforeEach(() => reset(patch));

const NEW = { name: 'New badge', desc: '', kind: 'badge', price: 15, data: { glyph: '🦊' }, active: true };
/** The creation update: item + publishLog/{me} = now + udata/{me}/shop/last = id. */
const create = (uid, id, item = {}, extra = {}) => ({
  [`shop/items/${id}`]: { ...NEW, updatedAt: TS, updatedBy: uid, by: uid, createdAt: TS, ...item },
  [`publishLog/${uid}`]: TS,
  [`udata/${uid}/shop/last`]: id,
  ...extra,
});
const edit = (uid, fields) => ({ ...fields, updatedAt: TS, updatedBy: uid });
const PALETTE = {
  bg: '#101418', fg: '#e0e6ee', sel: '#2a3a55', caret: '#ffcc00', kw: '#c678dd', str: '#98c379',
  cmt: '#7d8799', num: '#d19a66', fn: '#61afef', type: '#e5c07b', op: '#56b6c2',
};

/** dave buys `item` (catalog price `price`) from `creator`: wallet + inventory + earning in ONE update. */
const purchase = (uid, item, price, balance, creator, extra = {}) => ({
  [`wallets/${uid}/balance`]: balance - price,
  [`wallets/${uid}/lastItem`]: item,
  [`inventory/${uid}/${item}`]: { at: TS, price },
  ...(creator ? { [`earnings/${creator}/${uid}_${item}`]: { price, ts: TS } } : {}),
  ...extra,
});
/** carol collects one entry. */
const collect = (uid, key, balance, price, extra = {}) => ({
  [`wallets/${uid}/balance`]: balance + price,
  [`wallets/${uid}/lastEarn`]: key,
  [`earnings/${uid}/${key}`]: null,
  ...extra,
});
async function val(path) {
  let v;
  await admin(async (d) => { v = (await d.ref(path).get()).val(); });
  return v;
}

describe('shop community items: create', () => {
  it('ALLOW any signed-in user to create a badge, theme, name color and token editor theme', async () => {
    await ok(db('zoe').ref().update(create('zoe', '-z1')));
    assert.equal((await val('shop/items/-z1')).by, 'zoe');
    await reset(patch);
    await ok(db('zoe').ref().update(create('zoe', '-z2', { kind: 'theme', data: { tokens: { bg0: '#000000', text: '#ffffff' } } })));
    await reset(patch);
    await ok(db('zoe').ref().update(create('zoe', '-z3', { kind: 'nameColor', data: { color: '#ff00aa' } })));
    await reset(patch);
    await ok(db('zoe').ref().update(create('zoe', '-z4', { kind: 'editorTheme', data: { tokens: PALETTE } })));
  });
  it('DENY creating within 60 s of the last publish (shared publishLog window)', async () => {
    await deny(db('erin').ref().update(create('erin', '-e1')));
    await ok(db('zoe').ref().update(create('zoe', '-z1')));
    await deny(db('zoe').ref().update(create('zoe', '-z2'))); // second item a moment later
  });
  it('DENY creating without stamping publishLog, or without binding the id in udata', async () => {
    const u = create('zoe', '-z1');
    delete u['publishLog/zoe'];
    await deny(db('zoe').ref().update(u));
    const v = create('zoe', '-z1');
    delete v['udata/zoe/shop/last'];
    await deny(db('zoe').ref().update(v));
    await deny(db('zoe').ref().update(create('zoe', '-z1', {}, { 'udata/zoe/shop/last': '-other' })));
  });
  it('DENY two items in one update (only the id bound in udata may be created)', async () => {
    const u = create('zoe', '-z1');
    u['shop/items/-z2'] = u['shop/items/-z1'];
    await deny(db('zoe').ref().update(u));
  });
  it('DENY creating an item for someone else, without `by`, or with a forged createdAt', async () => {
    await deny(db('zoe').ref().update(create('zoe', '-z1', { by: 'dave' })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { by: null })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { createdAt: 5 })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { updatedBy: 'dave' })));
  });
  it('DENY non-admins creating bundled-module items (editorExt, builtinId editor themes)', async () => {
    await deny(db('zoe').ref().update(create('zoe', '-z1', { kind: 'editorExt', data: { builtinId: 'line-wrap' } })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { kind: 'editorTheme', data: { builtinId: 'one-dark' } })));
  });
  it('DENY ids that are not push keys (squatting the bundled catalog ids)', async () => {
    await deny(db('zoe').ref().update(create('zoe', 'theme-aurora')));
  });
  it('DENY malformed items: price out of range, kind/data mismatch, bad colors, unknown token keys', async () => {
    for (const price of [10001, -1, 1.5]) await deny(db('zoe').ref().update(create('zoe', '-z1', { price })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { kind: 'badge', data: { tokens: { bg0: '#000000' } } })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { kind: 'theme', data: { tokens: { bg0: 'red' } } })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { kind: 'editorTheme', data: { tokens: { ...PALETTE, url: '#000000' } } })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { extra: 'x' })));
    await deny(db('zoe').ref().update(create('zoe', '-z1', { held: true })));
  });
  it('DENY signed-out writes', async () => {
    await deny(db(null).ref('shop/items/-z1').set({ ...NEW, updatedAt: TS, updatedBy: 'x', by: 'x', createdAt: TS }));
  });
});

describe('shop community items: edit and delete', () => {
  it('ALLOW the creator to edit name, desc, data, price and active (by/createdAt untouched)', async () => {
    await ok(db('carol').ref('shop/items/-cBadge').update(edit('carol', { name: 'Renamed', desc: 'd', price: 10000, data: { glyph: 'Z' }, active: false })));
    await ok(db('carol').ref('shop/items/-cBadge').update(edit('carol', { active: true, price: 0 })));
    const item = await val('shop/items/-cBadge');
    assert.equal(item.by, 'carol');
    assert.equal(item.createdAt, 1);
  });
  it('ALLOW the creator to re-activate an item they deactivated themselves', async () => {
    await ok(db('carol').ref('shop/items/-cOff').update(edit('carol', { active: true })));
  });
  it('DENY anyone else editing or deleting a creator\'s item', async () => {
    await deny(db('dave').ref('shop/items/-cBadge').update(edit('dave', { price: 0 })));
    await deny(db('dave').ref('shop/items/-cBadge/price').set(0));
    await deny(db('dave').ref('shop/items/-cBadge').remove());
    await deny(db('dave').ref('shop/items/-cBadge').set(comm('dave')));
  });
  it('DENY changing or removing `by`, and changing createdAt', async () => {
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { by: 'dave' })));
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { by: null })));
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { createdAt: TS })));
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { createdAt: 99 })));
  });
  it('DENY a creator switching an item to a bundled module or an out-of-range price', async () => {
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { kind: 'editorExt', data: { builtinId: 'line-wrap' } })));
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { price: 10001 })));
  });
  it('DENY editing an admin item (no `by`) as a non-admin', async () => {
    await deny(db('carol').ref('shop/items/itemA').update(edit('carol', { price: 1 })));
    await deny(db('carol').ref('shop/items/itemA').update(edit('carol', { by: 'carol' })));
  });
  it('ALLOW the creator to delete their own item', async () => {
    await ok(db('carol').ref('shop/items/-cBadge').remove());
  });
});

describe('shop community items: app admins', () => {
  it('ALLOW an admin to deactivate any item; the creator cannot re-activate or edit it, only delete it', async () => {
    await ok(db('admin1').ref('shop/items/-cBadge').update(edit('admin1', { active: false })));
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { active: true })));
    await deny(db('carol').ref('shop/items/-cBadge').update(edit('carol', { name: 'sneaky' })));
    await deny(db('carol').ref('shop/items/-cHeld').update(edit('carol', { active: true })));
    await ok(db('carol').ref('shop/items/-cHeld').remove());
  });
  it('ALLOW an admin to re-activate it, after which the creator may edit again', async () => {
    await ok(db('admin1').ref('shop/items/-cHeld').update(edit('admin1', { active: true })));
    await ok(db('carol').ref('shop/items/-cHeld').update(edit('carol', { name: 'Back' })));
  });
  it('ALLOW an admin to delete any item', async () => {
    await ok(db('admin1').ref('shop/items/-cBadge').remove());
  });
  it('DENY even an admin changing `by` or adding one to an admin item', async () => {
    await deny(db('admin1').ref('shop/items/-cBadge').update(edit('admin1', { by: 'admin1' })));
    await deny(db('admin1').ref('shop/items/-cBadge').update(edit('admin1', { by: null })));
    await deny(db('admin1').ref('shop/items/itemA').update(edit('admin1', { by: 'admin1' })));
  });
  it('ALLOW admins to keep managing bundled-module items', async () => {
    await ok(db('admin1').ref('shop/items/ext-x').set({ name: 'X', desc: '', kind: 'editorExt', price: 5, data: { builtinId: 'line-wrap' }, active: true, updatedAt: TS, updatedBy: 'admin1', createdAt: TS }));
  });
});

describe('shop earnings: purchase creates exactly one earning', () => {
  it('ALLOW buying someone else\'s item: debit, inventory and earning in ONE update', async () => {
    await ok(db('dave').ref().update(purchase('dave', '-cBadge', 30, 100, 'carol')));
    assert.deepEqual(Object.keys(await val('earnings/carol')).sort(), ['dave_-cBadge', 'erin_-cOld', 'zoe_-cBadge']);
    assert.equal((await val('earnings/carol/dave_-cBadge')).price, 30);
    assert.equal((await val('wallets/dave')).balance, 70);
  });
  it('ALLOW buying a creator\'s free item (no wallet change, earning optional)', async () => {
    await ok(db('newbie').ref('inventory/newbie/-cFree').set({ at: TS, price: 0 }));
  });
  it('DENY an earning whose price differs from the catalog price', async () => {
    const u = purchase('dave', '-cBadge', 30, 100, 'carol');
    u['earnings/carol/dave_-cBadge'] = { price: 31, ts: TS };
    await deny(db('dave').ref().update(u));
    u['earnings/carol/dave_-cBadge'] = { price: 10000, ts: TS };
    await deny(db('dave').ref().update(u));
  });
  it('DENY an earning without a purchase in the same write', async () => {
    await deny(db('dave').ref('earnings/carol/dave_-cBadge').set({ price: 30, ts: TS }));
    // erin already owns -cOld: the inventory entry is not created by this write, so no earning can be either
    await admin((d) => d.ref('earnings/carol/erin_-cOld').remove());
    await deny(db('erin').ref('earnings/carol/erin_-cOld').set({ price: 25, ts: TS }));
  });
  it('DENY a second earning for the same purchase (double earning)', async () => {
    await ok(db('dave').ref().update(purchase('dave', '-cBadge', 30, 100, 'carol')));
    await admin((d) => d.ref('earnings/carol/dave_-cBadge').remove()); // as if carol collected it
    await deny(db('dave').ref('earnings/carol/dave_-cBadge').set({ price: 30, ts: TS }));
    await deny(db('dave').ref().update(purchase('dave', '-cBadge', 30, 70, 'carol'))); // can't buy twice either
  });
  it('DENY two earnings in one purchase through an alternate key spelling', async () => {
    // "dave_-xdave_y".replace('dave_', '') would also name item -xy without the exact-key check.
    await deny(db('dave').ref().update(purchase('dave', '-xy', 40, 100, 'carol', { 'earnings/carol/dave_-xdave_y': { price: 40, ts: TS } })));
    await ok(db('dave').ref().update(purchase('dave', '-xy', 40, 100, 'carol')));
  });
  it('DENY crediting anyone but the item\'s creator, or an admin item', async () => {
    await deny(db('dave').ref().update(purchase('dave', '-cBadge', 30, 100, 'bob')));
    await deny(db('dave').ref().update(purchase('dave', 'itemFree', 0, 100, 'admin1')));
    await deny(db('erin').ref().update({
      ...purchase('erin', 'itemTheme', 10, 20, null),
      'earnings/admin1/erin_itemTheme': { price: 10, ts: TS },
    }));
  });
  it('DENY an earning keyed to another buyer', async () => {
    await deny(db('dave').ref().update({
      ...purchase('dave', '-cBadge', 30, 100, null),
      'earnings/carol/erin_-cBadge': { price: 30, ts: TS },
    }));
  });
  it('DENY an earning when buying your own item; ALLOW the purchase without one', async () => {
    await admin((d) => d.ref('wallets/carol/balance').set(100));
    await deny(db('carol').ref().update(purchase('carol', '-cOld', 25, 100, 'carol')));
    await ok(db('carol').ref().update(purchase('carol', '-cOld', 25, 100, null)));
  });
  it('DENY extra fields, a forged timestamp, or rewriting an existing earning', async () => {
    const u = purchase('dave', '-cBadge', 30, 100, 'carol');
    u['earnings/carol/dave_-cBadge'] = { price: 30, ts: TS, note: 'x' };
    await deny(db('dave').ref().update(u));
    u['earnings/carol/dave_-cBadge'] = { price: 30, ts: 5 };
    await deny(db('dave').ref().update(u));
    await deny(db('erin').ref('earnings/carol/erin_-cOld/price').set(9999));
    await deny(db('carol').ref('earnings/carol/erin_-cOld/price').set(9999));
    await deny(db('carol').ref('earnings/carol/erin_-cOld').set({ price: 9999, ts: TS }));
  });
  it('DENY reading or deleting someone else\'s earnings; ALLOW reading your own', async () => {
    await ok(db('carol').ref('earnings/carol').once('value'));
    await deny(db('dave').ref('earnings/carol').once('value'));
    await deny(db('erin').ref('earnings/carol/erin_-cOld').once('value'));
    await deny(db('erin').ref('earnings/carol/erin_-cOld').remove());
    await deny(db('carol').ref('earnings/carol').remove()); // one entry at a time only
  });
});

describe('shop earnings: collect', () => {
  it('ALLOW collecting one entry: + exactly its price, lastEarn = key, entry deleted, in ONE update', async () => {
    await ok(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 25)));
    const w = await val('wallets/carol');
    assert.equal(w.balance, 35);
    assert.equal(w.lastEarn, 'erin_-cOld');
    assert.equal(await val('earnings/carol/erin_-cOld'), null);
  });
  it('ALLOW "collect all" as a sequence of single collects', async () => {
    await ok(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 25)));
    await ok(db('carol').ref().update(collect('carol', 'zoe_-cBadge', 35, 30)));
    assert.equal((await val('wallets/carol')).balance, 65);
    assert.equal(await val('earnings/carol'), null);
  });
  it('DENY collecting more than the entry, or two entries\' worth with one deletion', async () => {
    await deny(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 26)));
    await deny(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 55, { 'earnings/carol/zoe_-cBadge': null })));
  });
  it('DENY collecting without deleting the entry (collect twice)', async () => {
    const u = collect('carol', 'erin_-cOld', 10, 25);
    delete u['earnings/carol/erin_-cOld'];
    await deny(db('carol').ref().update(u));
  });
  it('DENY collecting the same entry again after it was collected', async () => {
    await ok(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 25)));
    await deny(db('carol').ref().update(collect('carol', 'erin_-cOld', 35, 25)));
    await deny(db('carol').ref().update(collect('carol', 'zoe_-cBadge', 35, 30, { 'wallets/carol/lastEarn': 'erin_-cOld' })));
  });
  it('DENY collecting someone else\'s entry', async () => {
    await deny(db('dave').ref().update({
      'wallets/dave/balance': 125, 'wallets/dave/lastEarn': 'erin_-cOld', 'earnings/carol/erin_-cOld': null,
    }));
    await deny(db('dave').ref().update(collect('dave', 'erin_-cOld', 100, 25)));
    await deny(db('dave').ref('wallets/carol').update({ balance: 35, lastEarn: 'erin_-cOld' }));
  });
  it('DENY collecting an entry that does not exist, or one created in the same write', async () => {
    await deny(db('carol').ref().update(collect('carol', 'dave_-cBadge', 10, 30)));
    // Self-purchase plus "collect" of a self-earning in one write: the earning can't be created.
    await admin((d) => d.ref('wallets/carol/balance').set(100));
    await deny(db('carol').ref().update({
      'inventory/carol/-cOld': { at: TS, price: 25 },
      'wallets/carol/lastItem': '-cOld',
      'wallets/carol/balance': 100,
      'wallets/carol/lastEarn': 'carol_-cOld',
      'earnings/carol/carol_-cOld': { price: 25, ts: TS },
    }));
  });
  it('DENY a forged lastEarn path, or a claim/lastClaim reset during a collect', async () => {
    await deny(db('carol').ref().update({ 'wallets/carol/balance': 35, 'wallets/carol/lastEarn': 'erin_-cOld/price' }));
    await deny(db('carol').ref().update({ 'wallets/carol/balance': 35, 'wallets/carol/lastEarn': '' }));
    await deny(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 25, { 'wallets/carol/lastClaim': 1 })));
    await deny(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 125, { 'wallets/carol/lastClaim': TS })));
  });
  it('DENY collecting without a wallet (claim the starter coins first)', async () => {
    await admin((d) => d.ref('wallets/carol').remove());
    await deny(db('carol').ref().update(collect('carol', 'erin_-cOld', 0, 25, { 'wallets/carol/lastClaim': TS })));
  });
  it('DENY combining a collect with a purchase in one wallet write', async () => {
    await deny(db('carol').ref().update({
      ...collect('carol', 'erin_-cOld', 10, 25),
      'wallets/carol/balance': 35 - 20,
      'wallets/carol/lastItem': '-dItem',
      'inventory/carol/-dItem': { at: TS, price: 20 },
    }));
  });
  it('ALLOW a creator to discard an entry (forfeits it; nothing is credited)', async () => {
    await ok(db('carol').ref('earnings/carol/erin_-cOld').remove());
    assert.equal((await val('wallets/carol')).balance, 10);
  });
  it('purchases still work after collecting (lastEarn does not block lastItem)', async () => {
    await ok(db('carol').ref().update(collect('carol', 'erin_-cOld', 10, 25)));
    await ok(db('carol').ref().update(purchase('carol', '-dItem', 20, 35, 'dave')));
    assert.equal((await val('wallets/carol')).balance, 15);
    assert.equal((await val('earnings/dave/carol_-dItem')).price, 20);
  });
});

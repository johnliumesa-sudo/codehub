// Premium membership: monthly codes (premium/{uid}, premiumCodes/{YYYYMM}), the owner passcode
// (config/ownerPass), double daily coins and premium-only shop items. Secrets are random per run.
import { describe, it, before, after, beforeEach } from 'node:test';
import { randomBytes } from 'node:crypto';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, reset, db, admin, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds;
const deny = assertFails;
const DAY = 24 * 3600 * 1000;
const PREMIUM_MS = 30 * DAY;
const rand = (n = 12) => randomBytes(n).toString('base64url');

// Fresh random secrets per run; never real values.
const OWNER_PASS = rand(12); // 16 chars
const CODE_NOW = `T${rand(9)}`;
const CODE_NEXT = `N${rand(9)}`;
const CODE_OLD = `O${rand(9)}`;
const CODE_FUTURE = `F${rand(9)}`;

let T0;
function patch(w) {
  const now = Date.now();
  T0 = now;
  w.config.ownerPass = OWNER_PASS;
  w.premiumCodes = {
    202611: { c: CODE_NOW, from: now - DAY, until: now + DAY },
    202612: { c: CODE_NEXT, from: now - DAY, until: now + 2 * DAY }, // a second open window (renewal)
    202610: { c: CODE_OLD, from: now - 40 * DAY, until: now - DAY },
    202701: { c: CODE_FUTURE, from: now + DAY, until: now + 30 * DAY },
  };
  w.premium = { erin: { at: now - DAY, until: now + 29 * DAY, m: '202611' } };
  w.wallets.erin.lastClaim = now - 21 * 3600 * 1000;
  w.wallets.dave.lastClaim = now - 21 * 3600 * 1000;
  w.shop.items.itemPrem = { name: 'Aurora', desc: 'members', kind: 'badge', price: 10, data: { glyph: 'A' }, active: true, premium: true, updatedAt: 1, updatedBy: 'admin1' };
  w.shop.items.itemPremFree = { name: 'Gift', desc: 'members', kind: 'nameColor', price: 0, data: { color: '#00ff00' }, active: true, premium: true, updatedAt: 1, updatedBy: 'admin1' };
}

before(getEnv);
after(cleanup);
beforeEach(() => reset(patch));

async function val(path) {
  let v;
  await admin(async (d) => { v = (await d.ref(path).get()).val(); });
  return v;
}
const guess = (u, code) => db(u).ref(`promoAttempts/${u}`).set({ code, at: TS });
// The client can't know the server's exact `now`: `until` must be within the minute before now + 30 days.
const until = (skew = -5000) => Date.now() + PREMIUM_MS + skew;
const rec = (m, extra = {}) => ({ at: TS, until: until(), m, ...extra });
const write = (u, m, extra) => db(u).ref(`premium/${u}`).set(rec(m, extra));

describe('premium: redeeming a monthly code', () => {
  it('ALLOW the right code for an open month window', async () => {
    await ok(guess('dave', CODE_NOW));
    await ok(write('dave', '202611'));
    const r = await val('premium/dave');
    if (r.m !== '202611' || Math.abs(r.until - r.at - PREMIUM_MS) > 60000) throw new Error(JSON.stringify(r));
  });
  it('DENY a wrong code, an expired month, a future month and a month without a code', async () => {
    await ok(guess('dave', `${CODE_NOW}x`));
    await deny(write('dave', '202611'));
    await ok(guess('frank', CODE_OLD));
    await deny(write('frank', '202610'));
    await ok(guess('gina', CODE_FUTURE));
    await deny(write('gina', '202701'));
    await ok(guess('hank', CODE_NOW));
    await deny(write('hank', '202609'));
    await deny(write('hank', '202612')); // right code, wrong month
  });
  it('DENY a stale guess (older than 2 minutes) and no guess at all', async () => {
    await admin((d) => d.ref('promoAttempts/dave').set({ code: CODE_NOW, at: Date.now() - 121000 }));
    await deny(write('dave', '202611'));
    await deny(write('frank', '202611'));
  });
  it('DENY a wrong length, a wrong `at`, extra fields and writing someone else', async () => {
    await ok(guess('dave', CODE_NOW));
    const p = db('dave').ref('premium/dave');
    await deny(p.set({ at: TS, until: until(DAY), m: '202611' }));
    await deny(p.set({ at: TS, until: until(5000), m: '202611' }));
    await deny(p.set({ at: TS, until: until(-90000), m: '202611' }));
    await deny(p.set({ at: Date.now() - 5000, until: until(), m: '202611' }));
    await deny(p.set({ at: TS, until: until(), m: 202611 }));
    await deny(write('dave', '202611', { vip: true }));
    await deny(p.set({ at: TS, until: until() }));
    await deny(db('dave').ref('premium/frank').set(rec('202611')));
    await ok(write('dave', '202611'));
  });
  it('renew: ALLOW a later month\'s code, DENY the same month\'s code again', async () => {
    await ok(guess('erin', CODE_NOW));
    await deny(write('erin', '202611'));
    await admin((d) => d.ref('promoAttempts/erin').remove());
    await ok(guess('erin', CODE_NEXT));
    await ok(write('erin', '202612'));
    const r = await val('premium/erin');
    if (r.m !== '202612' || r.until < T0 + 29 * DAY) throw new Error(JSON.stringify(r));
  });
  it('the passcode for the owner dashboard is not a premium code', async () => {
    await ok(guess('dave', OWNER_PASS));
    await deny(write('dave', '202611'));
  });
});

describe('premium: reading, deleting, revoking', () => {
  it('ALLOW anyone signed in to read one record; DENY signed-out readers', async () => {
    await ok(db('dave').ref('premium/erin').get());
    await deny(db(null).ref('premium/erin').get());
  });
  it('ALLOW only app admins to list every member', async () => {
    await ok(db('admin1').ref('premium').get());
    await deny(db('dave').ref('premium').get());
    await deny(db('erin').ref('premium').get());
  });
  it('ALLOW a member to delete their own record; DENY deleting someone else\'s', async () => {
    await deny(db('dave').ref('premium/erin').remove());
    await ok(db('erin').ref('premium/erin').remove());
  });
  it('ALLOW app admins to revoke any record; DENY admins granting premium', async () => {
    await ok(db('admin1').ref('premium/erin').remove());
    await deny(db('admin1').ref('premium/dave').set(rec('202611')));
  });
});

describe('premium: owner dashboard access to premiumCodes', () => {
  const unlock = (u, code = OWNER_PASS) => db(u).ref(`promoAttempts/${u}`).set({ code, at: TS });
  const code = (from = Date.now(), c = `G${rand(9)}`) => ({ c, from, until: from + 30 * DAY });

  it('ALLOW an app admin with a fresh correct passcode to read and write codes', async () => {
    await ok(unlock('admin1'));
    await ok(db('admin1').ref('premiumCodes').get());
    await ok(db('admin1').ref('premiumCodes/202702').set(code()));
    await ok(db('admin1').ref('premiumCodes/202611').set(code(T0 - DAY)));
    await ok(db('admin1').ref('premiumCodes/202702').remove());
  });
  it('DENY without a passcode, with a wrong one, or after 15 minutes', async () => {
    await deny(db('admin1').ref('premiumCodes').get());
    await deny(db('admin1').ref('premiumCodes/202702').set(code()));
    await ok(unlock('admin1', `${OWNER_PASS}x`));
    await deny(db('admin1').ref('premiumCodes').get());
    await admin((d) => d.ref('promoAttempts/admin1').set({ code: OWNER_PASS, at: Date.now() - 15 * 60000 - 2000 }));
    await deny(db('admin1').ref('premiumCodes').get());
    await deny(db('admin1').ref('premiumCodes/202702').set(code()));
    await admin((d) => d.ref('promoAttempts/admin1').set({ code: OWNER_PASS, at: Date.now() - 14 * 60000 }));
    await ok(db('admin1').ref('premiumCodes').get());
  });
  it('DENY non-admins even with the correct passcode', async () => {
    await ok(unlock('dave'));
    await deny(db('dave').ref('premiumCodes').get());
    await deny(db('dave').ref('premiumCodes/202611').get());
    await deny(db('dave').ref('premiumCodes/202702').set(code()));
  });
  it('DENY everyone while config/ownerPass is missing or shorter than 12 characters', async () => {
    const short = rand(6).slice(0, 11);
    await admin((d) => d.ref('config/ownerPass').set(short));
    await ok(unlock('admin1', short));
    await deny(db('admin1').ref('premiumCodes').get());
    await admin((d) => d.ref('config/ownerPass').remove());
    await deny(db('admin1').ref('premiumCodes').get());
  });
  it('DENY malformed codes', async () => {
    await ok(unlock('admin1'));
    await deny(db('admin1').ref('premiumCodes/202702').set({ ...code(), c: 'short' }));
    await deny(db('admin1').ref('premiumCodes/202702').set({ ...code(), until: 1 }));
    await deny(db('admin1').ref('premiumCodes/202702').set({ ...code(), extra: 1 }));
    await deny(db('admin1').ref('premiumCodes/2027-2').set(code()));
  });
  it('config stays unreadable and unwritable', async () => {
    await ok(unlock('admin1'));
    for (const u of ['admin1', 'dave', 'erin']) {
      await deny(db(u).ref('config').get());
      await deny(db(u).ref('config/ownerPass').get());
      await deny(db(u).ref('config/ownerPass').set(rand(12)));
      await deny(db(u).ref('config/adminPromo').get());
    }
    await deny(db('admin1').ref('promoAttempts/admin1').get());
  });
});

describe('premium perks: double daily coins and premium-only items', () => {
  it('daily claim: +200 while premium is active, +100 otherwise', async () => {
    await deny(db('dave').ref('wallets/dave').update({ balance: 300, lastClaim: TS }));
    await ok(db('dave').ref('wallets/dave').update({ balance: 200, lastClaim: TS }));
    await deny(db('erin').ref('wallets/erin').update({ balance: 120, lastClaim: TS }));
    await ok(db('erin').ref('wallets/erin').update({ balance: 220, lastClaim: TS }));
  });
  it('daily claim: an expired membership gives +100', async () => {
    await admin((d) => d.ref('premium/erin/until').set(Date.now() - 1000));
    await deny(db('erin').ref('wallets/erin').update({ balance: 220, lastClaim: TS }));
    await ok(db('erin').ref('wallets/erin').update({ balance: 120, lastClaim: TS }));
  });
  it('premium-only items: DENY non-members (paid and free), ALLOW active members', async () => {
    await admin((d) => d.ref('wallets/dave/balance').set(100));
    const buy = (u, bal) => db(u).ref().update({
      [`wallets/${u}/balance`]: bal - 10, [`wallets/${u}/lastItem`]: 'itemPrem', [`inventory/${u}/itemPrem`]: { at: TS, price: 10 },
    });
    await deny(buy('dave', 100));
    await deny(db('dave').ref('inventory/dave/itemPremFree').set({ at: TS, price: 0 }));
    await ok(buy('erin', 20));
    await ok(db('erin').ref('inventory/erin/itemPremFree').set({ at: TS, price: 0 }));
  });
  it('premium-only items: DENY a member whose membership expired', async () => {
    await admin((d) => d.ref('premium/erin/until').set(Date.now() - 1000));
    await deny(db('erin').ref('inventory/erin/itemPremFree').set({ at: TS, price: 0 }));
  });
  it('items: the premium flag is true or absent; creators and admins set it', async () => {
    const base = { name: 'X', desc: '', kind: 'badge', price: 5, data: { glyph: 'x' }, active: true, updatedAt: TS, updatedBy: 'admin1' };
    await ok(db('admin1').ref('shop/items/itemNew').set({ ...base, premium: true }));
    await deny(db('admin1').ref('shop/items/itemNew2').set({ ...base, premium: false }));
    await deny(db('admin1').ref('shop/items/itemNew2').set({ ...base, premium: 'yes' }));
    await ok(db('admin1').ref('shop/items/itemPrem').update({ premium: null, updatedAt: TS, updatedBy: 'admin1' }));
    await deny(db('dave').ref('shop/items/itemA').update({ premium: true, updatedAt: TS, updatedBy: 'dave' }));
  });
});

// rules:min drops an `X.isString()` guard in front of `X.val().length` / `X.val().matches(` in .validate
// chains: these probes pin down that .length and .matches() on every non-string type fail the rule.
describe('rules language probes (dropped isString() guards)', () => {
  let env;
  const V = (e) => ({ '.write': true, '.validate': e });
  const rules = { rules: {
    len: { $id: V("newData.child('a').val().length >= 0") },
    lenNeg: { $id: V("newData.child('a').val().length < 1000") },
    re: { $id: V("newData.child('a').val().matches(/.*/)") },
    leafLen: { $id: V('newData.val().length >= 0') },
    dlen: { $id: { '.write': true, '.validate': "data.val().length >= 0 || !data.exists()" } },
  } };
  before(async () => {
    const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
    env = await initializeTestEnvironment({ projectId: 'demo-codehub-probe-premium', database: { rules: JSON.stringify(rules), host, port: Number(port) } });
  });
  after(async () => env?.cleanup());
  const tryWrite = async (path, v) => {
    try {
      await env.authenticatedContext('u').database().ref(path).set(v);
      return true;
    } catch {
      return false;
    }
  };
  it('.length and .matches() on numbers, booleans, objects and null fail; strings pass', async () => {
    const bad = [5, 0, -1, 1.5, true, false, { x: 'y' }, { length: 3 }, undefined];
    let n = 0;
    const wrong = [];
    for (const a of bad) {
      const d = { c: 1 };
      if (a !== undefined) d.a = a;
      for (const p of ['len', 'lenNeg', 're']) if (await tryWrite(`${p}/b${n++}`, d)) wrong.push([p, a]);
    }
    for (const a of [5, true, { x: 'y' }]) if (await tryWrite(`leafLen/b${n++}`, a)) wrong.push(['leafLen', a]);
    for (const p of ['len', 'lenNeg', 're']) if (!(await tryWrite(`${p}/g${n++}`, { a: 'str', c: 1 }))) wrong.push([p, 'string refused']);
    if (!(await tryWrite(`leafLen/g${n++}`, 'str'))) wrong.push(['leafLen', 'string refused']);
    if (wrong.length) throw new Error(`non-strings passed: ${JSON.stringify(wrong)}`);
  });
});

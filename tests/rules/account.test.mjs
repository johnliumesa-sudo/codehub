// Integration: the round 3 removals that account deletion (src/lib/account.js) makes, each as its own
// write: community shop items I created (also one an admin took down), my uncollected earnings one
// entry at a time, and the server items I wrote in a server I'm leaving (events, RSVPs, the
// rules-accepted marker), read and removed while still a member.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds;
const deny = assertFails;

const comm = (by, extra = {}) => ({
  name: 'Comm', desc: 'made by a user', kind: 'badge', price: 30, data: { glyph: 'C' }, active: true,
  updatedAt: 1, updatedBy: by, by, createdAt: 1, ...extra,
});

function patch(w) {
  Object.assign(w.shop.items, {
    '-dLive': comm('dave'),
    '-dHeld': comm('dave', { active: false, updatedBy: 'admin1' }), // taken down by an app admin
    '-eItem': comm('erin'),
  });
  w.earnings = {
    dave: { 'erin_-dLive': { price: 30, ts: 1 }, 'zoe_-dLive': { price: 30, ts: 2 } },
    erin: { 'dave_-eItem': { price: 30, ts: 3 } },
  };
  w.sitems = {
    s1: {
      events: { ev1: { by: 'dave', iv: box.iv, ct: box.ct }, ev2: { by: 'erin', iv: box.iv, ct: box.ct } },
      rsvp: { 'ev2~dave': { by: 'dave', s: 'going', ts: 1 }, 'ev2~erin': { by: 'erin', s: 'maybe', ts: 1 } },
      accepted: { dave: { by: 'dave', v: 1, ts: 1 } },
    },
  };
}

before(getEnv);
after(cleanup);
beforeEach(() => reset(patch));

describe('account deletion: round 3 data (integration)', () => {
  it('ALLOW finding and deleting my community items one by one, also one an admin took down', async () => {
    await ok(db('dave').ref('shop/items').get());
    await ok(db('dave').ref('shop/items/-dLive').remove());
    await ok(db('dave').ref('shop/items/-dHeld').remove());
  });
  it('DENY deleting another creator’s item or an official one', async () => {
    await deny(db('dave').ref('shop/items/-eItem').remove());
    await deny(db('dave').ref('shop/items/itemA').remove());
  });
  it('ALLOW reading and deleting my uncollected earnings one entry at a time; DENY others’', async () => {
    await ok(db('dave').ref('earnings/dave').get());
    await ok(db('dave').ref('earnings/dave/erin_-dLive').remove());
    await ok(db('dave').ref('earnings/dave/zoe_-dLive').remove());
    await deny(db('dave').ref('earnings/erin/dave_-eItem').remove());
    await deny(db('dave').ref('earnings/erin').get());
  });
  it('ALLOW a member to read the server items and delete each one they wrote before leaving', async () => {
    await ok(db('dave').ref('sitems/s1').get());
    await ok(db('dave').ref('sitems/s1/events/ev1').remove());
    await ok(db('dave').ref('sitems/s1/rsvp/ev2~dave').remove());
    await ok(db('dave').ref('sitems/s1/accepted/dave').remove());
  });
  it('ALLOW the private-node batch account deletion sends (one refused path would fail all of it)', async () => {
    await ok(db('dave').ref().update(Object.fromEntries([
      'reads', 'presence', 'vaults', 'equipped', 'blocks', 'verified', 'notifPrefs', 'snippets', 'adminBadges',
      'notifs', 'avatars', 'bookmarks',
    ].map((p) => [`${p}/dave`, null]))));
    // Rate-limit logs stay by design: deleting one would reopen its window.
    await deny(db('dave').ref().update({ 'notifLog/dave': null }));
  });
  it('DENY deleting other members’ server items (a plain member), and reading them after leaving', async () => {
    await deny(db('dave').ref('sitems/s1/events/ev2').remove());
    await deny(db('dave').ref('sitems/s1/rsvp/ev2~erin').remove());
    await deny(db('zoe').ref('sitems/s1').get());
  });
});

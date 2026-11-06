// Tier 2 (chatx): poll votes and encrypted bookmarks.
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, box, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);

describe('poll votes', () => {
  beforeEach(() => reset());
  it('ALLOW own integer vote 0-9, change and retract', async () => {
    await ok(db('dave').ref('votes/s1_c1/m1/dave').set(0));
    await ok(db('dave').ref('votes/s1_c1/m1/dave').set(9));
    await ok(db('dave').ref('votes/s1_c1/m1/dave').remove());
  });
  it('DENY voting for someone else, out of range, fractional, non-number, unauthenticated read', async () => {
    await deny(db('dave').ref('votes/s1_c1/m1/bob').set(1));
    await deny(db('dave').ref('votes/s1_c1/m1/dave').set(10));
    await deny(db('dave').ref('votes/s1_c1/m1/dave').set(-1));
    await deny(db('dave').ref('votes/s1_c1/m1/dave').set(1.5));
    await deny(db('dave').ref('votes/s1_c1/m1/dave').set('1'));
    await deny(db(null).ref('votes/s1_c1/m1').get());
    await ok(db('bob').ref('votes/s1_c1/m1').get());
  });
});

describe('bookmarks', () => {
  beforeEach(() => reset());
  const bm = () => ({ iv: box.iv, ct: box.ct, ts: TS });
  it('ALLOW owner write/read/delete', async () => {
    await ok(db('dave').ref('bookmarks/dave/s1_c1_m1').set(bm()));
    await ok(db('dave').ref('bookmarks/dave').get());
    await ok(db('dave').ref('bookmarks/dave/s1_c1_m1').remove());
  });
  it('DENY other users, extra fields, bad iv', async () => {
    await deny(db('bob').ref('bookmarks/dave/k').set(bm()));
    await deny(db('bob').ref('bookmarks/dave').get());
    await deny(db('dave').ref('bookmarks/dave/k').set({ ...bm(), extra: 1 }));
    await deny(db('dave').ref('bookmarks/dave/k').set({ ...bm(), iv: 'short' }));
  });
});

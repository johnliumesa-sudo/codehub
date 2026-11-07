// games/{id}/lang: the optional language of a published game ('html' | 'js' | 'ts' | 'py' | 'lua').
import { describe, it, before, after, beforeEach } from 'node:test';
import { getEnv, cleanup, reset, db, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
before(getEnv); after(cleanup);
beforeEach(() => reset());

const game = (owner, extra = {}) => ({ ownerId: owner, title: 'T', desc: '', createdAt: TS, updatedAt: TS, likes: 0, size: 5, ...extra });

describe('games lang', () => {
  it('ALLOW publish with each known language', async () => {
    for (const [i, lang] of ['html', 'js', 'ts', 'py', 'lua'].entries()) {
      // publishLog allows one write per `now`; use a fresh user per publish.
      const u = `lang${i}`;
      await ok(db(u).ref().update({ [`games/gL${i}`]: game(u, { lang }), [`gameCode/gL${i}`]: { html: 'x' }, [`publishLog/${u}`]: TS }));
    }
  });
  it('ALLOW publish without lang (older clients)', async () => {
    await ok(db('mallory').ref().update({ 'games/gX': game('mallory'), 'gameCode/gX': { html: 'x' }, 'publishLog/mallory': TS }));
  });
  it('DENY unknown or malformed lang', async () => {
    for (const lang of ['cpp', 'PY', 'py ', '', 'html|js', 7, true]) {
      await deny(db('mallory').ref().update({ 'games/gX': game('mallory', { lang }), 'gameCode/gX': { html: 'x' }, 'publishLog/mallory': TS }));
    }
  });
  it('ALLOW the owner to set lang with a code update; DENY others', async () => {
    await ok(db('dave').ref().update({
      'games/gm1/lang': 'py', 'games/gm1/updatedAt': TS, 'games/gm1/size': 3, 'gameCode/gm1/html': 'x y', 'publishLog/dave': TS,
    }));
    await deny(db('mallory').ref().update({ 'games/gm1/lang': 'ts', 'games/gm1/updatedAt': TS, 'publishLog/mallory': TS }));
    await deny(db('mallory').ref('games/gm1/lang').set('lua'));
  });
});

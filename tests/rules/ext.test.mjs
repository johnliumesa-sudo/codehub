// Round 3 foundation: the generic rules blocks (udata, upub, sconf, sitems, pub), the manageApps
// permission, and emulator probes of the rules-language behaviour the minifier and the compact
// blocks rely on (== vs ===, short-circuiting, errors denying).
import { describe, it, before, after, beforeEach } from 'node:test';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, reset, db, admin, box, TS, assertFails, assertSucceeds } from './helpers.mjs';

const ok = assertSucceeds, deny = assertFails;
const big = (n) => 'x'.repeat(n);
const appsRole = { nameEnc: box, color: '#00ff00', position: 40, perms: { manageApps: true }, createdAt: 1 };
// erin gets a custom role with manageApps; frank is timed out for a minute.
const seed = (w) => {
  w.servers.s1.roles.rApps = appsRole;
  w.servers.s1.members.erin.roleId = 'rApps';
  w.servers.s1.timeouts = { frank: Date.now() + 60_000 };
  w.sitems = { s1: { notes: { i1: { by: 'dave', title: 'hello', n: 1 } } } };
  w.sconf = { s1: { automod: { rules: { on: true } } } };
  w.pub = { bots: { b1: { by: 'dave', ts: 1, name: 'Echo' } }, servers: {} };
};

describe('round 3 generic blocks', () => {
  before(getEnv);
  after(cleanup);
  beforeEach(() => reset(seed));

  describe('udata (private per user)', () => {
    it('ALLOW the owner to write and read leaves and objects of leaves', async () => {
      await ok(db('dave').ref('udata/dave/drafts/k1').set('hello'));
      await ok(db('dave').ref('udata/dave/drafts/k2').set({ text: big(20000), at: 5, on: false }));
      await ok(db('dave').ref('udata/dave/drafts/k3').set(42));
      await ok(db('dave').ref('udata/dave/drafts/k4').set(true));
      await ok(db('dave').ref('udata/dave/drafts').get());
      await ok(db('dave').ref('udata/dave/drafts/k2/text').set('changed'));
      await ok(db('dave').ref('udata/dave').remove());
    });
    it('DENY other users and unauthenticated access', async () => {
      await deny(db('erin').ref('udata/dave/drafts/k1').set('x'));
      await deny(db('erin').ref('udata/dave').get());
      await deny(db(null).ref('udata/dave').get());
      await deny(db(null).ref('udata/dave/drafts/k1').set('x'));
    });
    it('DENY bad feature names, long keys and field names, strings over 20000, depth beyond {f}, leaves at {feat}', async () => {
      for (const feat of ['Drafts', '1x', 'a_b', 'a-b', `a${'b'.repeat(24)}`]) await deny(db('dave').ref(`udata/dave/${feat}/k`).set('x'));
      await ok(db('dave').ref(`udata/dave/a${'b'.repeat(23)}/k`).set('x'));
      await deny(db('dave').ref(`udata/dave/drafts/${big(129)}`).set('x'));
      await ok(db('dave').ref(`udata/dave/drafts/${big(128)}`).set('x'));
      await deny(db('dave').ref(`udata/dave/drafts/k/${big(65)}`).set('x'));
      await ok(db('dave').ref(`udata/dave/drafts/k/${big(64)}`).set('x'));
      await deny(db('dave').ref('udata/dave/drafts/k').set(big(20001)));
      await deny(db('dave').ref('udata/dave/drafts/k/f').set(big(20001)));
      await deny(db('dave').ref('udata/dave/drafts/k').set({ f: { deeper: 1 } }));
      await deny(db('dave').ref('udata/dave/drafts/k/f/g').set(1));
      await deny(db('dave').ref('udata/dave/drafts').set('leaf'));
      await deny(db('dave').ref('udata/dave').set({ drafts: 'leaf' }));
    });
  });

  describe('upub (public per user)', () => {
    it('ALLOW any signed-in user to read; only the owner writes', async () => {
      await ok(db('dave').ref('upub/dave/status/now').set({ text: 'coding', emoji: '💻', until: 0 }));
      await ok(db('mallory').ref('upub/dave/status').get());
      await deny(db(null).ref('upub/dave/status').get());
      await deny(db('mallory').ref('upub/dave/status/now').set({ text: 'hacked' }));
    });
    it('DENY strings over 2000 and the same shape violations', async () => {
      await ok(db('dave').ref('upub/dave/status/now').set(big(2000)));
      await deny(db('dave').ref('upub/dave/status/now').set(big(2001)));
      await deny(db('dave').ref('upub/dave/status/now/text').set(big(2001)));
      await deny(db('dave').ref('upub/dave/status/now').set({ a: { b: 1 } }));
      await deny(db('dave').ref('upub/dave/Status/now').set('x'));
    });
  });

  describe('sconf (server config)', () => {
    it('ALLOW members to read; DENY non-members', async () => {
      await ok(db('dave').ref('sconf/s1/automod').get());
      await deny(db('mallory').ref('sconf/s1/automod').get());
      await deny(db(null).ref('sconf/s1').get());
    });
    it('ALLOW owner, admins and manageApps roles to write', async () => {
      await ok(db('alice').ref('sconf/s1/automod/rules').set({ on: false, words: box.ct }));
      await ok(db('bob').ref('sconf/s1/welcome/screen').set({ iv: box.iv, ct: box.ct }));
      await ok(db('erin').ref('sconf/s1/discovery/listed').set(true));
      await ok(db('erin').ref('sconf/s1/automod').remove());
    });
    it('DENY plain members, roles without manageApps, non-members, timed-out irrelevant', async () => {
      await deny(db('dave').ref('sconf/s1/automod/rules').set({ on: false }));
      await deny(db('carol').ref('sconf/s1/automod/rules').set({ on: false })); // manageMessages/manageRoles only
      await deny(db('mallory').ref('sconf/s1/automod/rules').set({ on: false }));
      await deny(db('dave').ref('sconf/s1/automod').remove());
    });
    it('DENY shape and size violations', async () => {
      await deny(db('alice').ref('sconf/s1/automod/rules/words').set(big(20001)));
      await ok(db('alice').ref('sconf/s1/automod/rules/words').set(big(20000)));
      await deny(db('alice').ref('sconf/s1/automod/rules').set({ a: { b: 1 } }));
      await deny(db('alice').ref('sconf/s1/automod').set('leaf'));
      await deny(db('alice').ref('sconf/s1/Auto/rules').set(1));
    });
    it('garbage: whole sconf/{sid} goes with the server, or once the server is gone; not while it exists', async () => {
      await deny(db('alice').ref('sconf/s1').remove()); // the owner clears feature by feature instead
      await deny(db('dave').ref('sconf/s1').remove());
      await ok(db('alice').ref().update({ 'servers/s1': null, 'sconf/s1': null, 'sitems/s1': null }));
      await reset(seed);
      await admin((d) => d.ref('servers/s1').remove());
      await ok(db('mallory').ref('sconf/s1').remove());
    });
  });

  describe('sitems (member items)', () => {
    it('ALLOW members to read; DENY non-members', async () => {
      await ok(db('dave').ref('sitems/s1/notes').get());
      await deny(db('mallory').ref('sitems/s1/notes').get());
    });
    it('ALLOW a member to create with by = self, and the author to update', async () => {
      await ok(db('erin').ref('sitems/s1/notes/i2').set({ by: 'erin', title: 'mine', at: TS }));
      await ok(db('dave').ref('sitems/s1/notes/i1/title').set('edited'));
      await ok(db('dave').ref('sitems/s1/notes/i1').update({ title: 'again', n: 2 }));
      await ok(db('dave').ref('sitems/s1/notes/i1').set({ by: 'dave', title: 'replaced' }));
    });
    it('DENY by = someone else, non-members, timed-out members, items without by', async () => {
      await deny(db('erin').ref('sitems/s1/notes/i3').set({ by: 'dave', title: 'forged' }));
      await deny(db('mallory').ref('sitems/s1/notes/i3').set({ by: 'mallory', title: 'x' }));
      await deny(db('frank').ref('sitems/s1/notes/i3').set({ by: 'frank', title: 'x' }));
      await deny(db('erin').ref('sitems/s1/notes/i3').set({ title: 'no author' }));
      await deny(db('erin').ref('sitems/s1/notes/i3').set('leaf'));
    });
    it('DENY other members editing, and changing by', async () => {
      await deny(db('erin').ref('sitems/s1/notes/i1/title').set('mine now'));
      await deny(db('erin').ref('sitems/s1/notes/i1').set({ by: 'erin', title: 'taken' }));
      await deny(db('dave').ref('sitems/s1/notes/i1/by').set('erin'));
      await deny(db('alice').ref('sitems/s1/notes/i1/title').set('owner edit')); // moderators delete, never edit
    });
    it('DENY a timed-out author updating; ALLOW them to delete their own', async () => {
      await admin((d) => d.ref('sitems/s1/notes/i9').set({ by: 'frank', title: 'old' }));
      await deny(db('frank').ref('sitems/s1/notes/i9/title').set('x'));
      await ok(db('frank').ref('sitems/s1/notes/i9').remove());
    });
    it('ALLOW delete by the author, owner, admin and manageMessages; DENY other members', async () => {
      await deny(db('erin').ref('sitems/s1/notes/i1').remove());
      await deny(db('gina').ref('sitems/s1/notes/i1').remove()); // ban only
      await ok(db('carol').ref('sitems/s1/notes/i1').remove()); // manageMessages
      await reset(seed);
      await ok(db('bob').ref('sitems/s1/notes/i1').remove());
      await reset(seed);
      await ok(db('alice').ref('sitems/s1/notes/i1').remove());
      await reset(seed);
      await ok(db('dave').ref('sitems/s1/notes/i1').remove());
    });
    it('DENY size, depth, id length and feature-name violations', async () => {
      await deny(db('dave').ref('sitems/s1/notes/i4').set({ by: 'dave', body: big(20001) }));
      await ok(db('dave').ref('sitems/s1/notes/i4').set({ by: 'dave', body: big(20000) }));
      await deny(db('dave').ref('sitems/s1/notes/i5').set({ by: 'dave', body: { nested: 1 } }));
      await deny(db('dave').ref(`sitems/s1/notes/${big(129)}`).set({ by: 'dave' }));
      await ok(db('dave').ref(`sitems/s1/notes/${big(128)}`).set({ by: 'dave' }));
      await deny(db('dave').ref('sitems/s1/Notes/i6').set({ by: 'dave' }));
      await deny(db('dave').ref(`sitems/s1/notes/i7/${big(65)}`).set(1));
    });
    it('garbage: sitems/{sid} is removable only once the server is gone', async () => {
      await deny(db('alice').ref('sitems/s1').remove());
      await deny(db('carol').ref('sitems/s1/notes').remove());
      await admin((d) => d.ref('servers/s1').remove());
      await ok(db('mallory').ref('sitems/s1').remove());
    });
  });

  describe('pub (public catalogs)', () => {
    const bot = (by, extra = {}) => ({ by, ts: TS, name: 'Bot', ...extra });
    it('ALLOW any signed-in user to read; DENY unauthenticated', async () => {
      await ok(db('mallory').ref('pub/bots').get());
      await ok(db('mallory').ref('pub/bots').orderByChild('by').equalTo('dave').get());
      await deny(db(null).ref('pub/bots').get());
    });
    it('ALLOW create with by = self and ts = now; DENY forged by, stale or missing ts, unknown kinds', async () => {
      await ok(db('erin').ref('pub/bots/b2').set(bot('erin')));
      await ok(db('erin').ref('pub/addons/a1').set(bot('erin', { desc: 'x' })));
      await ok(db('erin').ref('pub/addonCode/a1').set({ by: 'erin', ts: TS, code: big(65536) }));
      await deny(db('erin').ref('pub/bots/b3').set(bot('dave')));
      await deny(db('erin').ref('pub/bots/b3').set({ by: 'erin', ts: 5, name: 'old' }));
      await deny(db('erin').ref('pub/bots/b3').set({ by: 'erin', name: 'no ts' }));
      await deny(db('erin').ref('pub/games/g1').set(bot('erin')));
      await deny(db(null).ref('pub/bots/b3').set(bot('erin')));
    });
    it('ALLOW updates by the publisher with a fresh ts; DENY others, changing by, updates without ts', async () => {
      await ok(db('dave').ref('pub/bots/b1').update({ name: 'Echo 2', ts: TS }));
      await deny(db('dave').ref('pub/bots/b1').update({ name: 'no ts' }));
      await deny(db('dave').ref('pub/bots/b1/name').set('no ts'));
      await deny(db('erin').ref('pub/bots/b1').update({ name: 'mine', ts: TS }));
      await deny(db('erin').ref('pub/bots/b1').set(bot('erin')));
      await deny(db('dave').ref('pub/bots/b1').update({ by: 'erin', ts: TS }));
    });
    it('ALLOW delete by the publisher and app admins; DENY others', async () => {
      await deny(db('erin').ref('pub/bots/b1').remove());
      await ok(db('admin1').ref('pub/bots/b1').remove());
      await reset(seed);
      await ok(db('dave').ref('pub/bots/b1').remove());
    });
    it('DENY sizes: fields over 20000 (code up to 65536), nested fields', async () => {
      await deny(db('erin').ref('pub/bots/b4').set(bot('erin', { desc: big(20001) })));
      await deny(db('erin').ref('pub/addonCode/a2').set({ by: 'erin', ts: TS, code: big(65537) }));
      await deny(db('erin').ref('pub/bots/b4').set(bot('erin', { cfg: { a: 1 } })));
    });
    it('servers: only that server\'s owner lists it', async () => {
      await ok(db('alice').ref('pub/servers/s1').set({ by: 'alice', ts: TS, name: 'Lobby', members: 7 }));
      await ok(db('alice').ref('pub/servers/s1').update({ members: 8, ts: TS }));
      await deny(db('bob').ref('pub/servers/s1').update({ members: 9, ts: TS })); // admin, not owner/publisher
      await deny(db('dave').ref('pub/servers/s1b').set({ by: 'dave', ts: TS }));
      await deny(db('alice').ref('pub/servers/s404').set({ by: 'alice', ts: TS }));
      await ok(db('alice').ref('pub/servers/s1').remove());
    });
  });

  describe('manageApps permission', () => {
    it('ALLOW the owner to create a role with manageApps; DENY unknown flags', async () => {
      await ok(db('alice').ref('servers/s1/roles/rNew').set({ ...appsRole, position: 30 }));
      await deny(db('alice').ref('servers/s1/roles/rBad').set({ ...appsRole, position: 30, perms: { manageFoo: true } }));
    });
    it('DENY granting manageApps without holding it (manageRoles alone)', async () => {
      await deny(db('carol').ref('servers/s1/roles/rNew').set({ ...appsRole, position: 20 }));
      await ok(db('carol').ref('servers/s1/roles/rNew').set({ ...appsRole, position: 20, perms: { kick: true } }));
    });
  });
});

// The probes run against their own tiny rule set in a separate namespace.
describe('rules language probes (minifier and compact rules rely on these)', () => {
  let env;
  const V = (e) => ({ '.write': true, '.validate': e });
  const rules = { rules: {
    '.read': true,
    eq3: { $id: V("newData.child('a').val() === newData.child('b').val()") },
    eq2: { $id: V("newData.child('a').val() == newData.child('b').val()") },
    ne3: { $id: V("newData.child('a').val() !== newData.child('b').val()") },
    ne2: { $id: V("newData.child('a').val() != newData.child('b').val()") },
    nullchild: { $id: V("root.child('x').child(newData.child('missing').val()).child('flag').val() === true") },
    nullconcat: { $id: V("root.child('x/' + newData.child('missing').val() + '/flag').val() === true") },
    orShort: { $id: V("true || newData.child('missing').val().matches(/^a$/)") },
    andShort: { $id: V("!(false && newData.child('missing').val().matches(/^a$/))") },
    errDenies: { $id: V("newData.child('missing').val().matches(/^a$/) || true") },
    x: { '.write': true },
  } };
  before(async () => {
    const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
    env = await initializeTestEnvironment({ projectId: 'demo-codehub-probe', database: { rules: JSON.stringify(rules), host, port: Number(port) } });
    await env.withSecurityRulesDisabled((c) => c.database().ref('x').set({ null: { flag: true }, flag: true }));
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

  it('== / != behave exactly like === / !== for every mix of string, number, boolean and null', async () => {
    const vals = ['1', 1, true, false, 0, '', 'true', 'null', 'a', 1.5, undefined];
    let n = 0;
    const diffs = [];
    for (const a of vals) {
      for (const b of vals) {
        const d = { c: 1 };
        if (a !== undefined) d.a = a;
        if (b !== undefined) d.b = b;
        const id = `p${n++}`;
        const r = [await tryWrite(`eq3/${id}`, d), await tryWrite(`eq2/${id}`, d), await tryWrite(`ne3/${id}`, d), await tryWrite(`ne2/${id}`, d)];
        if (r[0] !== r[1] || r[2] !== r[3]) diffs.push([a, b, r]);
        if (r[0] === r[2]) diffs.push(['eq and ne agree', a, b, r]);
      }
    }
    if (diffs.length) throw new Error(`== differs from ===: ${JSON.stringify(diffs)}`);
  });
  it('a null path segment never resolves to a node (no roleId guard needed)', async () => {
    if (await tryWrite('nullchild/p', { c: 1 })) throw new Error('child(null) resolved');
    if (await tryWrite('nullconcat/p', { c: 1 })) throw new Error("'x/' + null resolved");
  });
  it('|| and && short-circuit, and an evaluation error denies the whole rule', async () => {
    if (!(await tryWrite('orShort/p', { c: 1 }))) throw new Error('|| did not short-circuit');
    if (!(await tryWrite('andShort/p', { c: 1 }))) throw new Error('&& did not short-circuit');
    if (await tryWrite('errDenies/p', { c: 1 })) throw new Error('an error did not deny');
  });
});

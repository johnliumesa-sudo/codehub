// Shared fixtures for the Codehub RTDB rules tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

export const RULES_PATH = process.env.RULES_PATH || fileURLToPath(new URL('../../database.rules.json', import.meta.url));
export const TS = { '.sv': 'timestamp' };
export const PROMO = 'SuperSecret-Promo-123-long-enough-32';
export const box = { iv: 'a'.repeat(16), ct: 'Y2lwaGVy' };
export const epk = { kty: 'EC', crv: 'P-256', x: 'xx', y: 'yy' };
export const wrap = { epk, iv: 'b'.repeat(16), ct: 'd3JhcA' };
export { assertFails, assertSucceeds };

let env;
export async function getEnv() {
  if (env) return env;
  const hostPort = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000';
  const [host, port] = hostPort.split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-codehub',
    database: { rules: readFileSync(RULES_PATH, 'utf8'), host, port: Number(port) },
  });
  return env;
}
export async function cleanup() { if (env) await env.cleanup(); env = undefined; }

export function db(uid) {
  return uid ? env.authenticatedContext(uid).database() : env.unauthenticatedContext().database();
}
export async function admin(fn) {
  await env.withSecurityRulesDisabled(async (ctx) => fn(ctx.database()));
}

const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank', 'mallory', 'zoe', 'admin1', 'newbie'];
const member = (role, extra = {}) => ({ role, joinedAt: 1, ...extra });
const perms = (p = {}) => ({ manageChannels: false, manageInvites: false, kick: false, ban: false,
  manageMessages: false, manageRoles: false, timeout: false, viewAudit: false, ...p });
const role = (position, p) => ({ nameEnc: box, color: '#ff0000', position, perms: perms(p), createdAt: 1 });

export function world() {
  const now = Date.now();
  const users = {};
  for (const u of USERS) users[u] = { name: u, color: '#abcdef', createdAt: 1, pubKey: epk };
  const sKeys = {};
  for (const u of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina']) sKeys[u] = wrap;
  return {
    users,
    config: { adminPromo: PROMO },
    admins: { admin1: { at: 1 } },
    adminBadges: { admin1: true },
    servers: {
      s1: {
        meta: { nameEnc: box, ownerId: 'alice', color: '#f00', createdAt: 1 },
        members: {
          alice: member('owner'), bob: member('admin'),
          carol: member('member', { roleId: 'rMod' }), dave: member('member'),
          erin: member('member', { roleId: 'rLow' }), frank: member('member', { roleId: 'rHigh' }),
          gina: member('member', { roleId: 'rBan' }),
        },
        keys: sKeys,
        invites: {
          i1: { createdBy: 'alice', createdAt: 1, expiresAt: 0, maxUses: 0, uses: 0 },
          iExp: { createdBy: 'alice', createdAt: 1, expiresAt: now - 1000, maxUses: 0, uses: 0 },
          iFull: { createdBy: 'alice', createdAt: 1, expiresAt: 0, maxUses: 1, uses: 1 },
        },
        channels: {
          c1: { type: 'text', enc: box, position: 0, createdAt: 1 },
          c2: { type: 'code', enc: box, position: 1, createdAt: 1 },
        },
        bans: { hank: true },
        roles: {
          rMod: role(50, { kick: true, manageRoles: true, timeout: true, manageMessages: true }),
          rLow: role(10, {}),
          rHigh: role(80, {}),
          rBan: role(60, { ban: true }),
        },
      },
    },
    userServers: { alice: { s1: { joinedAt: 1 } }, dave: { s1: { joinedAt: 1 } } },
    messages: { s1: { c1: { m1: { uid: 'dave', ts: 1, iv: box.iv, ct: box.ct } } } },
    audit: { s1: { a1: { by: 'alice', ts: 1, iv: box.iv, ct: box.ct } } },
    collab: { s1: { c2: {
      files: { f1: { enc: box, createdBy: 'alice', createdAt: 1 } },
      checkpoints: { f1: { cp1: { uid: 'dave', ts: 1, iv: box.iv, ct: box.ct } } },
    } } },
    groups: {
      g1: {
        meta: { ownerId: 'alice', nameEnc: box, epoch: 1, createdAt: 1 },
        members: {
          alice: { role: 'owner', joinedAt: 1, addedBy: 'alice' },
          dave: { role: 'member', joinedAt: 1, addedBy: 'alice' },
          erin: { role: 'member', joinedAt: 1, addedBy: 'alice' },
        },
        keys: { 1: { alice: wrap, dave: wrap, erin: wrap } },
      },
    },
    groupMessages: { g1: { gm1: { uid: 'dave', ts: 1, epoch: 1, iv: box.iv, ct: box.ct } } },
    userGroups: { alice: { g1: { addedAt: 1 } }, dave: { g1: { addedAt: 1 } }, erin: { g1: { addedAt: 1 } } },
    codespaces: {
      cs1: {
        meta: { ownerId: 'alice', nameEnc: box, createdAt: 1 },
        members: {
          alice: { role: 'owner', joinedAt: 1, addedBy: 'alice' },
          bob: { role: 'editor', joinedAt: 1, addedBy: 'alice' },
          dave: { role: 'viewer', joinedAt: 1, addedBy: 'alice' },
        },
        keys: { alice: wrap, bob: wrap, dave: wrap },
      },
    },
    userCodespaces: { alice: { cs1: { addedAt: 1 } }, bob: { cs1: { addedAt: 1 } }, dave: { cs1: { addedAt: 1 } } },
    csCollab: { cs1: { files: { f1: { enc: box, createdBy: 'alice', createdAt: 1 } } } },
    shop: { items: {
      itemA: { name: 'Star', desc: 'badge', kind: 'badge', price: 50, data: { glyph: '*' }, active: true, updatedAt: 1, updatedBy: 'admin1' },
      itemBig: { name: 'Gold', desc: 'pricy', kind: 'badge', price: 5000, data: { glyph: '$' }, active: true, updatedAt: 1, updatedBy: 'admin1' },
      itemFree: { name: 'Red', desc: 'free', kind: 'nameColor', price: 0, data: { color: '#ff0000' }, active: true, updatedAt: 1, updatedBy: 'admin1' },
      itemOff: { name: 'Old', desc: 'off', kind: 'badge', price: 10, data: { glyph: 'o' }, active: false, updatedAt: 1, updatedBy: 'admin1' },
      itemTheme: { name: 'Dark', desc: 't', kind: 'theme', price: 10, data: { tokens: { bg0: '#000000' } }, active: true, updatedAt: 1, updatedBy: 'admin1' },
    } },
    wallets: {
      dave: { balance: 100, lastClaim: now - 1000 },
      erin: { balance: 20, lastClaim: now - 21 * 3600 * 1000 },
    },
    inventory: { erin: { itemA: { at: 1, price: 50 } } },
    games: { gm1: { ownerId: 'dave', title: 'Pong', desc: 'd', createdAt: 1, updatedAt: 1, likes: 0, size: 10 } },
    gameCode: { gm1: { html: '<p>hi</p>' } },
    publishLog: { dave: now - 120000, erin: now - 1000 },
    reports: { r1: { by: 'dave', kind: 'game', target: 'gm1', reason: 'spam', ts: 1 } },
    announcements: { current: { text: 'hello', level: 'info', ts: 1, by: 'admin1' } },
    blocks: { zoe: { mallory: true } },
    verified: { dave: { erin: { fp: 'abc', ts: 1 } } },
    notifPrefs: { dave: { settings: { desktop: true, preview: false, mentionsOnly: false } } },
    snippets: { dave: { sn1: { ts: 1, iv: box.iv, ct: box.ct } } },
    vaults: { dave: { salt: 's', iter: 1, wrappedPriv: box } },
    dms: { dave_zoe: { members: { dave: true, zoe: true } } },
  };
}

export async function reset(patch) {
  const w = world();
  if (patch) patch(w);
  await admin((d) => d.ref().set(w));
}

/** Attachment meta write with the attLog entry the rules require in the same update. */
export async function putAttMeta(u, base, m, logOverride) {
  let prev = null;
  await admin(async (d) => { prev = (await d.ref(`attLog/${u}`).get()).val(); });
  const attId = base.split('/')[2];
  const log = logOverride || (prev ? { ws: prev.ws, n: prev.n + 1, id: attId, at: TS } : { ws: TS, n: 1, id: attId, at: TS });
  return db(u).ref().update({ [`${base}/meta`]: m, [`attLog/${u}`]: log });
}

// Bots: database access through the generic rules blocks (no rules of their own).
//   pub/bots/{botId}              public directory entry { def, ver, name, desc, glyph, created, img?, imgType?, by, ts }
//   sconf/{sid}/bots/{botId}      pinned install { def, ver, by (publisher), author (installer), at, img?, imgType? }
//   udata/{me}/botWelcome/{sid}~{botId} = ms   the welcome message for that bot was handled for me
// Local only (localStorage, this browser): per-command {count} counters and trigger cooldowns.
import { get, ref, remove, runTransaction, serverTimestamp, set, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { createSharedStore, useShared } from '../../../lib/media/cache.js';
import { myUid, pubRef, putPub, sconfRef, udataPath, updatePub } from '../../../lib/ext/store.js';
import { decryptServerName } from '../../../lib/servers.js';
import { onLock } from '../../../lib/keystore.js';
import { BOT_LIMITS, cleanImg, parseInstalled, serializeBotDef } from './schema.js';

export const PUB_KIND = 'bots';
export const FEAT = 'bots';
export const WELCOME_FEAT = 'botWelcome';

// ---------- directory (pub/bots) ----------

function entryFields(def, image) {
  const img = cleanImg(image || {});
  return {
    def: serializeBotDef(def),
    name: def.name,
    desc: def.desc,
    glyph: def.glyph,
    img: img ? img.img : null,
    imgType: img ? img.imgType : null,
  };
}

/** Publish a new bot (version 1). Resolves to its id. */
export async function publishBot(def, image) {
  const fields = entryFields(def, image);
  if (!fields.img) {
    delete fields.img;
    delete fields.imgType;
  }
  return putPub(PUB_KIND, undefined, { ...fields, ver: 1, created: serverTimestamp() });
}

/** Save a new version of my bot (`prevVer` + 1). */
export function saveBotVersion(id, prevVer, def, image) {
  return updatePub(PUB_KIND, id, { ...entryFields(def, image), ver: (Number.isInteger(prevVer) ? prevVer : 0) + 1 });
}

/** Remove a bot from the directory (its publisher, or an app admin). Installed copies keep working. */
export function unpublishBot(id) {
  return remove(pubRef(PUB_KIND, id));
}

// ---------- installs (sconf/{sid}/bots) ----------

function installFields(entry) {
  const img = entry.image ? cleanImg(entry.image) : null;
  return {
    def: serializeBotDef(entry.def),
    ver: entry.ver,
    by: entry.by,
    img: img ? img.img : null,
    imgType: img ? img.imgType : null,
  };
}

/** Install a validated directory entry into a server (pins this version). */
export async function installBot(sid, entry) {
  const fields = installFields(entry);
  if (!fields.img) {
    delete fields.img;
    delete fields.imgType;
  }
  await set(sconfRef(sid, FEAT, entry.id), { ...fields, author: myUid(), at: serverTimestamp() });
}

/** Re-pin an installed bot to the directory's current version (keeps the install time). */
export function updateInstalledBot(sid, entry) {
  return update(sconfRef(sid, FEAT, entry.id), { ...installFields(entry), author: myUid() });
}

export function uninstallBot(sid, botId) {
  return remove(sconfRef(sid, FEAT, botId));
}

/** Installed bots per server, one shared listener per server: [{ id, def, ver, author, by, at, image }]. */
export const installedStore = createSharedStore((sid) => `sconf/${sid}/${FEAT}`, (raw) => parseInstalled(raw));

/** React: the installed bots of `sid` (null while loading, when none are installed, or without access). */
export function useInstalledBots(sid) {
  return useShared(installedStore, sid || null);
}

/** Synchronous: the installed bots of `sid` if already loaded (by a mounted host), else []. */
export function peekInstalled(sid) {
  return (sid && installedStore.peek(sid)) || [];
}

// ---------- welcome markers (udata/{me}/botWelcome) ----------

export const welcomeKey = (sid, botId) => `${sid}~${botId}`;

/** True if my welcome for this bot in this server was already handled. */
export async function welcomeDone(sid, botId) {
  const snap = await get(ref(db, udataPath(myUid(), WELCOME_FEAT, welcomeKey(sid, botId))));
  return snap.exists();
}

/**
 * Atomically claim my welcome for a bot (so two tabs can't both post it). Resolves true if this
 * call claimed it, false if it was already handled.
 */
export async function claimWelcome(sid, botId) {
  const r = ref(db, udataPath(myUid(), WELCOME_FEAT, welcomeKey(sid, botId)));
  const res = await runTransaction(r, (cur) => (cur === null ? Date.now() : undefined), { applyLocally: false });
  return res.committed;
}

// ---------- server context ----------

const NAME_TTL = 5 * 60 * 1000;
const serverNames = new Map(); // sid -> { at, p: Promise<string> }
onLock(() => serverNames.clear());

/** The decrypted server name (cached for a few minutes, cleared on lock; '' if it can't be read). */
export function serverName(sid) {
  if (!sid) return Promise.resolve('');
  const hit = serverNames.get(sid);
  if (hit && Date.now() - hit.at < NAME_TTL) return hit.p;
  const p = get(ref(db, `servers/${sid}/meta/nameEnc`))
    .then((s) => (s.exists() ? decryptServerName(sid, s.val()) : ''))
    .catch(() => '');
  p.then((name) => { if (!name) serverNames.delete(sid); });
  serverNames.set(sid, { at: Date.now(), p });
  return p;
}

/** The server's first text channel (the one a new member lands in), by the sidebar's order. */
export async function firstTextChannel(sid) {
  const snap = await get(ref(db, `servers/${sid}/channels`));
  const v = snap.val();
  if (!v || typeof v !== 'object') return null;
  const list = Object.entries(v)
    .filter(([, ch]) => ch && typeof ch === 'object' && ch.type !== 'code' && ch.type !== 'voice')
    .map(([cid, ch]) => ({ cid, position: typeof ch.position === 'number' ? ch.position : 0, createdAt: typeof ch.createdAt === 'number' ? ch.createdAt : 0 }))
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.cid.localeCompare(b.cid));
  return list[0]?.cid || null;
}

/** True if an app admin configured GIPHY (appConfig/giphyKey), i.e. the GIF picker can open. */
export async function gifsEnabled() {
  try {
    const v = (await get(ref(db, 'appConfig/giphyKey'))).val();
    return typeof v === 'string' && /^[A-Za-z0-9]{8,64}$/.test(v);
  } catch {
    return false;
  }
}

// ---------- local state (this browser only) ----------

const COUNT_KEY = 'codehub.bots.counts';
const COOL_KEY = 'codehub.bots.cooldowns';

function readMap(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function writeMap(key, map) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* storage full or disabled: counters/cooldowns just don't persist */
  }
}

/** Increment and return this browser's counter for a bot command or trigger in a server. */
export function bumpCount(sid, botId, name) {
  const map = readMap(COUNT_KEY);
  const k = `${sid}/${botId}/${name}`;
  const n = (Number.isFinite(map[k]) ? map[k] : 0) + 1;
  map[k] = n;
  const keys = Object.keys(map);
  if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach((x) => delete map[x]);
  writeMap(COUNT_KEY, map);
  return n;
}

/** True if this browser answered the trigger in this channel within its cooldown. */
export function coolingLocally(scope, botId, trigger, now = Date.now()) {
  const at = readMap(COOL_KEY)[`${scope}/${botId}/${trigger.id}`];
  return Number.isFinite(at) && now - at < trigger.cooldown * 1000;
}

/** Remember that this browser answered a trigger now (old entries are pruned). */
export function markCooldown(scope, botId, trigger, now = Date.now()) {
  const map = readMap(COOL_KEY);
  for (const [k, at] of Object.entries(map)) if (!Number.isFinite(at) || now - at > BOT_LIMITS.cooldownMax * 1000) delete map[k];
  map[`${scope}/${botId}/${trigger.id}`] = now;
  writeMap(COOL_KEY, map);
}

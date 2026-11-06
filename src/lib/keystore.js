// In-memory key store for the unlocked session. Nothing here is persisted unencrypted.
import { get, onValue, ref, set, update } from 'firebase/database';
import { db } from './firebase.js';
import {
  decryptJSON,
  decryptText,
  deriveDmKey,
  deriveVaultKey,
  encryptJSON,
  encryptText,
  exportRoomKey,
  generateIdentity,
  generateRoomKey,
  importPrivateKey,
  importRoomKey,
  unwrapKey,
  wrapKeyFor,
} from './crypto.js';

const state = {
  uid: null,
  vaultKey: null,
  privKey: null,
  pubJwk: null,
  serverKeys: new Map(), // sid -> Promise<CryptoKey>
  dmKeys: new Map(), // dmId -> Promise<CryptoKey>
  pubKeys: new Map(), // uid -> Promise<jwk>
};

export const wrapContext = (sid, uid) => `server:${sid}:${uid}`;

export function isUnlocked() {
  return !!state.privKey;
}

export function myPublicKey() {
  return state.pubJwk;
}

const lockHandlers = new Set();

/** Register a callback run on lock() (e.g. to clear a module-level key cache). Returns unsubscribe. */
export function onLock(fn) {
  lockHandlers.add(fn);
  return () => lockHandlers.delete(fn);
}

export function currentUid() {
  return state.uid;
}

export function lock() {
  state.uid = null;
  state.vaultKey = null;
  state.privKey = null;
  state.pubJwk = null;
  state.serverKeys.clear();
  state.dmKeys.clear();
  state.pubKeys.clear();
  for (const fn of lockHandlers) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/*
 * Vault modes
 *  - auto (default): a random AES key is stored next to the wrapped private key at
 *    vaults/{uid}/autoKey. Only the signed-in owner can read it (rules), so signing in is enough
 *    to unlock. Trade-off: anyone with admin access to the Firebase project could read both.
 *  - legacy passphrase vaults ({salt, iter}) from before auto-unlock. They are unlocked once with
 *    the old passphrase and converted to auto (migrateLegacyVault).
 */

/** 'none' | 'auto' | 'passphrase' */
export async function vaultMode(uid) {
  const v = (await get(ref(db, `vaults/${uid}`))).val();
  if (!v?.wrappedPriv) return 'none';
  return v.autoKey ? 'auto' : 'passphrase';
}

async function writeAutoVault(uid, privJwk, ghToken) {
  const vaultKey = await generateRoomKey();
  const vault = {
    autoKey: await exportRoomKey(vaultKey),
    wrappedPriv: await encryptJSON(vaultKey, privJwk, `vault-priv:${uid}`),
  };
  if (ghToken) vault.ghToken = await encryptText(vaultKey, ghToken, `vault-gh:${uid}`);
  await set(ref(db, `vaults/${uid}`), vault);
  return vaultKey;
}

/** First sign-in (or "start over"): new identity in an auto vault, public key published. */
export async function createVault(uid) {
  const { pubJwk, privJwk } = await generateIdentity();
  const vaultKey = await writeAutoVault(uid, privJwk, null);
  await update(ref(db, `users/${uid}`), { pubKey: pubJwk });
  await loadSession(uid, vaultKey, privJwk, pubJwk);
}

/** Unlock an auto vault. Creates one when the user has none. Returns false for a legacy vault. */
export async function openVault(uid) {
  const v = (await get(ref(db, `vaults/${uid}`))).val();
  if (!v?.wrappedPriv) {
    await createVault(uid);
    return true;
  }
  if (!v.autoKey) return false;
  const vaultKey = await importRoomKey(v.autoKey);
  const privJwk = await decryptJSON(vaultKey, v.wrappedPriv, `vault-priv:${uid}`);
  await finishUnlock(uid, vaultKey, privJwk);
  return true;
}

/** Unlock a legacy passphrase vault and convert it to auto-unlock. Throws 'Wrong passphrase'. */
export async function migrateLegacyVault(uid, passphrase) {
  const vault = (await get(ref(db, `vaults/${uid}`))).val();
  if (!vault) throw new Error('No vault found');
  const oldKey = await deriveVaultKey(passphrase, vault.salt, vault.iter);
  let privJwk;
  try {
    privJwk = await decryptJSON(oldKey, vault.wrappedPriv, `vault-priv:${uid}`);
  } catch {
    throw new Error('Wrong passphrase');
  }
  let ghToken = null;
  if (vault.ghToken) ghToken = await decryptText(oldKey, vault.ghToken, `vault-gh:${uid}`).catch(() => null);
  const vaultKey = await writeAutoVault(uid, privJwk, ghToken);
  await finishUnlock(uid, vaultKey, privJwk);
}

async function finishUnlock(uid, vaultKey, privJwk) {
  const pubJwk = { kty: 'EC', crv: 'P-256', x: privJwk.x, y: privJwk.y };
  await loadSession(uid, vaultKey, privJwk, pubJwk);
  // Self-heal: if publishing the public key failed during createVault (or it was clobbered),
  // republish it so others can wrap server keys for us and derive DM keys.
  try {
    const cur = (await get(ref(db, `users/${uid}/pubKey`))).val();
    if (!cur || cur.x !== pubJwk.x || cur.y !== pubJwk.y) await update(ref(db, `users/${uid}`), { pubKey: pubJwk });
  } catch (e) {
    console.warn('[keystore] could not verify published public key', e);
  }
}

async function loadSession(uid, vaultKey, privJwk, pubJwk) {
  state.uid = uid;
  state.vaultKey = vaultKey;
  state.privKey = await importPrivateKey(privJwk);
  state.pubJwk = pubJwk;
  state.pubKeys.set(uid, Promise.resolve(pubJwk));
}

function requireUnlocked() {
  if (!state.privKey) throw new Error('Vault is locked');
}

// ---------- Public keys ----------

export function getPublicKey(uid) {
  if (!state.pubKeys.has(uid)) {
    const p = get(ref(db, `users/${uid}/pubKey`)).then((s) => {
      if (!s.exists()) throw new Error('User has no encryption key yet');
      return s.val();
    });
    p.catch(() => state.pubKeys.delete(uid));
    state.pubKeys.set(uid, p);
  }
  return state.pubKeys.get(uid);
}

// ---------- Server (room) keys ----------

export function getServerKey(sid) {
  requireUnlocked();
  if (!state.serverKeys.has(sid)) {
    const p = get(ref(db, `servers/${sid}/keys/${state.uid}`)).then(async (s) => {
      if (!s.exists()) throw new Error('No key for this server');
      return unwrapKey(state.privKey, s.val(), wrapContext(sid, state.uid));
    });
    p.catch(() => state.serverKeys.delete(sid));
    state.serverKeys.set(sid, p);
  }
  return state.serverKeys.get(sid);
}

export function cacheServerKey(sid, key) {
  state.serverKeys.set(sid, Promise.resolve(key));
}

// Wrap a server key for a user (they must have published a public key).
export async function wrapServerKeyFor(sid, uid, key) {
  const pub = await getPublicKey(uid);
  return wrapKeyFor(pub, key, wrapContext(sid, uid));
}

// Accept a key from an invite fragment and store a personal wrapped copy.
export async function importInviteKey(sid, keyB64) {
  requireUnlocked();
  const key = await importRoomKey(keyB64);
  const wrapped = await wrapKeyFor(state.pubJwk, key, wrapContext(sid, state.uid));
  cacheServerKey(sid, key);
  return { key, wrapped };
}

// ---------- Generic key wrapping (groups, codespaces) ----------

export async function unwrapForMe(wrapped, context) {
  requireUnlocked();
  return unwrapKey(state.privKey, wrapped, context);
}

export async function wrapFor(uid, key, context) {
  return wrapKeyFor(await getPublicKey(uid), key, context);
}

// ---------- DM keys ----------

export function getDmKey(dmId, peerUid) {
  requireUnlocked();
  if (!state.dmKeys.has(dmId)) {
    const p = getPublicKey(peerUid).then((pub) => deriveDmKey(state.privKey, pub, dmId));
    p.catch(() => state.dmKeys.delete(dmId));
    state.dmKeys.set(dmId, p);
  }
  return state.dmKeys.get(dmId);
}

// ---------- Secrets in vault ----------

export async function vaultEncryptJSON(value, aad) {
  requireUnlocked();
  return encryptJSON(state.vaultKey, value, aad);
}

export async function vaultDecryptJSON(box, aad) {
  requireUnlocked();
  return decryptJSON(state.vaultKey, box, aad);
}

export async function saveGithubToken(token) {
  requireUnlocked();
  const path = `vaults/${state.uid}/ghToken`;
  if (!token) return set(ref(db, path), null);
  return set(ref(db, path), await encryptText(state.vaultKey, token, `vault-gh:${state.uid}`));
}

export async function loadGithubToken() {
  requireUnlocked();
  const s = await get(ref(db, `vaults/${state.uid}/ghToken`));
  if (!s.exists()) return null;
  return decryptText(state.vaultKey, s.val(), `vault-gh:${state.uid}`);
}

/**
 * Live GitHub token: cb(token|null) now and whenever it is saved/cleared (e.g. from Settings
 * while a workspace is open). Returns unsubscribe.
 */
export function subscribeGithubToken(cb) {
  requireUnlocked();
  const uid = state.uid;
  const vaultKey = state.vaultKey;
  let seq = 0;
  return onValue(
    ref(db, `vaults/${uid}/ghToken`),
    (s) => {
      const my = ++seq;
      if (!s.exists()) {
        cb(null);
        return;
      }
      decryptText(vaultKey, s.val(), `vault-gh:${uid}`).then(
        (t) => my === seq && cb(t || null),
        () => my === seq && cb(null),
      );
    },
    () => cb(null),
  );
}

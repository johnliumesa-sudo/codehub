// In-memory key store for the unlocked session. Nothing here is persisted unencrypted.
import { get, onValue, ref, set, update } from 'firebase/database';
import { db } from './firebase.js';
import {
  PBKDF2_ITERATIONS,
  b64u,
  decryptJSON,
  decryptText,
  deriveDmKey,
  deriveVaultKey,
  encryptJSON,
  encryptText,
  generateIdentity,
  importPrivateKey,
  importRoomKey,
  randomBytes,
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

export function lock() {
  state.uid = null;
  state.vaultKey = null;
  state.privKey = null;
  state.pubJwk = null;
  state.serverKeys.clear();
  state.dmKeys.clear();
  state.pubKeys.clear();
}

export async function hasVault(uid) {
  return (await get(ref(db, `vaults/${uid}/salt`))).exists();
}

// First-time setup: create identity + vault, publish public key.
export async function createVault(uid, passphrase) {
  const salt = b64u(randomBytes(16));
  const vaultKey = await deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS);
  const { pubJwk, privJwk } = await generateIdentity();
  const wrappedPriv = await encryptJSON(vaultKey, privJwk, `vault-priv:${uid}`);
  await set(ref(db, `vaults/${uid}`), { salt, iter: PBKDF2_ITERATIONS, wrappedPriv });
  await update(ref(db, `users/${uid}`), { pubKey: pubJwk });
  await loadSession(uid, vaultKey, privJwk, pubJwk);
}

// Throws if the passphrase is wrong (AES-GCM auth failure).
export async function unlockVault(uid, passphrase) {
  const vault = (await get(ref(db, `vaults/${uid}`))).val();
  if (!vault) throw new Error('No vault found');
  const vaultKey = await deriveVaultKey(passphrase, vault.salt, vault.iter);
  let privJwk;
  try {
    privJwk = await decryptJSON(vaultKey, vault.wrappedPriv, `vault-priv:${uid}`);
  } catch {
    throw new Error('Wrong passphrase');
  }
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

// Re-encrypt the private key under a new passphrase.
export async function changePassphrase(passphrase) {
  requireUnlocked();
  const uid = state.uid;
  const vault = (await get(ref(db, `vaults/${uid}`))).val();
  const privJwk = await decryptJSON(state.vaultKey, vault.wrappedPriv, `vault-priv:${uid}`);
  const salt = b64u(randomBytes(16));
  const vaultKey = await deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS);
  const updates = { salt, iter: PBKDF2_ITERATIONS, wrappedPriv: await encryptJSON(vaultKey, privJwk, `vault-priv:${uid}`) };
  if (vault.ghToken) {
    const token = await decryptText(state.vaultKey, vault.ghToken, `vault-gh:${uid}`);
    updates.ghToken = await encryptText(vaultKey, token, `vault-gh:${uid}`);
  }
  await set(ref(db, `vaults/${uid}`), updates);
  state.vaultKey = vaultKey;
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

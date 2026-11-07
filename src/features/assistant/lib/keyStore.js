// The user's Anthropic API key and assistant preferences, kept ONLY in this browser's localStorage
// (never in the database), one entry per Codehub account:
//   codehub.assistant.key.<uid>    { v: 1, mode: 'plain', key }
//                                  { v: 1, mode: 'locked', salt, iter, iv, ct }   (PBKDF2-SHA256 -> AES-256-GCM)
//   codehub.assistant.prefs.<uid>  { model, effort, lang, ctxCount, draftContext }
// A locked key is decrypted with the passphrase once per page session and held in memory only.
// AAD for the locked key: `assistant-key:<uid>` (binds the ciphertext to the account it belongs to).
import { PBKDF2_ITERATIONS, b64u, decryptText, deriveVaultKey, encryptText, randomBytes } from '../../../lib/crypto.js';
import { cleanPrefs } from './config.js';

export const KEY_PREFIX = 'codehub.assistant.key.';
export const PREFS_PREFIX = 'codehub.assistant.prefs.';
export const MIN_PASSPHRASE = 8;
export const keyAad = (uid) => `assistant-key:${uid}`;

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // blocked storage (privacy mode)
  }
}

function read(storage, k) {
  try {
    const raw = storage?.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(storage, k, v) {
  if (!storage) throw new Error("This browser won't let Codehub use local storage, so the key can't be saved.");
  storage.setItem(k, JSON.stringify(v));
}

/** Problems with a pasted key, or '' if it looks usable. */
export function checkApiKey(key) {
  const k = String(key ?? '').trim();
  if (!k) return 'Paste your Anthropic API key.';
  if (/\s/.test(k)) return 'The key must not contain spaces or line breaks.';
  if (!/^[\x21-\x7e]+$/.test(k)) return 'That doesn’t look like an API key.';
  if (k.length < 20 || k.length > 400) return 'That doesn’t look like an API key.';
  if (/^sk-ant-admin/i.test(k)) return 'That is an Admin API key; it can’t send messages. Use a regular API key.';
  return '';
}

/** "sk-ant-…wxyz" for display. */
export function maskKey(key) {
  const k = String(key || '');
  if (k.length < 12) return '••••';
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

/** The stored record (validated), or null. */
export function loadRecord(uid, storage = defaultStorage()) {
  if (!uid) return null;
  const r = read(storage, KEY_PREFIX + uid);
  if (!r || r.v !== 1) return null;
  if (r.mode === 'plain' && typeof r.key === 'string' && r.key) return { v: 1, mode: 'plain', key: r.key, hint: maskKey(r.key) };
  if (r.mode === 'locked' && ['salt', 'iv', 'ct'].every((f) => typeof r[f] === 'string' && r[f]) && Number.isInteger(r.iter) && r.iter >= 1) {
    return { v: 1, mode: 'locked', salt: r.salt, iter: r.iter, iv: r.iv, ct: r.ct, hint: typeof r.hint === 'string' ? r.hint.slice(0, 16) : '' };
  }
  return null;
}

/** Save a key, optionally locked with a passphrase. Returns the stored record. */
export async function saveKey(uid, apiKey, { passphrase = '', storage = defaultStorage(), iterations = PBKDF2_ITERATIONS } = {}) {
  if (!uid) throw new Error('Not signed in.');
  const key = String(apiKey ?? '').trim();
  const bad = checkApiKey(key);
  if (bad) throw new Error(bad);
  if (!passphrase) {
    const rec = { v: 1, mode: 'plain', key };
    write(storage, KEY_PREFIX + uid, rec);
    return loadRecord(uid, storage);
  }
  if (String(passphrase).length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  const salt = b64u(randomBytes(16));
  const aes = await deriveVaultKey(String(passphrase), salt, iterations);
  const box = await encryptText(aes, key, keyAad(uid));
  // The hint keeps only the last 4 characters, so it never reveals the key.
  const rec = { v: 1, mode: 'locked', salt, iter: iterations, iv: box.iv, ct: box.ct, hint: `…${key.slice(-4)}` };
  write(storage, KEY_PREFIX + uid, rec);
  return loadRecord(uid, storage);
}

/** Decrypt a locked key. Throws "Wrong passphrase" on failure. */
export async function unlockKey(uid, passphrase, { storage = defaultStorage() } = {}) {
  const rec = loadRecord(uid, storage);
  if (!rec) throw new Error('No API key is saved in this browser.');
  if (rec.mode === 'plain') return rec.key;
  if (!passphrase) throw new Error('Enter your passphrase.');
  try {
    const aes = await deriveVaultKey(String(passphrase), rec.salt, rec.iter);
    return await decryptText(aes, { iv: rec.iv, ct: rec.ct }, keyAad(uid));
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

/** Remove the key from this browser. */
export function forgetKey(uid, storage = defaultStorage()) {
  try {
    storage?.removeItem(KEY_PREFIX + uid);
  } catch {
    /* storage blocked: nothing was saved */
  }
}

export function loadPrefs(uid, { storage = defaultStorage(), navLang } = {}) {
  return cleanPrefs(uid ? read(storage, PREFS_PREFIX + uid) : null, navLang);
}

export function savePrefs(uid, prefs, { storage = defaultStorage(), navLang } = {}) {
  const clean = cleanPrefs(prefs, navLang);
  if (uid) {
    try {
      write(storage, PREFS_PREFIX + uid, clean);
    } catch {
      /* not persisted; still used for this session */
    }
  }
  return clean;
}

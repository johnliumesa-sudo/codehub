// End-to-end encryption primitives (WebCrypto only).
//
// - Vault key: PBKDF2-SHA256(passphrase, salt, 600k) -> AES-256-GCM. Encrypts the user's
//   private identity key and secrets (GitHub token). Never leaves the device.
// - Identity: ECDH P-256 key pair. Public JWK is published at users/{uid}/pubKey.
// - Room keys: random AES-256-GCM per server. Shared to members via ECIES
//   (ephemeral ECDH -> HKDF-SHA256 -> AES-GCM) or via the #fragment of an invite link.
// - DM keys: ECDH(myPriv, peerPub) -> HKDF-SHA256(info = "codehub-dm:" + dmId).
//
// Every ciphertext is stored as { iv, ct } (base64url strings). AAD binds a ciphertext
// to its location (e.g. "msg:{sid}/{cid}/{mid}") so the server can't move it elsewhere.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000;

export function b64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function randomId(bytes = 16) {
  return b64u(randomBytes(bytes));
}

// ---------- AES-GCM ----------

export async function encryptBytes(key, bytes, aad = '') {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
  return { iv: b64u(iv), ct: b64u(ct) };
}

export async function decryptBytes(key, box, aad = '') {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(box.iv), additionalData: enc.encode(aad) },
    key,
    unb64u(box.ct),
  );
  return new Uint8Array(pt);
}

export async function encryptJSON(key, value, aad = '') {
  return encryptBytes(key, enc.encode(JSON.stringify(value)), aad);
}

export async function decryptJSON(key, box, aad = '') {
  return JSON.parse(dec.decode(await decryptBytes(key, box, aad)));
}

export async function encryptText(key, text, aad = '') {
  return encryptBytes(key, enc.encode(text), aad);
}

export async function decryptText(key, box, aad = '') {
  return dec.decode(await decryptBytes(key, box, aad));
}

// ---------- Vault (passphrase) ----------

export async function deriveVaultKey(passphrase, saltB64, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64u(saltB64), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------- Identity (ECDH P-256) ----------

export async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubJwk = await subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await subtle.exportKey('jwk', pair.privateKey);
  return { pubJwk: publicJwk(pubJwk), privJwk };
}

function publicJwk(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export async function importPrivateKey(privJwk) {
  return subtle.importKey('jwk', privJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export async function importPublicKey(pubJwk) {
  return subtle.importKey('jwk', publicJwk(pubJwk), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function hkdfAesKey(sharedBits, salt, info, usages = ['encrypt', 'decrypt']) {
  const ikm = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

async function ecdhBits(privKey, pubKey) {
  return subtle.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
}

// ---------- Room keys ----------

export async function generateRoomKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportRoomKey(key) {
  return b64u(await subtle.exportKey('raw', key));
}

export async function importRoomKey(b64) {
  const raw = unb64u(b64);
  if (raw.length !== 32) throw new Error('Invalid room key');
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// ECIES: wrap a room key so only the holder of recipientPubJwk's private key can read it.
// `context` (e.g. "server:{sid}:{uid}") is bound into HKDF info and AAD.
export async function wrapKeyFor(recipientPubJwk, roomKey, context) {
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recipient = await importPublicKey(recipientPubJwk);
  const bits = await ecdhBits(eph.privateKey, recipient);
  const kek = await hkdfAesKey(bits, new Uint8Array(32), 'codehub-wrap:' + context);
  const raw = new Uint8Array(await subtle.exportKey('raw', roomKey));
  const box = await encryptBytes(kek, raw, context);
  const epk = publicJwk(await subtle.exportKey('jwk', eph.publicKey));
  return { epk, iv: box.iv, ct: box.ct };
}

export async function unwrapKey(myPrivKey, wrapped, context) {
  const eph = await importPublicKey(wrapped.epk);
  const bits = await ecdhBits(myPrivKey, eph);
  const kek = await hkdfAesKey(bits, new Uint8Array(32), 'codehub-wrap:' + context);
  const raw = await decryptBytes(kek, { iv: wrapped.iv, ct: wrapped.ct }, context);
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// ---------- DMs ----------

export function dmIdFor(uidA, uidB) {
  return [uidA, uidB].sort().join('_');
}

export async function deriveDmKey(myPrivKey, peerPubJwk, dmId) {
  const peer = await importPublicKey(peerPubJwk);
  const bits = await ecdhBits(myPrivKey, peer);
  return hkdfAesKey(bits, new Uint8Array(32), 'codehub-dm:' + dmId);
}

// ---------- Verification ----------

// Human-comparable safety number for a pair of identity keys (order independent).
export async function safetyNumber(pubJwkA, pubJwkB) {
  const a = `${pubJwkA.x}.${pubJwkA.y}`;
  const b = `${pubJwkB.x}.${pubJwkB.y}`;
  const joined = [a, b].sort().join('|');
  const digest = new Uint8Array(await subtle.digest('SHA-256', enc.encode(joined)));
  const groups = [];
  for (let i = 0; i < 12; i++) {
    const n = ((digest[i * 2] << 8) | digest[i * 2 + 1]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}

export async function keyFingerprint(pubJwk) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', enc.encode(`${pubJwk.x}.${pubJwk.y}`)));
  return Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join(':');
}

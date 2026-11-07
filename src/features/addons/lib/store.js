// Add-on data in the generic rules blocks (Firebase side). Paths:
//   pub/addons/{id}                       manifest (public, plaintext)        see manifest.js
//   pub/addonCode/{id}                    { code, sha, by, ts } (public)
//   udata/{me}/addons/{id}                personal install { sha, perms, at, v, name, icon, auto? }
//   udata/{me}/addonPin/{id}              pinned code copy { sha, n, c0.. } (what I approved)
//   udata/{me}/addonStore/{key}           add-on storage, sealed with my vault key { iv, n, c0.. }
//                                         key = {id} (personal) or {sid}~{id} (server add-on)
//                                         AAD `addonstore:{uid}/{key}`
//   udata/{me}/addonConsent/{sid}~{id}    my consent to a server add-on { perms, sha, auto?, at }
//   sconf/{sid}/addons/{id}               server install { sha, perms, by, at, v, name, icon }
//   sconf/{sid}/addonPin/{id}             the server's pinned code copy { sha, n, c0.. }
import { useMemo } from 'react';
import { get, push, ref, serverTimestamp, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import {
  commitPubCreate, myUid, openForMe, pubCreateStamp, pubPath, pubRef, sconfPath, sealForMe, udataPath, usePub, useSconf, useUdata,
} from '../../../lib/ext/store.js';
import { packChunks, unpackChunks } from './chunks.js';
import { sha256Hex } from './hash.js';
import {
  consentKey, parseCodeRecord, parseConsent, parseInstalls, parseManifest, permsToString, utf8Length,
} from './manifest.js';

export const FEAT = Object.freeze({ installs: 'addons', pins: 'addonPin', store: 'addonStore', consent: 'addonConsent' });

const fail = (msg) => {
  throw new Error(msg);
};

// ---------- directory (pub) ----------

/**
 * Publish a new add-on (id omitted) or replace my existing one. value = validateDraft(...).value.
 * A new add-on stamps the shared one-per-minute publish window (pubCreateStamp); `stamp: false` is for
 * app admins seeding the first-party examples (the rules exempt them).
 */
export async function publishAddon(id, value, { seed, stamp = true } = {}) {
  const uid = myUid();
  const sha = await sha256Hex(value.code);
  const addonId = id || push(pubRef('addons')).key;
  const manifest = {
    name: value.name,
    icon: value.icon,
    version: value.version,
    sha,
    size: utf8Length(value.code),
    by: uid,
    ts: serverTimestamp(),
  };
  if (value.desc) manifest.desc = value.desc;
  const perms = permsToString(value.perms);
  if (perms) manifest.perms = perms;
  if (seed) manifest.seed = seed;
  const patch = {
    [pubPath('addons', addonId)]: manifest,
    [pubPath('addonCode', addonId)]: { code: value.code, sha, by: uid, ts: serverTimestamp() },
  };
  if (id) await update(ref(db), patch);
  else await commitPubCreate(stamp ? { ...patch, ...pubCreateStamp(addonId) } : patch);
  return { id: addonId, sha };
}

/** Remove an add-on and its code (the publisher, or an app admin). */
export function unpublishAddon(id) {
  return update(ref(db), { [pubPath('addons', id)]: null, [pubPath('addonCode', id)]: null });
}

/**
 * Load a published add-on and check it: manifest valid, code record by the same account, the
 * code's SHA-256 equal to the sha in both records. Resolves to { manifest, code }.
 */
export async function loadAddon(id) {
  const [ms, cs] = await Promise.all([get(pubRef('addons', id)), get(pubRef('addonCode', id))]);
  const manifest = parseManifest(id, ms.val());
  if (!manifest) fail('This add-on is no longer published (or its listing is invalid).');
  const rec = parseCodeRecord(cs.val());
  if (!rec) fail('The add-on’s code is missing or invalid.');
  if (rec.by !== manifest.by) fail('The code and the listing were published by different accounts, so Codehub refused to load it.');
  if (rec.sha !== manifest.sha) fail('The listing and the code don’t match yet (the publisher may be mid-update). Try again in a moment.');
  if ((await sha256Hex(rec.code)) !== rec.sha) fail('The code doesn’t match its checksum, so Codehub refused to load it.');
  return { manifest, code: rec.code };
}

/** Every valid manifest in a pub/addons snapshot value (newest first). */
export function manifestsOf(items) {
  return (items || []).map((it) => parseManifest(it.id, it)).filter(Boolean).sort((a, b) => b.ts - a.ts);
}

/** Live directory: { loading, error, list } (the newest `last` entries, validated). */
export function useDirectory(last = 300) {
  const st = usePub('addons', undefined, { last });
  const list = useMemo(() => manifestsOf(st.items), [st.items]);
  return { loading: st.loading, error: st.error, list };
}

/** Live list of one publisher's add-ons. */
export function usePublishedBy(uid) {
  const st = usePub(uid ? 'addons' : null, undefined, { by: uid || undefined });
  const list = useMemo(() => manifestsOf(st.items), [st.items]);
  return { loading: st.loading, error: st.error, list };
}

/** Live manifest of one add-on (null when gone or invalid). */
export function useManifest(id) {
  const st = usePub(id ? 'addons' : null, id || undefined);
  const manifest = useMemo(() => (id ? parseManifest(id, st.value) : null), [id, st.value]);
  return { loading: st.loading, manifest };
}

// ---------- pinned code ----------

function installRecord(manifest, sha, perms, extra = {}) {
  const rec = { sha, at: Date.now(), v: manifest.version, name: manifest.name, icon: manifest.icon, ...extra };
  const p = permsToString(perms);
  if (p) rec.perms = p;
  return rec;
}

/** Read a pinned copy and check it hashes to `sha`. Resolves to the code. */
export async function loadPinnedCode(path, sha) {
  const snap = await get(ref(db, path));
  const rec = snap.val();
  const code = unpackChunks(rec);
  if (!code || rec?.sha !== sha) fail('The approved copy of this add-on is missing. Reinstall it from the directory.');
  if ((await sha256Hex(code)) !== sha) fail('The approved copy of this add-on is damaged. Reinstall it from the directory.');
  return code;
}

export const personalPinPath = (id) => udataPath(myUid(), FEAT.pins, id);
export const serverPinPath = (sid, id) => sconfPath(sid, FEAT.pins, id);

// ---------- personal installs ----------

/** Install (or accept an update of) an add-on for me, pinning this exact code. */
export async function installPersonal(manifest, code, perms, { auto = false } = {}) {
  const uid = myUid();
  const sha = await sha256Hex(code);
  if (sha !== manifest.sha) fail('The code changed while you were reviewing it. Open the add-on again.');
  await update(ref(db), {
    [udataPath(uid, FEAT.installs, manifest.id)]: installRecord(manifest, sha, perms, auto ? { auto: true } : {}),
    [udataPath(uid, FEAT.pins, manifest.id)]: packChunks(code, { sha }),
  });
}

/** Remove a personal add-on, its pinned copy and its stored data. */
export function uninstallPersonal(id) {
  const uid = myUid();
  return update(ref(db), {
    [udataPath(uid, FEAT.installs, id)]: null,
    [udataPath(uid, FEAT.pins, id)]: null,
    [udataPath(uid, FEAT.store, id)]: null,
  });
}

/** "Allow sending without asking" for a personal add-on. */
export function setPersonalAutoSend(id, on) {
  return update(ref(db, udataPath(myUid(), FEAT.installs, id)), { auto: on ? true : null });
}

/** My personal installs: { loading, list }. */
export function usePersonalInstalls() {
  const st = useUdata(FEAT.installs);
  const list = useMemo(() => parseInstalls(st.value), [st.value]);
  return { loading: st.loading, error: st.error, list };
}

// ---------- server installs ----------

/** Install (or update) an add-on for a server with the permissions I grant (needs manageApps). */
export async function installServer(sid, manifest, code, perms) {
  const sha = await sha256Hex(code);
  if (sha !== manifest.sha) fail('The code changed while you were reviewing it. Open the add-on again.');
  await update(ref(db), {
    [sconfPath(sid, FEAT.installs, manifest.id)]: installRecord(manifest, sha, perms, { by: myUid() }),
    [sconfPath(sid, FEAT.pins, manifest.id)]: packChunks(code, { sha }),
  });
}

export function uninstallServer(sid, id) {
  return update(ref(db), { [sconfPath(sid, FEAT.installs, id)]: null, [sconfPath(sid, FEAT.pins, id)]: null });
}

/** A server's installs: { loading, list }. */
export function useServerInstalls(sid) {
  const st = useSconf(sid || null, FEAT.installs);
  const list = useMemo(() => parseInstalls(st.value), [st.value]);
  return { loading: st.loading, error: st.error, list };
}

// ---------- consent to server add-ons ----------

export function useConsent(sid, id) {
  const st = useUdata(sid && id ? FEAT.consent : null, sid && id ? consentKey(sid, id) : undefined);
  return { loading: st.loading, consent: parseConsent(st.value) };
}

export function saveConsent(sid, id, { perms, sha, auto = false }) {
  const rec = { sha, at: Date.now() };
  const p = permsToString(perms);
  if (p) rec.perms = p;
  if (auto) rec.auto = true;
  return update(ref(db), { [udataPath(myUid(), FEAT.consent, consentKey(sid, id))]: rec });
}

export function revokeConsent(sid, id) {
  return update(ref(db), { [udataPath(myUid(), FEAT.consent, consentKey(sid, id))]: null });
}

export function setConsentAutoSend(sid, id, on) {
  return update(ref(db, udataPath(myUid(), FEAT.consent, consentKey(sid, id))), { auto: on ? true : null });
}

// ---------- add-on storage (sealed with my vault key) ----------

export const storageKeyFor = (scope, id, sid) => (scope === 'server' ? consentKey(sid, id) : id);
const storageAad = (uid, key) => `addonstore:${uid}/${key}`;

/** Decrypt an add-on's storage map ({} when empty). */
export async function loadStorage(key) {
  const uid = myUid();
  const snap = await get(ref(db, udataPath(uid, FEAT.store, key)));
  const rec = snap.val();
  if (!rec) return {};
  const ct = unpackChunks(rec);
  if (!ct || typeof rec.iv !== 'string') fail('This add-on’s stored data is damaged.');
  const map = await openForMe(storageAad(uid, key), { iv: rec.iv, ct });
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

/** Encrypt and store an add-on's storage map (an empty map deletes it). */
export async function saveStorage(key, map) {
  const uid = myUid();
  const path = udataPath(uid, FEAT.store, key);
  if (!map || !Object.keys(map).length) return update(ref(db), { [path]: null });
  const box = await sealForMe(storageAad(uid, key), map);
  return update(ref(db), { [path]: packChunks(box.ct, { iv: box.iv }) });
}

export function clearStorage(key) {
  return update(ref(db), { [udataPath(myUid(), FEAT.store, key)]: null });
}

/** Keys of my stored add-on data with their approximate size: [{ key, size }]. */
export function useStoredData() {
  const st = useUdata(FEAT.store);
  const list = useMemo(() => {
    const v = st.value && typeof st.value === 'object' ? st.value : {};
    return Object.entries(v)
      .map(([key, rec]) => ({ key, size: Math.round(((unpackChunks(rec) || '').length * 3) / 4) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [st.value]);
  return { loading: st.loading, list };
}

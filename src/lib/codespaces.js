// Codespaces (F2): standalone end-to-end encrypted collaborative workspaces, not tied to a server.
//
//   codespaces/{csid}/meta          { ownerId, nameEnc:{iv,ct}, createdAt, template? }   template id is plaintext
//   codespaces/{csid}/members/{uid} { role:'owner'|'editor'|'viewer', joinedAt, addedBy }  plaintext membership
//   codespaces/{csid}/keys/{uid}    codespace AES key ECIES-wrapped for that member, context codespace:{csid}:{uid}
//   userCodespaces/{uid}/{csid}     { addedAt }                                          my index
//   csCollab/{csid}/...             same shapes as collab/{sid}/{cid}, AAD prefixes cs* (see collab/space.js)
//
// Name AAD: cs-name:{csid}. The rules enforce who may write what (owner manages members, editors
// write content, viewers only read + broadcast their cursor). Removing a member does NOT rotate
// the key in v1: they lose read access immediately through the rules, but keep any key they held.
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, onValue, push, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { db } from './firebase.js';
import { decryptText, encryptText, generateRoomKey } from './crypto.js';
import { currentUid, onLock, unwrapForMe, wrapFor } from './keystore.js';
import { codespaceSpace } from './collab/space.js';
import { createFile } from './collab/workspace.js';
import { MAX_INSERT_BYTES } from './collab/codec.js';
import { getTemplate, templateFiles } from './codespaceTemplates.js';

export const MAX_CODESPACE_NAME = 64;
export const MAX_CODESPACE_MEMBERS = 25; // UI-enforced (rules can't count children)
export const CODESPACE_ROLES = ['editor', 'viewer'];
export const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

export const csWrapContext = (csid, uid) => `codespace:${csid}:${uid}`;
export const csAad = { name: (csid) => `cs-name:${csid}` };
export const codespaceScope = (csid) => `cs_${csid}`;

const isDenied = (e) => /permission[_ ]denied/i.test(String(e?.code || e?.message || e || ''));
const utf8 = new TextEncoder();

// ---------- in-memory caches (cleared on lock) ----------

const keyCache = new Map(); // csid -> Promise<CryptoKey>
const nameCache = new Map(); // `${csid}|${iv}|${ct}` -> string
onLock(() => {
  keyCache.clear();
  nameCache.clear();
});

// ---------- names ----------

export function cleanCodespaceName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CODESPACE_NAME);
}

export function peekCodespaceName(csid, box) {
  return box ? nameCache.get(`${csid}|${box.iv}|${box.ct}`) : undefined;
}

export async function decryptCodespaceName(csid, box) {
  const k = `${csid}|${box?.iv}|${box?.ct}`;
  if (nameCache.has(k)) return nameCache.get(k);
  const key = await getCodespaceKey(csid);
  const name = cleanCodespaceName(await decryptText(key, box, csAad.name(csid))) || 'Untitled codespace';
  nameCache.set(k, name);
  return name;
}

// ---------- keys ----------

/** The codespace AES key, unwrapped with my private key. Cached per session, cleared on lock. */
export function getCodespaceKey(csid) {
  const uid = currentUid();
  if (!uid) return Promise.reject(new Error('Vault is locked'));
  if (!keyCache.has(csid)) {
    const p = get(ref(db, `codespaces/${csid}/keys/${uid}`)).then((s) => {
      if (!s.exists()) throw new Error('No key for this codespace');
      return unwrapForMe(s.val(), csWrapContext(csid, uid));
    });
    p.catch(() => keyCache.delete(csid));
    keyCache.set(csid, p);
  }
  return keyCache.get(csid);
}

export function forgetCodespaceKey(csid) {
  keyCache.delete(csid);
}

// ---------- templates ----------

/**
 * Seed template files into any collab space (codespace or channel workspace), sequentially.
 * Each file is created with its content as the first encrypted Yjs update.
 * @param {{ space, key: CryptoKey, uid: string, templateId: string, skipPaths?: string[],
 *           onProgress?: (done:number, total:number, path:string) => void }} opts
 * @returns {Promise<{ created: Array<{fid, path}>, failed: Array<{path, error}>, openFid: string|null }>}
 */
export async function seedTemplate({ space, key, uid, templateId, skipPaths = [], onProgress }) {
  const skip = new Set(skipPaths);
  const files = templateFiles(templateId).filter((f) => !skip.has(f.path));
  const created = [];
  const failed = [];
  onProgress?.(0, files.length, '');
  for (let i = 0; i < files.length; i++) {
    const { path, content } = files[i];
    try {
      if (utf8.encode(content).length > MAX_INSERT_BYTES) throw new Error('Template file is too large');
      const fid = await createFile({ space, key, uid, meta: { path }, content });
      created.push({ fid, path });
    } catch (err) {
      failed.push({ path, error: err?.message || String(err) });
    }
    onProgress?.(i + 1, files.length, path);
  }
  // Open the most "entry-like" file first.
  const pick = (re) => created.find((f) => re.test(f.path));
  const open = pick(/^index\.html$/) || pick(/\.(js|ts|py)$/) || pick(/^README\.md$/i) || created[0];
  return { created, failed, openFid: open?.fid || null };
}

// ---------- create / manage ----------

/**
 * Create a codespace in ONE multi-path update (meta + owner membership + my wrapped key + my index
 * entry), then seed the template's files.
 * @returns {Promise<{ csid, created, failed, openFid }>}
 */
export async function createCodespace(me, { name, templateId, onProgress } = {}) {
  const uid = typeof me === 'string' ? me : me?.uid;
  if (!uid) throw new Error('Not signed in');
  const clean = cleanCodespaceName(name);
  if (!clean) throw new Error('Give your codespace a name');
  const template = getTemplate(templateId) ? templateId : null;

  const csid = push(ref(db, 'codespaces')).key;
  const key = await generateRoomKey();
  const [nameEnc, wrapped] = await Promise.all([
    encryptText(key, clean, csAad.name(csid)),
    wrapFor(uid, key, csWrapContext(csid, uid)),
  ]);
  const now = serverTimestamp();
  const meta = { ownerId: uid, nameEnc, createdAt: now };
  if (template) meta.template = template;
  await update(ref(db), {
    [`codespaces/${csid}`]: {
      meta,
      members: { [uid]: { role: 'owner', joinedAt: now, addedBy: uid } },
      keys: { [uid]: wrapped },
    },
    [`userCodespaces/${uid}/${csid}`]: { addedAt: now },
  });
  keyCache.set(csid, Promise.resolve(key));
  nameCache.set(`${csid}|${nameEnc.iv}|${nameEnc.ct}`, clean);

  if (!template || !templateFiles(template).length) return { csid, created: [], failed: [], openFid: null };
  const seeded = await seedTemplate({ space: codespaceSpace(csid), key, uid, templateId: template, onProgress });
  return { csid, ...seeded };
}

export async function renameCodespace(csid, name) {
  const clean = cleanCodespaceName(name);
  if (!clean) throw new Error('Codespace name cannot be empty');
  const key = await getCodespaceKey(csid);
  const nameEnc = await encryptText(key, clean, csAad.name(csid));
  await update(ref(db, `codespaces/${csid}/meta`), { nameEnc });
  nameCache.set(`${csid}|${nameEnc.iv}|${nameEnc.ct}`, clean);
}

/** Owner only. Wraps the codespace key for `uid` and adds them with `role` ('editor'|'viewer'). */
export async function addMember(csid, uid, role = 'editor') {
  const me = currentUid();
  if (!CODESPACE_ROLES.includes(role)) throw new Error('Invalid role');
  if (uid === me) throw new Error('You are already in this codespace');
  const members = (await get(ref(db, `codespaces/${csid}/members`))).val() || {};
  if (members[uid]) throw new Error('Already a member');
  if (Object.keys(members).length >= MAX_CODESPACE_MEMBERS) {
    throw new Error(`A codespace can have at most ${MAX_CODESPACE_MEMBERS} members`);
  }
  const key = await getCodespaceKey(csid);
  let wrapped;
  try {
    wrapped = await wrapFor(uid, key, csWrapContext(csid, uid));
  } catch {
    throw new Error('This user has not set up encryption yet. Ask them to sign in once first.');
  }
  try {
    await update(ref(db), {
      [`codespaces/${csid}/members/${uid}`]: { role, joinedAt: serverTimestamp(), addedBy: me },
      [`codespaces/${csid}/keys/${uid}`]: wrapped,
      [`userCodespaces/${uid}/${csid}`]: { addedAt: serverTimestamp() },
    });
  } catch (err) {
    if (isDenied(err)) throw new Error('Couldn’t add this person. They may not accept invites from you.');
    throw err;
  }
}

/** Owner only. */
export function setMemberRole(csid, uid, role) {
  if (!CODESPACE_ROLES.includes(role)) return Promise.reject(new Error('Invalid role'));
  return set(ref(db, `codespaces/${csid}/members/${uid}/role`), role);
}

/** Owner only. No key rotation in v1 (documented limitation). */
export function removeMember(csid, uid) {
  return update(ref(db), {
    [`codespaces/${csid}/members/${uid}`]: null,
    [`codespaces/${csid}/keys/${uid}`]: null,
    [`userCodespaces/${uid}/${csid}`]: null,
  });
}

/** Owner only: re-wrap the key for a member whose copy is unusable (e.g. they reset their vault). */
export async function reshareKey(csid, uid) {
  const key = await getCodespaceKey(csid);
  const wrapped = await wrapFor(uid, key, csWrapContext(csid, uid));
  await set(ref(db, `codespaces/${csid}/keys/${uid}`), wrapped);
}

/** Any non-owner member. */
export async function leaveCodespace(csid, uid = currentUid()) {
  await update(ref(db), {
    [`codespaces/${csid}/members/${uid}`]: null,
    [`codespaces/${csid}/keys/${uid}`]: null,
    [`userCodespaces/${uid}/${csid}`]: null,
  });
  forgetCodespaceKey(csid);
}

/**
 * Owner only. Removes the codespace, all of its collab data, and every member's index entry
 * (the rules let the owner null those) in one atomic update.
 */
export async function deleteCodespace(csid, uid = currentUid()) {
  const members = (await get(ref(db, `codespaces/${csid}/members`))).val() || {};
  const writes = {
    [`csCollab/${csid}`]: null,
    [`codespaces/${csid}`]: null,
    [`userCodespaces/${uid}/${csid}`]: null,
  };
  for (const m of Object.keys(members)) writes[`userCodespaces/${m}/${csid}`] = null;
  await update(ref(db), writes);
  forgetCodespaceKey(csid);
}

/** Drop my stale index entry (codespace deleted, or I was removed). */
export function forgetCodespace(csid, uid = currentUid()) {
  forgetCodespaceKey(csid);
  return remove(ref(db, `userCodespaces/${uid}/${csid}`));
}

/**
 * Account deletion (0.10): delete codespaces I own, leave the others, drop stale index entries.
 * Tolerates data that is already gone, so a retry finishes the job.
 */
export async function cleanupCodespacesForAccount(uid, onStep) {
  const index = (await get(ref(db, `userCodespaces/${uid}`))).val() || {};
  for (const csid of Object.keys(index)) {
    let meta = null;
    try {
      meta = (await get(ref(db, `codespaces/${csid}/meta`))).val();
    } catch {
      // Not a member any more: only my index entry is left.
    }
    if (!meta) {
      await remove(ref(db, `userCodespaces/${uid}/${csid}`));
    } else if (meta.ownerId === uid) {
      onStep?.('Deleting a codespace you own…');
      await deleteCodespace(csid, uid);
    } else {
      onStep?.('Leaving a codespace…');
      await leaveCodespace(csid, uid);
    }
  }
}

// ---------- hooks ----------

function useLive(path, nonce) {
  const [state, setState] = useState({ status: path ? 'loading' : 'idle', value: null });
  useEffect(() => {
    if (!path) {
      setState({ status: 'idle', value: null });
      return undefined;
    }
    setState({ status: 'loading', value: null });
    return onValue(
      ref(db, path),
      (s) => setState({ status: 'ready', value: s.val() }),
      (err) => setState({ status: isDenied(err) ? 'denied' : 'error', value: null, error: err?.message }),
    );
  }, [path, nonce]);
  return state;
}

/**
 * My codespaces, live.
 * -> { loading, codespaces: [{ csid, name, nameFailed, ownerId, role, template, createdAt, addedAt,
 *      status: 'loading'|'ready'|'missing' }] } sorted by name.
 */
export function useMyCodespaces(uid) {
  const [index, setIndex] = useState({ loading: true, entries: {} });
  const [info, setInfo] = useState({});
  const subs = useRef(new Map()); // `${csid}|${addedAt}` -> unsubscribe

  useEffect(() => {
    if (!uid) {
      setIndex({ loading: false, entries: {} });
      return undefined;
    }
    setIndex({ loading: true, entries: {} });
    return onValue(
      ref(db, `userCodespaces/${uid}`),
      (s) => setIndex({ loading: false, entries: s.val() || {} }),
      () => setIndex({ loading: false, entries: {} }),
    );
  }, [uid]);

  const wanted = Object.entries(index.entries)
    .map(([csid, v]) => `${csid}|${v?.addedAt || 0}`)
    .sort()
    .join(',');

  useEffect(() => {
    const keys = new Set(wanted ? wanted.split(',') : []);
    const map = subs.current;
    for (const [k, unsub] of map) {
      if (!keys.has(k)) {
        unsub();
        map.delete(k);
        const csid = k.split('|')[0];
        setInfo((prev) => {
          if (!(csid in prev)) return prev;
          const next = { ...prev };
          delete next[csid];
          return next;
        });
      }
    }
    for (const k of keys) {
      if (map.has(k)) continue;
      const csid = k.split('|')[0];
      let alive = true;
      let seq = 0;
      const patch = (p) => alive && setInfo((prev) => ({ ...prev, [csid]: { ...(prev[csid] || { status: 'loading' }), ...p } }));
      const offMeta = onValue(
        ref(db, `codespaces/${csid}/meta`),
        (s) => {
          const m = s.val();
          if (!m) return patch({ status: 'missing' });
          const my = ++seq;
          const cached = peekCodespaceName(csid, m.nameEnc);
          patch({
            status: 'ready',
            ownerId: m.ownerId,
            createdAt: m.createdAt,
            template: m.template || null,
            ...(cached ? { name: cached, nameFailed: false } : {}),
          });
          if (!cached) {
            decryptCodespaceName(csid, m.nameEnc).then(
              (name) => my === seq && patch({ name, nameFailed: false }),
              () => my === seq && patch({ name: null, nameFailed: true }),
            );
          }
        },
        () => patch({ status: 'missing' }),
      );
      const offRole = onValue(
        ref(db, `codespaces/${csid}/members/${uid}/role`),
        (s) => patch({ role: s.val() || null }),
        () => patch({ role: null }),
      );
      map.set(k, () => {
        alive = false;
        offMeta();
        offRole();
      });
    }
  }, [wanted, uid]);

  useEffect(
    () => () => {
      for (const unsub of subs.current.values()) unsub();
      subs.current.clear();
    },
    [uid],
  );

  const codespaces = useMemo(
    () =>
      Object.entries(index.entries)
        .map(([csid, v]) => ({ csid, addedAt: v?.addedAt || 0, status: 'loading', name: null, nameFailed: false, role: null, ...(info[csid] || {}) }))
        .sort((a, b) => (a.name || '￿').localeCompare(b.name || '￿') || a.addedAt - b.addedAt),
    [index.entries, info],
  );
  return { loading: index.loading, codespaces };
}

/**
 * One codespace, live.
 * -> { status: 'loading'|'ready'|'missing', meta: { ownerId, createdAt, template, name, nameFailed } | null,
 *      members: [{ uid, role, joinedAt, addedBy }], myRole: 'owner'|'editor'|'viewer'|null, isOwner }
 */
export function useCodespace(csid, uid = currentUid(), nonce = 0) {
  const metaS = useLive(csid ? `codespaces/${csid}/meta` : null, nonce);
  const memS = useLive(csid ? `codespaces/${csid}/members` : null, nonce);
  const [name, setName] = useState({ box: null, name: null, failed: false });

  const box = metaS.value?.nameEnc || null;
  const boxKey = box ? `${box.iv}|${box.ct}` : '';
  useEffect(() => {
    if (!csid || !box) {
      setName({ box: null, name: null, failed: false });
      return undefined;
    }
    let alive = true;
    const cached = peekCodespaceName(csid, box);
    if (cached) {
      setName({ box: boxKey, name: cached, failed: false });
      return undefined;
    }
    decryptCodespaceName(csid, box).then(
      (n) => alive && setName({ box: boxKey, name: n, failed: false }),
      () => alive && setName({ box: boxKey, name: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [csid, boxKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!csid) return { status: 'missing', meta: null, members: [], myRole: null, isOwner: false };
  if (metaS.status === 'loading' || (metaS.status === 'ready' && metaS.value && memS.status === 'loading')) {
    return { status: 'loading', meta: null, members: [], myRole: null, isOwner: false };
  }
  if (metaS.status !== 'ready' || !metaS.value) return { status: 'missing', meta: null, members: [], myRole: null, isOwner: false };

  const m = metaS.value;
  const members = Object.entries(memS.value || {})
    .map(([u, v]) => ({ uid: u, role: v?.role || 'viewer', joinedAt: v?.joinedAt || 0, addedBy: v?.addedBy || null }))
    .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.joinedAt - b.joinedAt));
  const myRole = members.find((x) => x.uid === uid)?.role || null;
  const nameReady = name.box === boxKey;
  return {
    status: 'ready',
    meta: {
      ownerId: m.ownerId,
      createdAt: m.createdAt,
      template: m.template || null,
      name: nameReady ? name.name : peekCodespaceName(csid, box) || null,
      nameFailed: nameReady && name.failed,
    },
    members,
    myRole,
    isOwner: m.ownerId === uid,
  };
}

// Encrypted chat messages over Realtime Database (channels + DMs).
//
// Conversation descriptor (from the layout module):
//   { kind: 'channel', sid, cid, title, scope }  |  { kind: 'dm', dmId, peerUid, title, scope }
//
// Stored message: { uid, ts, iv, ct, editedAt?, replyTo?, deleted?, reactions?, pinned? }
// The {iv, ct} box is AES-GCM over the JSON body { text, code?: { lang, content, filename? }, invite?: { name } }
// with AAD `msg:{sid}/{cid}/{mid}:{uid}` (channels) or `dm:{dmId}/{mid}:{uid}` (DMs). Binding the
// author uid means a server that rewrites `uid` makes the message undecryptable instead of
// misattributed. Messages written before this change used the uid-less AAD and are still read.
import {
  equalTo,
  get,
  limitToLast,
  onDisconnect,
  onValue,
  orderByChild,
  orderByKey,
  push,
  query,
  ref,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';
import { db } from './firebase.js';
import { decryptJSON, encryptJSON } from './crypto.js';
import { getDmKey, getServerKey } from './keystore.js';

export const PAGE_SIZE = 50;
export const MAX_TEXT = 4000; // characters of message text
export const MAX_BODY_BYTES = 45_000; // plaintext JSON bytes; keeps base64 ciphertext < 64KB
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🔥'];

// ---------- Paths ----------

export function messagesPath(conv) {
  return conv.kind === 'dm' ? `dmMessages/${conv.dmId}` : `messages/${conv.sid}/${conv.cid}`;
}

export function legacyMessageAad(conv, mid) {
  return conv.kind === 'dm' ? `dm:${conv.dmId}/${mid}` : `msg:${conv.sid}/${conv.cid}/${mid}`;
}

export function messageAad(conv, mid, uid) {
  return `${legacyMessageAad(conv, mid)}:${uid}`;
}

// Read-marker scope (reads/{uid}/{scope}).
export function typingScope(conv) {
  if (conv.scope) return conv.scope;
  return conv.kind === 'dm' ? `dm_${conv.dmId}` : `${conv.sid}_${conv.cid}`;
}

// Typing path under typing/ — split by kind so the rules can enforce membership.
export function typingPath(conv) {
  return conv.kind === 'dm' ? `dm/${conv.dmId}` : `ch/${conv.sid}/${conv.cid}`;
}

export function getConvKey(conv) {
  return conv.kind === 'dm' ? getDmKey(conv.dmId, conv.peerUid) : getServerKey(conv.sid);
}

// ---------- Reaction keys ----------
// RTDB keys can't hold some characters, so reactions are keyed by the emoji's code points
// in lowercase hex joined with '-' (e.g. "1f44d", "2764-fe0f"). Plaintext by design.

export function emojiKey(native) {
  return Array.from(native, (ch) => ch.codePointAt(0).toString(16)).join('-');
}

export function emojiFromKey(key) {
  try {
    return String.fromCodePoint(...key.split('-').map((h) => parseInt(h, 16)));
  } catch {
    return '?';
  }
}

// ---------- Body validation ----------

const enc = new TextEncoder();

export function validateBody(body) {
  const text = (body.text || '').trim();
  if (!text && !body.code?.content) return 'Message is empty.';
  if (text.length > MAX_TEXT) return `Message is too long (${text.length}/${MAX_TEXT}).`;
  if (enc.encode(JSON.stringify(body)).length > MAX_BODY_BYTES) return 'Message is too large (max ~45 KB including code).';
  return null;
}

function cleanBody(body) {
  const out = { text: (body.text || '').trim() };
  if (body.code?.content) {
    out.code = { lang: body.code.lang || 'plaintext', content: body.code.content };
    if (body.code.filename) out.code.filename = String(body.code.filename).slice(0, 200);
  }
  if (body.invite) out.invite = { name: String(body.invite.name || '').slice(0, 64) };
  return out;
}

// ---------- Decryption (cached) ----------

const decryptCache = new Map(); // `${aad}|${iv}` -> Promise<body>
const MAX_CACHE = 5000;

const optStr = (v) => v === undefined || v === null || typeof v === 'string';

// Untrusted input: any member can encrypt any JSON. Reject shapes the UI can't render.
function checkBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string') {
    throw new Error('Malformed message body');
  }
  if (body.code !== undefined && body.code !== null) {
    const c = body.code;
    if (typeof c !== 'object' || Array.isArray(c) || typeof c.content !== 'string' || !optStr(c.lang) || !optStr(c.filename)) {
      throw new Error('Malformed message body');
    }
  }
  if (body.invite !== undefined && body.invite !== null) {
    if (typeof body.invite !== 'object' || Array.isArray(body.invite) || !optStr(body.invite.name)) throw new Error('Malformed message body');
  }
  return body;
}

export function decryptMessage(key, conv, mid, raw) {
  if (!raw || raw.deleted || !raw.iv || !raw.ct) return Promise.resolve(null);
  if (typeof raw.uid !== 'string' || !raw.uid) return Promise.reject(new Error('Message has no author'));
  const aad = messageAad(conv, mid, raw.uid);
  const cacheKey = `${aad}|${raw.iv}`;
  let p = decryptCache.get(cacheKey);
  if (!p) {
    const box = { iv: raw.iv, ct: raw.ct };
    p = decryptJSON(key, box, aad)
      // Pre-uid-binding messages: a ciphertext made with the new AAD never opens under the legacy
      // one, so this fallback can't be used to re-attribute new messages.
      .catch(() => decryptJSON(key, box, legacyMessageAad(conv, mid)))
      .then(checkBody);
    if (decryptCache.size > MAX_CACHE) decryptCache.delete(decryptCache.keys().next().value);
    decryptCache.set(cacheKey, p);
  }
  return p;
}

// ---------- Live subscription ----------

/**
 * Subscribe to the newest `limit` messages. cb receives an array of
 * { mid, uid, ts, iv, ct, editedAt, replyTo, deleted, reactions, pinned } in chronological order,
 * plus `hasMore` (true if older messages may exist).
 */
export function subscribeMessages(conv, limit, cb, onError) {
  const q = query(ref(db, messagesPath(conv)), orderByKey(), limitToLast(limit));
  return onValue(
    q,
    (snap) => {
      const list = [];
      snap.forEach((child) => {
        const v = child.val();
        if (v && typeof v === 'object') list.push({ mid: child.key, ...v });
      });
      cb(list, list.length >= limit);
    },
    (err) => onError?.(err),
  );
}

// Pinned messages (needs ".indexOn": ["pinned"] on the messages node for efficiency).
export async function fetchPinned(conv) {
  const snap = await get(query(ref(db, messagesPath(conv)), orderByChild('pinned'), equalTo(true)));
  const list = [];
  snap.forEach((child) => {
    list.push({ mid: child.key, ...child.val() });
  });
  return list;
}

// ---------- Writes ----------

/**
 * Encrypts, then queues the write without waiting for the server's ack (RTDB shows it locally at
 * once and delivers it when the connection allows). Resolves to { mid, done } as soon as the write
 * is queued; `done` settles on server ack / rejection.
 */
export async function sendMessage(conv, me, body, { replyTo } = {}) {
  const clean = cleanBody(body);
  const err = validateBody(clean);
  if (err) throw new Error(err);
  const key = await getConvKey(conv);
  const msgRef = push(ref(db, messagesPath(conv)));
  const mid = msgRef.key;
  const box = await encryptJSON(key, clean, messageAad(conv, mid, me.uid));
  const record = { uid: me.uid, ts: serverTimestamp(), iv: box.iv, ct: box.ct };
  if (replyTo) record.replyTo = replyTo;
  const sent = set(msgRef, record);

  let done = sent;
  if (conv.kind === 'dm') {
    // Keep both DM indexes fresh so the conversation bubbles up for each side. My read marker is
    // written in the same update so it gets the identical server timestamp (no self-unread).
    done = sent.then(() => {
      const ts = serverTimestamp();
      return update(ref(db), {
        [`userDms/${me.uid}/${conv.dmId}/peer`]: conv.peerUid,
        [`userDms/${me.uid}/${conv.dmId}/lastTs`]: ts,
        [`reads/${me.uid}/dm_${conv.dmId}`]: ts,
        [`userDms/${conv.peerUid}/${conv.dmId}/peer`]: me.uid,
        [`userDms/${conv.peerUid}/${conv.dmId}/lastTs`]: ts,
      }).catch((e) => console.warn('[chat] could not update DM index', e));
    });
  }
  return { mid, done };
}

export async function editMessage(conv, mid, body, authorUid) {
  const clean = cleanBody(body);
  const err = validateBody(clean);
  if (err) throw new Error(err);
  const key = await getConvKey(conv);
  const box = await encryptJSON(key, clean, messageAad(conv, mid, authorUid));
  await update(ref(db, `${messagesPath(conv)}/${mid}`), { iv: box.iv, ct: box.ct, editedAt: serverTimestamp() });
}

// Soft delete: the ciphertext, reactions and pin are removed; uid/ts remain as a tombstone.
export async function deleteMessage(conv, mid) {
  await update(ref(db, `${messagesPath(conv)}/${mid}`), {
    deleted: true,
    iv: null,
    ct: null,
    reactions: null,
    pinned: null,
    editedAt: null,
  });
}

export async function setReaction(conv, mid, key, uid, on) {
  await set(ref(db, `${messagesPath(conv)}/${mid}/reactions/${key}/${uid}`), on ? true : null);
}

export async function setPinned(conv, mid, pinned) {
  await set(ref(db, `${messagesPath(conv)}/${mid}/pinned`), pinned ? true : null);
}

// ---------- Typing ----------

let serverOffset = 0;
let offsetUnsub = null;
function ensureOffset() {
  if (!offsetUnsub) offsetUnsub = onValue(ref(db, '.info/serverTimeOffset'), (s) => { serverOffset = s.val() || 0; });
}
export function serverNow() {
  ensureOffset();
  return Date.now() + serverOffset;
}

const typingDisconnectArmed = new Set();

// `path` comes from typingPath(conv).
export function setTyping(path, uid, on) {
  const scope = path;
  const r = ref(db, `typing/${path}/${uid}`);
  if (on && !typingDisconnectArmed.has(scope)) {
    typingDisconnectArmed.add(scope);
    onDisconnect(r).remove().catch(() => typingDisconnectArmed.delete(scope));
  }
  return set(r, on ? serverTimestamp() : null).catch(() => {});
}

export const TYPING_TTL = 8000;

// cb(uids[]) of users (other than me) typing within the last TYPING_TTL ms.
export function subscribeTyping(path, myUid, cb) {
  ensureOffset();
  let latest = {};
  const emit = () => {
    const now = serverNow();
    cb(Object.entries(latest).filter(([uid, ts]) => uid !== myUid && typeof ts === 'number' && now - ts < TYPING_TTL).map(([uid]) => uid));
  };
  const unsub = onValue(ref(db, `typing/${path}`), (s) => { latest = s.val() || {}; emit(); }, () => cb([]));
  const timer = setInterval(emit, 2000);
  return () => { unsub(); clearInterval(timer); };
}

// ---------- Read markers ----------

export async function getLastRead(uid, scope) {
  const s = await get(ref(db, `reads/${uid}/${scope}`));
  return typeof s.val() === 'number' ? s.val() : 0;
}

export function markRead(uid, scope) {
  return set(ref(db, `reads/${uid}/${scope}`), serverTimestamp()).catch(() => {});
}

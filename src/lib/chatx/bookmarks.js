// Bookmarks: bookmarks/{uid}/{key}, each entry vault-encrypted (AAD `bm:{uid}/{key}`).
// The server sees only that a bookmark exists. key = `${scope}_${mid}` (RTDB-safe, deterministic so
// re-saving is idempotent).
import { onValue, ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from '../firebase.js';
import { vaultDecryptJSON, vaultEncryptJSON } from '../keystore.js';
import { typingScope } from '../messages.js';

export const MAX_BOOKMARKS = 200;
const SNIPPET = 600;

export const bookmarkKey = (conv, mid) => `${typingScope(conv)}_${mid}`.replace(/[.#$[\]/]/g, '-');
export const bookmarkAad = (uid, key) => `bm:${uid}/${key}`;

function convRef(conv) {
  const c = { kind: conv.kind, title: String(conv.title || '').slice(0, 80) };
  for (const k of ['sid', 'cid', 'dmId', 'peerUid', 'gid', 'ownerId', 'scope']) if (conv[k] !== undefined) c[k] = conv[k];
  return c;
}

/** msg: { mid, uid, ts }, body: decrypted body, authorName for display. */
export async function addBookmark(uid, conv, msg, body, authorName) {
  const key = bookmarkKey(conv, msg.mid);
  const entry = {
    conv: convRef(conv),
    mid: msg.mid,
    author: String(authorName || '').slice(0, 64),
    authorUid: msg.uid,
    msgTs: typeof msg.ts === 'number' ? msg.ts : Date.now(),
    text: String(body?.text || '').slice(0, SNIPPET),
    code: body?.code?.content ? { lang: body.code.lang || 'plaintext', content: String(body.code.content).slice(0, SNIPPET) } : undefined,
    savedAt: Date.now(),
  };
  if (!entry.code) delete entry.code;
  const box = await vaultEncryptJSON(entry, bookmarkAad(uid, key));
  await set(ref(db, `bookmarks/${uid}/${key}`), { iv: box.iv, ct: box.ct, ts: serverTimestamp() });
  return key;
}

export const removeBookmark = (uid, key) => remove(ref(db, `bookmarks/${uid}/${key}`));

/** cb receives [{ key, ...entry }] newest-saved first. Undecryptable rows are skipped. */
export function subscribeBookmarks(uid, cb) {
  return onValue(
    ref(db, `bookmarks/${uid}`),
    async (snap) => {
      const rows = [];
      snap.forEach((child) => {
        rows.push({ key: child.key, raw: child.val() });
      });
      const out = [];
      for (const { key, raw } of rows) {
        try {
          out.push({ key, ...(await vaultDecryptJSON({ iv: raw.iv, ct: raw.ct }, bookmarkAad(uid, key))) });
        } catch {
          /* wrong vault / tampered: skip */
        }
      }
      out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      cb(out);
    },
    () => cb([]),
  );
}

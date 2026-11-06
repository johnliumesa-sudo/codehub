// Personal snippet library (F20): private code snippets encrypted with the user's vault key.
//
//   snippets/{uid}/{id}  { ts, iv, ct }
//   ct = vaultEncryptJSON({ title, lang, code, tags }, `vault-snip:${uid}/${id}`)
//
// Only the owner can read or write the subtree (rules), and only the owner's vault key can
// decrypt it. The 500-snippet cap is enforced here in the client (rules cannot count).
import { useEffect, useRef, useState } from 'react';
import { onValue, push, ref, remove, serverTimestamp, set } from 'firebase/database';
import { db } from './firebase.js';
import { vaultDecryptJSON, vaultEncryptJSON } from './keystore.js';
import { SNIPPET_LANGUAGES } from './markdown.js';

export const MAX_SNIPPETS = 500;
export const MAX_TITLE = 80;
export const MAX_CODE = 40_000;
export const MAX_TAGS = 8;
export const MAX_TAG = 24;
// Rules cap ct at 87,400 base64url chars; stay just under it.
const MAX_CT = 87_000;

const LANG_IDS = new Set(SNIPPET_LANGUAGES.map(([v]) => v));

export const snippetAad = (uid, id) => `vault-snip:${uid}/${id}`;

export function cleanTag(tag) {
  return String(tag || '')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_+.#-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG);
}

export function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,\s]+/);
  const out = [];
  for (const t of list) {
    const c = cleanTag(t);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Normalise untrusted / user input into the stored shape. */
export function cleanSnippet(s) {
  const lang = LANG_IDS.has(s?.lang) ? s.lang : 'plaintext';
  return {
    title: String(s?.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
    lang,
    code: String(s?.code ?? '').slice(0, MAX_CODE),
    tags: parseTags(s?.tags || []),
  };
}

/** Live, decrypted list of my snippets, newest first: [{ id, ts, title, lang, code, tags, broken? }] */
export function useSnippets(uid) {
  const [state, setState] = useState({ snippets: [], loading: true, error: null });
  const cacheRef = useRef(new Map()); // id -> { ct, value }

  useEffect(() => {
    if (!uid) {
      setState({ snippets: [], loading: false, error: null });
      return undefined;
    }
    let alive = true;
    let seq = 0;
    cacheRef.current = new Map();
    setState({ snippets: [], loading: true, error: null });
    const unsub = onValue(
      ref(db, `snippets/${uid}`),
      async (snap) => {
        const my = ++seq;
        const raw = snap.val() || {};
        const cache = cacheRef.current;
        const snippets = await Promise.all(
          Object.entries(raw).map(async ([id, v]) => {
            const ct = v?.ct;
            let value = cache.get(id)?.ct === ct ? cache.get(id).value : null;
            if (!value) {
              try {
                value = cleanSnippet(await vaultDecryptJSON({ iv: v.iv, ct }, snippetAad(uid, id)));
                cache.set(id, { ct, value });
              } catch {
                value = { title: 'Undecryptable snippet', lang: 'plaintext', code: '', tags: [], broken: true };
              }
            }
            return { id, ts: typeof v?.ts === 'number' ? v.ts : 0, ...value };
          }),
        );
        if (!alive || my !== seq) return;
        snippets.sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
        setState({ snippets, loading: false, error: null });
      },
      (err) => alive && setState({ snippets: [], loading: false, error: err?.message || 'Could not load snippets' }),
    );
    return () => {
      alive = false;
      unsub();
    };
  }, [uid]);

  return state;
}

/**
 * Create (id = null) or update a snippet. Returns its id.
 * `count` is the current number of snippets, used for the client-side cap on create.
 */
export async function saveSnippet(uid, id, snippet, count = 0) {
  const clean = cleanSnippet(snippet);
  if (!clean.title) throw new Error('Give the snippet a title');
  if (!clean.code.trim()) throw new Error('The snippet is empty');
  if (String(snippet?.code ?? '').length > MAX_CODE) throw new Error(`Snippets are limited to ${MAX_CODE.toLocaleString()} characters`);
  if (!id && count >= MAX_SNIPPETS) throw new Error(`You can keep up to ${MAX_SNIPPETS} snippets. Delete some first.`);
  const sRef = id ? ref(db, `snippets/${uid}/${id}`) : push(ref(db, `snippets/${uid}`));
  const box = await vaultEncryptJSON(clean, snippetAad(uid, sRef.key));
  if (box.ct.length > MAX_CT) throw new Error('This snippet is too large once encrypted. Shorten it a little.');
  await set(sRef, { ts: serverTimestamp(), iv: box.iv, ct: box.ct });
  return sRef.key;
}

export function deleteSnippet(uid, id) {
  return remove(ref(db, `snippets/${uid}/${id}`));
}

/** Markdown fenced block for chat, using a fence longer than any backtick run inside the code. */
export function fenced(code, lang) {
  const body = String(code ?? '').replace(/\n+$/, '');
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  const l = lang && lang !== 'plaintext' ? lang : '';
  return `${fence}${l}\n${body}\n${fence}`;
}

/** Case-insensitive search across title, tags, language and code. */
export function searchSnippets(snippets, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return snippets;
  return snippets.filter((s) => {
    const hay = `${s.title}\n${s.tags.map((t) => `#${t}`).join(' ')}\n${s.lang}\n${s.code}`.toLowerCase();
    return terms.every((t) => hay.includes(t.replace(/^#/, '')) || hay.includes(t));
  });
}

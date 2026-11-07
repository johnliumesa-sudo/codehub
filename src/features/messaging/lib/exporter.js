// Chat export: page through a conversation's history (newest to oldest), decrypt locally with the
// conversation key, and hand plain records to exportFormat.js. Nothing is uploaded anywhere; the
// result is a download in this browser.
import { endBefore, get, limitToLast, orderByKey, query, ref } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { decryptMessage, getConvKey, messagesPath } from '../../../lib/messages.js';
import { toJson, toMarkdown, toRecord } from './exportFormat.js';

export const EXPORT_PAGE = 200;
export const EXPORT_MAX = 20_000;

/** Display names for uids (known profiles first, then users/{uid}/name). */
async function namesFor(uids, known = {}) {
  const out = {};
  await Promise.all([...uids].map(async (uid) => {
    const n = known[uid]?.name;
    if (typeof n === 'string' && n) {
      out[uid] = n;
      return;
    }
    try {
      const s = await get(ref(db, `users/${uid}/name`));
      out[uid] = typeof s.val() === 'string' ? s.val() : 'Unknown';
    } catch {
      out[uid] = 'Unknown';
    }
  }));
  return out;
}

const checkAbort = (signal) => {
  if (signal?.aborted) {
    const e = new Error('Export cancelled');
    e.name = 'AbortError';
    throw e;
  }
};

/**
 * Decrypt a conversation into export records (oldest first).
 * opts: { from?, to? (ms, inclusive), loaded?: ChatContext messages to use instead of fetching,
 *         profiles?, signal?: AbortSignal, onProgress?({ fetched, decrypted, phase }) }
 */
export async function collectRecords(conv, { from, to, loaded, profiles = {}, signal, onProgress } = {}) {
  const lo = Number.isFinite(from) ? from : -Infinity;
  const hi = Number.isFinite(to) ? to : Infinity;
  let rows = [];
  if (Array.isArray(loaded)) {
    rows = loaded.filter((m) => m && typeof m.mid === 'string').map((m) => ({ ...m }));
  } else {
    const base = ref(db, messagesPath(conv));
    let cursor = null;
    for (;;) {
      checkAbort(signal);
      const q = cursor
        ? query(base, orderByKey(), endBefore(cursor), limitToLast(EXPORT_PAGE))
        : query(base, orderByKey(), limitToLast(EXPORT_PAGE));
      const snap = await get(q);
      const page = [];
      snap.forEach((c) => {
        const v = c.val();
        if (v && typeof v === 'object') page.push({ mid: c.key, ...v });
      });
      if (!page.length) break;
      rows = page.concat(rows);
      cursor = page[0].mid;
      onProgress?.({ fetched: rows.length, decrypted: 0, phase: 'fetch' });
      const oldestTs = Number(page[0].ts);
      if (page.length < EXPORT_PAGE || (Number.isFinite(oldestTs) && oldestTs < lo) || rows.length >= EXPORT_MAX) break;
    }
  }
  rows = rows.filter((m) => {
    const ts = Number(m.ts);
    return Number.isFinite(ts) ? ts >= lo && ts <= hi : lo === -Infinity;
  });
  if (rows.length > EXPORT_MAX) rows = rows.slice(rows.length - EXPORT_MAX);

  const key = conv.kind === 'group' ? null : await getConvKey(conv);
  const names = await namesFor(new Set(rows.map((m) => m.uid).filter((u) => typeof u === 'string' && u)), profiles);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i % 25 === 0) {
      checkAbort(signal);
      onProgress?.({ fetched: rows.length, decrypted: i, phase: 'decrypt' });
    }
    const m = rows[i];
    let body = null;
    let error = null;
    if (m.body !== undefined || m.error !== undefined) {
      // Already decrypted by the open chat.
      body = m.body || null;
      error = m.error || null;
    } else if (!m.deleted) {
      try {
        body = await decryptMessage(key, conv, m.mid, m);
      } catch (e) {
        error = e;
      }
    }
    out.push(toRecord(m, body, names, error));
  }
  onProgress?.({ fetched: rows.length, decrypted: rows.length, phase: 'done' });
  return out;
}

/** Records -> { text, mime, ext } for 'markdown' | 'json'. */
export function renderExport(records, format, meta) {
  if (format === 'json') return { text: toJson(records, meta), mime: 'application/json', ext: 'json' };
  return { text: toMarkdown(records, meta), mime: 'text/markdown', ext: 'md' };
}

/** Save text as a file through a temporary download link. */
export function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

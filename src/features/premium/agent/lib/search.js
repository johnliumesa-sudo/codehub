// Text / regex search across workspace files. Pure, so it runs in the unit tests, inline for plain
// text, and inside a Web Worker for regular expressions (searchWorker.js): a pathological pattern
// can backtrack for a long time, and the worker is terminated after a timeout instead of freezing
// the page.

export const MAX_MATCHES = 200;
const MAX_LINE_CHARS = 2000; // a line longer than this is searched (and shown) only up to here
const SHOW_CHARS = 240;

/** Build the matcher; throws a friendly Error for an invalid regex. */
export function makeMatcher({ query, regex = false, caseSensitive = false }) {
  const q = String(query ?? '');
  if (!q) throw new Error('The search query is empty.');
  if (regex) {
    let re;
    try {
      re = new RegExp(q, caseSensitive ? 'u' : 'iu');
    } catch (e) {
      throw new Error(`Invalid regular expression: ${String(e?.message || e).slice(0, 200)}`);
    }
    return (line) => re.test(line);
  }
  if (caseSensitive) return (line) => line.includes(q);
  const lq = q.toLowerCase();
  return (line) => line.toLowerCase().includes(lq);
}

/**
 * files: [{ path, text }]. -> { matches: ["path:line: text"], total, truncated, filesSearched }
 */
export function searchFiles(files, { query, regex = false, caseSensitive = false, pathPrefix = '' } = {}) {
  const match = makeMatcher({ query, regex, caseSensitive });
  const prefix = String(pathPrefix || '');
  const out = [];
  let total = 0;
  let filesSearched = 0;
  for (const f of files) {
    if (prefix && !f.path.startsWith(prefix)) continue;
    filesSearched += 1;
    const lines = String(f.text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].length > MAX_LINE_CHARS ? lines[i].slice(0, MAX_LINE_CHARS) : lines[i];
      if (!match(line)) continue;
      total += 1;
      if (out.length < MAX_MATCHES) {
        const shown = line.trim();
        out.push(`${f.path}:${i + 1}: ${shown.length > SHOW_CHARS ? `${shown.slice(0, SHOW_CHARS)}…` : shown}`);
      }
    }
  }
  return { matches: out, total, truncated: total > out.length, filesSearched };
}

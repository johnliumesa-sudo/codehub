// Runs searchFiles off the main thread (see search.js). Message in: { files, opts }; out: { ok, result }
// or { ok: false, error }. The page terminates this worker when it takes too long.
import { searchFiles } from './search.js';

self.onmessage = (e) => {
  try {
    const { files, opts } = e.data || {};
    self.postMessage({ ok: true, result: searchFiles(Array.isArray(files) ? files : [], opts || {}) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};

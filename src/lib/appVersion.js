// "Codehub has been updated": open tabs notice a deploy and recover from missing lazy chunks.
//
// The build writes version.json ({ v: git short sha, t: build time }) next to index.html and defines the
// same object as __CODEHUB_BUILD__ (vite.config.js; the dev server serves it too). A watcher fetches
// version.json (no-store plus a cache-busting query, resolved against the page so the GitHub Pages
// sub-path /codehub/ is kept) on start, every 5 minutes while visible, and when the tab becomes visible
// or comes back online. A different id shows the update banner (UpdateBanner.jsx); "Later" hides it
// until a newer id appears. Version changes never reload the page by themselves.
//
// A deploy deletes the old hashed chunks, so an old tab's lazy views fail to load. Vite reports those as
// `vite:preloadError`; error boundaries report dynamic-import failures through reportLoadError(). The
// tab then reloads once on its own, but only when nothing could be lost (no text in a field, no editable
// focused, no call, online) and the sessionStorage guard allows it: never twice from the same build and
// never twice within 5 minutes, so a broken deploy can't loop. Otherwise the banner asks for a reload.
//
// Everything above the browser wiring is pure and injectable (tests/unit/update.test.mjs).

export const VERSION_FILE = 'version.json';
export const CHECK_EVERY_MS = 5 * 60_000;
export const RELOAD_KEY = 'codehub.autoReload';
export const AUTO_RELOAD_GAP_MS = 5 * 60_000;

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const IDLE = Object.freeze({ kind: null });

const timeOf = (t) => {
  const n = typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** A version record from version.json, or null if it isn't one. */
export function parseVersion(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.v !== 'string' || !ID_RE.test(x.v)) return null;
  return { v: x.v, t: timeOf(x.t) };
}

/**
 * Whether `remote` is a different build that should replace `running`. A copy that is older than the
 * running build (a stale CDN edge right after a deploy) is not; a rebuilt older commit has a newer t.
 */
export function isNewVersion(running, remote) {
  if (!running || !remote || remote.v === running.v) return false;
  return !(running.t != null && remote.t != null && remote.t < running.t);
}

/** version.json next to the page (keeps the /codehub/ sub-path), with a cache-busting query. */
export function versionUrl(base, now) {
  const u = new URL(VERSION_FILE, base);
  u.searchParams.set('t', String(now));
  return u.href;
}

const CHUNK_RE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|unable to preload css|loading (?:css )?chunk \S+ failed/i;

/** A failed lazy import (missing chunk after a deploy, or the network dropped while loading it). */
export function isChunkLoadError(err) {
  if (!err) return false;
  if (err.name === 'ChunkLoadError') return true;
  return CHUNK_RE.test(String(err.message || err));
}

const TEXT_INPUT = /^(?:|text|search|email|url|tel|password|number)$/;

function isEditable(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_INPUT.test(String(el.type || '').toLowerCase());
  return !!el.isContentEditable;
}

const shown = (el) => typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;

/** True when a reload could lose something the user typed: an editable is focused or a visible field has text. */
export function mightLoseInput(doc) {
  if (!doc) return true;
  if (isEditable(doc.activeElement)) return true;
  for (const el of doc.querySelectorAll('textarea, input, [contenteditable]')) {
    if (!isEditable(el) || !shown(el)) continue;
    const text = el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' ? el.textContent : el.value;
    if (String(text || '').trim()) return true;
  }
  return false;
}

/**
 * Loop guard for the automatic reload after a chunk failure. Allowed only when nothing could be lost, the
 * record is readable and writable, the last automatic reload did not start from this same build, and it
 * was at least AUTO_RELOAD_GAP_MS ago. Records the reload (from build, time) when it allows one.
 */
export function claimAutoReload({ storage, running, now, busy = false }) {
  if (busy || !running) return false;
  try {
    let last = null;
    try {
      last = JSON.parse(storage.getItem(RELOAD_KEY) || 'null');
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
    if (last && typeof last === 'object') {
      if (last.from === running) return false;
      if (typeof last.at === 'number' && Math.abs(now - last.at) < AUTO_RELOAD_GAP_MS) return false;
    }
    storage.setItem(RELOAD_KEY, JSON.stringify({ from: running, at: now }));
    return JSON.parse(storage.getItem(RELOAD_KEY) || 'null')?.from === running;
  } catch {
    return false; // storage blocked: without a record a reload could repeat, so ask instead
  }
}

/**
 * The update state machine. State: { kind: null } | { kind: 'update', v } | { kind: 'chunk', offline }.
 * deps: running ({ v, t }), url(now), fetch, storage, reload(), busy(), online(), now().
 */
export function createUpdateWatcher(deps) {
  const { running, url, fetch: fetchImpl, storage, reload, busy = () => false, online = () => true, now = Date.now } = deps;
  let state = IDLE;
  let latest = null; // newest differing build seen
  let dismissed = null; // build id the user put off with "Later"
  let inflight = null;
  let reloading = false;
  const listeners = new Set();

  const set = (next) => {
    state = Object.freeze(next);
    for (const fn of [...listeners]) fn(state);
  };

  async function fetchRemote() {
    const res = await fetchImpl(url(now()), { cache: 'no-store', credentials: 'omit' });
    if (!res || !res.ok) return;
    const remote = parseVersion(await res.json());
    if (!remote) return;
    if (!isNewVersion(running, remote)) {
      latest = null;
      if (state.kind === 'update') set(IDLE);
      return;
    }
    latest = remote;
    if (remote.v !== dismissed && state.kind !== 'chunk') set({ kind: 'update', v: remote.v });
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Fetch version.json once (concurrent calls share the request). Errors are ignored: try again later. */
    check() {
      if (!running) return Promise.resolve();
      if (!inflight) inflight = fetchRemote().catch(() => {}).finally(() => { inflight = null; });
      return inflight;
    },
    /** A lazy import failed. Returns false for unrelated errors. `known` skips the message test (vite:preloadError). */
    loadFailed(err, known = false) {
      if (!known && !isChunkLoadError(err)) return false;
      if (reloading) return true;
      const off = !online();
      let lose = true;
      try {
        lose = busy();
      } catch {
        /* treat as busy */
      }
      if (!off && claimAutoReload({ storage, running: running?.v, now: now(), busy: lose })) {
        reloading = true;
        reload();
        return true;
      }
      set({ kind: 'chunk', offline: off });
      return true;
    },
    /** "Later": hide until a newer build (or another load failure) shows up. */
    dismiss() {
      if (latest) dismissed = latest.v;
      set(IDLE);
    },
    reload() {
      reloading = true;
      reload();
    },
  };
}

// ---------- browser wiring ----------

/** The running build's { v, t }, or null outside a Vite build (node tests). */
export const RUNNING_BUILD = parseVersion(
  // eslint-disable-next-line no-undef
  typeof __CODEHUB_BUILD__ !== 'undefined' ? __CODEHUB_BUILD__ : null,
);

let watcher = null;

/** Start the app-wide watcher once (main.jsx). `busy()` adds app state a reload would lose (an active call). */
export function startUpdateWatch({ busy } = {}) {
  if (watcher || typeof window === 'undefined') return watcher;
  watcher = createUpdateWatcher({
    running: RUNNING_BUILD,
    url: (now) => versionUrl(document.baseURI, now),
    fetch: (...a) => window.fetch(...a),
    storage: {
      getItem: (k) => window.sessionStorage.getItem(k),
      setItem: (k, v) => window.sessionStorage.setItem(k, v),
    },
    reload: () => window.location.reload(),
    busy: () => mightLoseInput(document) || !!busy?.(),
    online: () => navigator.onLine !== false,
  });
  const check = () => {
    if (document.visibilityState !== 'hidden') watcher.check();
  };
  // Vite's preload helper: dispatched for a missing chunk or its CSS; not cancelled, so the import still
  // rejects and the view's error boundary shows its own notice under the banner.
  window.addEventListener('vite:preloadError', (e) => watcher.loadFailed(e.payload, true));
  window.addEventListener('unhandledrejection', (e) => watcher.loadFailed(e.reason));
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  setInterval(check, CHECK_EVERY_MS);
  check();
  return watcher;
}

export const getUpdateWatcher = () => watcher;

/** Error boundaries pass caught errors here; failed lazy imports show the reload banner. */
export function reportLoadError(err) {
  return watcher ? watcher.loadFailed(err) : false;
}

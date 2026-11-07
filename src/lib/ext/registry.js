// Round 3 extension registries: named, ordered lists of entries that feature folders
// (src/features/*) fill at start-up and the core UI renders. See ARCHITECTURE.md
// "Round 3: extension points" for every registry's entry shape and ctx.
//
//   register(name, entry) -> unregister()   entry = { id: string, order?: number, ... }
//                                           (an entry without id but with a string `name` uses the name)
//   list(name)            -> entries sorted by order (default 0), then registration order
//   subscribe(name, fn)   -> unsubscribe()
//   useRegistry(name)     -> list(name), re-rendering when it changes
//
// Registering an id that already exists replaces that entry in place of the old one. The returned
// unregister function only removes the entry it registered (not a later replacement).
import { useSyncExternalStore } from 'react';

/** The registries the core UI renders (others may be created freely between features). */
export const REGISTRIES = Object.freeze([
  'messageActions',
  'messageBadges',
  'messageExtras',
  'composerButtons',
  'sendHooks',
  'slashCommands',
  'chatHeaderButtons',
  'chatPanels',
  'userSettingsTabs',
  'serverSettingsTabs',
  'paletteActions',
  'profileSections',
  'sidebarSections',
  'appMounts',
  'chatMounts',
  'serverCreateOptions',
]);

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const EMPTY = Object.freeze([]);
const stores = new Map(); // name -> { entries: [{ entry, seq }], snapshot, listeners }
let seq = 0;

function storeFor(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`Invalid registry name: ${String(name)}`);
  let s = stores.get(name);
  if (!s) {
    s = { entries: [], snapshot: EMPTY, listeners: new Set() };
    stores.set(name, s);
  }
  return s;
}

const orderOf = (e) => (typeof e.order === 'number' && Number.isFinite(e.order) ? e.order : 0);

function publish(s) {
  s.snapshot = Object.freeze(
    [...s.entries].sort((a, b) => orderOf(a.entry) - orderOf(b.entry) || a.seq - b.seq).map((x) => x.entry),
  );
  for (const fn of [...s.listeners]) {
    try {
      fn(s.snapshot);
    } catch (e) {
      console.error('[ext] registry listener failed', e);
    }
  }
}

/** Add (or replace, by id) an entry. Returns a function that removes exactly this entry. */
export function register(name, entry) {
  const s = storeFor(name);
  // Entries keyed by `name` (slash commands) may omit the id.
  if (entry && typeof entry === 'object' && !entry.id && typeof entry.name === 'string' && entry.name) entry = { ...entry, id: entry.name };
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
    throw new Error(`register(${name}): entry needs a non-empty string id`);
  }
  const at = s.entries.findIndex((x) => x.entry.id === entry.id);
  const item = { entry, seq: at >= 0 ? s.entries[at].seq : ++seq };
  if (at >= 0) s.entries = s.entries.map((x, i) => (i === at ? item : x));
  else s.entries = [...s.entries, item];
  publish(s);
  return () => {
    const i = s.entries.indexOf(item);
    if (i < 0) return;
    s.entries = s.entries.filter((x) => x !== item);
    publish(s);
  };
}

/** Remove the entry with this id, whoever registered it. */
export function unregister(name, id) {
  const s = storeFor(name);
  const next = s.entries.filter((x) => x.entry.id !== id);
  if (next.length === s.entries.length) return false;
  s.entries = next;
  publish(s);
  return true;
}

/** Entries sorted by `order` then registration order. The array is frozen and only changes identity on change. */
export function list(name) {
  return storeFor(name).snapshot;
}

/** Look up one entry by id. */
export function get(name, id) {
  return list(name).find((e) => e.id === id) || null;
}

export function subscribe(name, fn) {
  const s = storeFor(name);
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

/** React hook: the registry's entries, re-rendering when they change. */
export function useRegistry(name) {
  return useSyncExternalStore(
    (fn) => subscribe(name, fn),
    () => list(name),
    () => list(name),
  );
}

/** Tests only: drop every entry of every registry (or of one). */
export function _resetRegistries(name) {
  for (const [n, s] of stores) {
    if (name && n !== name) continue;
    s.entries = [];
    publish(s);
  }
}

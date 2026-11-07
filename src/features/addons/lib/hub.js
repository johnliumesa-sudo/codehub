// Open/close state of the add-on hub (directory, my add-ons, builder). The hub itself is mounted
// once through appMounts; anything (palette actions, panels, settings tabs) opens it from here.
import { useSyncExternalStore } from 'react';

const CLOSED = Object.freeze({ open: false, view: 'browse', id: null, seq: 0 });
let state = CLOSED;
const listeners = new Set();

function publish(next) {
  state = next;
  listeners.forEach((fn) => fn());
}

/** Open the hub. view: 'browse' | 'details' (with id) | 'mine' | 'build' (id = add-on to edit, optional). */
export function openHub({ view = 'browse', id = null } = {}) {
  publish({ open: true, view, id: id || null, seq: state.seq + 1 });
}

export function closeHub() {
  if (state.open) publish({ ...CLOSED, seq: state.seq + 1 });
}

export function useHub() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}

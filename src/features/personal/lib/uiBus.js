// One dialog at a time for the personal features (custom status, server folder editor), opened from
// anywhere (palette actions, menus) and rendered by the PersonalHost app mount.
import { useSyncExternalStore } from 'react';

let state = null; // { name, props } | null
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn());
}

/** Open dialog `name` ('status' | 'folder') with props. Replaces an open one. */
export function openPersonalDialog(name, props = {}) {
  state = { name, props };
  emit();
}

export function closePersonalDialog() {
  if (!state) return;
  state = null;
  emit();
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => state;

export function usePersonalDialog() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

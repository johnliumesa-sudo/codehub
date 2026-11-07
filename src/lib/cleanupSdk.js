// The Firebase-backed writes for cleanupUpdate.js, loaded on first use. A separate module so that
// cleanupUpdate.js stays importable without Firebase (unit tests pass their own `deps`) and the
// bundler never sees a dynamic import of modules the app also imports statically.
import { ref, remove, update } from 'firebase/database';
import { db } from './firebase.js';

export const sdkDeps = {
  update: (patch) => update(ref(db), patch),
  remove: (path) => remove(ref(db, path)),
};

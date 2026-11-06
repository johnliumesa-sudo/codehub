// Mounted once in Workspace. Applies the equipped app theme to the document and publishes the
// equipped editor add-ons for every CollabEditor via useEditorAddons().
//
// The CodeMirror implementations (src/lib/addons/runtime.js) are loaded with a dynamic import, so
// CodeMirror stays out of the main bundle; it shares the lazily loaded collab chunk.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { equippedItem, resolveEditorAddons } from '../../lib/addons/registry.js';
import { applyThemeTokens } from '../../lib/addons/themeTokens.js';
import { useCatalog, useEquipped } from '../../lib/shop.js';

// ---------- module store: resolved editor spec -> CodeMirror extensions ----------

const NONE = Object.freeze([]);
const DEFAULT_SPEC = Object.freeze({ theme: null, exts: [] });
let spec = DEFAULT_SPEC;
let specKey = '';
let runtime = null; // loaded module
let loading = null;
let extensions = NONE;
const listeners = new Set();

function recompute() {
  extensions = runtime ? runtime.extensionsForSpec(spec) : NONE;
  listeners.forEach((l) => l());
}

function ensureRuntime() {
  if (runtime || loading) return;
  loading = import('../../lib/addons/runtime.js')
    .then((m) => {
      runtime = m;
      recompute();
    })
    .catch((e) => {
      console.error('[addons] editor runtime failed to load', e);
      loading = null;
    });
}

function setSpec(next) {
  const key = JSON.stringify(next);
  if (key === specKey) return;
  specKey = key;
  spec = next;
  recompute();
}

function subscribe(fn) {
  listeners.add(fn);
  ensureRuntime();
  return () => listeners.delete(fn);
}
const getSnapshot = () => extensions;

/**
 * CodeMirror extension array for the signed-in user's equipped editor add-ons:
 * `[editorTheme (one-dark when none is equipped), ...enabled add-ons]`.
 * Returns an empty array until the runtime chunk has loaded (keep your own `oneDark` until then).
 * The array identity only changes when the equipped editor setup changes, so it is safe to use as
 * an effect dependency for `compartment.reconfigure(...)`.
 */
export function useEditorAddons() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------- component ----------

/**
 * Props: { uid, children? }. Renders its children unchanged (or nothing).
 */
export default function AddonRuntime({ uid, children = null }) {
  const { equipped } = useEquipped(uid);
  const { byId } = useCatalog();

  const tokens = useMemo(() => equippedItem(equipped, byId, 'theme')?.data.tokens || null, [equipped, byId]);
  const tokensKey = tokens ? JSON.stringify(tokens) : '';

  useEffect(() => {
    applyThemeTokens(tokensKey ? JSON.parse(tokensKey) : null);
  }, [tokensKey]);

  // Restore the stylesheet defaults when the workspace unmounts (lock / sign-out / account switch).
  useEffect(() => () => applyThemeTokens(null), []);

  useEffect(() => {
    if (!uid) return;
    setSpec(resolveEditorAddons(equipped, byId));
  }, [uid, equipped, byId]);

  useEffect(() => {
    ensureRuntime();
    return () => setSpec(DEFAULT_SPEC);
  }, [uid]);

  return children;
}

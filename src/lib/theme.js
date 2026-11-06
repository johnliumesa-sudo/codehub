// Theme preference (dark | light | system). Pure client state: stored in localStorage `codehub.theme`,
// never sent anywhere. The RESOLVED theme (dark | light) is written to <html data-theme="...">;
// CSS tokens in styles.css key off that attribute. In 'system' mode it follows prefers-color-scheme live.
//
// Applied before React renders via THEME_BOOT_SNIPPET-equivalent code in main.jsx (see initTheme()).
import { useSyncExternalStore } from 'react';

export const THEME_KEY = 'codehub.theme';
export const THEME_EVENT = 'codehub:theme';
export const THEMES = ['dark', 'light', 'system'];
const MQ = '(prefers-color-scheme: light)';

const isTheme = (v) => v === 'dark' || v === 'light' || v === 'system';

/** Stored preference; 'system' when nothing (or garbage) is stored or storage is unavailable. */
export function getTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersLight() {
  try {
    return typeof matchMedia === 'function' && matchMedia(MQ).matches;
  } catch {
    return false;
  }
}

/** Resolve a preference to the concrete 'dark' | 'light'. */
export function resolveTheme(pref = getTheme()) {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return systemPrefersLight() ? 'light' : 'dark';
}

/** The theme currently in effect ('dark' | 'light'). */
export const getResolvedTheme = () => resolveTheme(getTheme());

let snapshot = null; // cached { theme, resolved } so useSyncExternalStore sees a stable object
const listeners = new Set();

function compute() {
  const theme = getTheme();
  const resolved = resolveTheme(theme);
  if (!snapshot || snapshot.theme !== theme || snapshot.resolved !== resolved) snapshot = { theme, resolved };
  return snapshot;
}

function apply() {
  const { resolved } = compute();
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== resolved) root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f2f4f9' : '#0b0d12');
}

function notify() {
  apply();
  listeners.forEach((l) => l());
  try {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: compute() }));
  } catch {
    /* non-browser */
  }
}

/** Persist and apply a preference. Unknown values are ignored. */
export function setTheme(pref) {
  if (!isTheme(pref)) return;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage blocked: the choice still applies for this session through the snapshot below */
    snapshot = { theme: pref, resolved: resolveTheme(pref) };
  }
  // Briefly suppress transitions so the whole UI flips at once.
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.classList.add('theme-no-anim');
    setTimeout(() => root.classList.remove('theme-no-anim'), 60);
  }
  notify();
}

/** Cycle dark -> light -> system -> dark; returns the new preference. */
export function cycleTheme() {
  const order = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(getTheme()) + 1) % order.length];
  setTheme(next);
  return next;
}

/** Subscribe to preference or resolved-theme changes (incl. OS changes and other tabs). */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let started = false;
/**
 * Apply the stored theme now and keep it in sync (OS scheme changes in 'system' mode, other tabs).
 * Idempotent. Call once from main.jsx before createRoot().
 */
export function initTheme() {
  apply();
  if (started || typeof window === 'undefined') return;
  started = true;
  try {
    const mq = matchMedia(MQ);
    const onMq = () => {
      if (getTheme() === 'system') notify();
    };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  } catch {
    /* no matchMedia */
  }
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === null) notify();
  });
}

const subscribe = (fn) => onThemeChange(fn);
const getSnapshot = () => compute();

/** React hook -> { theme: 'dark'|'light'|'system', resolved: 'dark'|'light', setTheme, cycleTheme }. */
export function useTheme() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { theme: s.theme, resolved: s.resolved, setTheme, cycleTheme };
}

/**
 * Command-palette action descriptor. Same shape as palette items (id/kind/title/subtitle/keywords)
 * plus `run()`; the palette host calls run() on selection instead of navigating.
 */
export function themePaletteActions() {
  const cur = getTheme();
  const mk = (theme, title, extra = []) => ({
    id: `action:theme:${theme}`,
    kind: 'action',
    title,
    subtitle: cur === theme ? 'Appearance (current)' : 'Appearance',
    keywords: ['theme', 'appearance', 'dark', 'light', 'mode', ...extra],
    run: () => setTheme(theme),
  });
  return [
    {
      id: 'action:theme:toggle',
      kind: 'action',
      title: 'Toggle dark / light theme',
      subtitle: 'Appearance',
      keywords: ['theme', 'appearance', 'dark', 'light', 'mode', 'switch'],
      run: () => setTheme(getResolvedTheme() === 'light' ? 'dark' : 'light'),
    },
    mk('dark', 'Theme: Dark'),
    mk('light', 'Theme: Light'),
    mk('system', 'Theme: Match system', ['auto', 'os']),
  ];
}

/**
 * Self-contained pre-render script for index.html / main.jsx (no imports, safe if storage is blocked).
 * Prevents a flash of the wrong theme. Keep in sync with resolveTheme().
 */
export const THEME_BOOT_SNIPPET =
  "(function(){try{var t=localStorage.getItem('codehub.theme');if(t!=='dark'&&t!=='light')t='system';" +
  "var l=t==='light'||(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches);" +
  "var r=l?'light':'dark';document.documentElement.setAttribute('data-theme',r);document.documentElement.style.colorScheme=r;}" +
  "catch(e){document.documentElement.setAttribute('data-theme','dark');}})();";

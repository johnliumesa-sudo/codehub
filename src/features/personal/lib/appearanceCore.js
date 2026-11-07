// Appearance settings: pure helpers and the pre-paint boot snippet (no Firebase imports; unit-tested).
//
// Stored in this browser's localStorage `codehub.appearance` (JSON) and, when "Sync" is on, mirrored
// to udata/{me}/appearance/prefs (owner-only; plain enum/number values, nothing typed by the user).
// Applied on <html>: classes ap-compact, ap-font (+ --ap-font-scale), ap-reduce-motion,
// ap-focus-rings; attributes data-ap-width (wide|medium|narrow) and data-ap-clock (12|24).

export const APPEARANCE_KEY = 'codehub.appearance';
export const APPEARANCE_EVENT = 'codehub:appearance';

export const DENSITIES = Object.freeze(['cozy', 'compact']);
export const WIDTHS = Object.freeze(['full', 'wide', 'medium', 'narrow']);
export const WIDTH_LABEL = Object.freeze({ full: 'Full width', wide: 'Wide (1100 px)', medium: 'Medium (880 px)', narrow: 'Narrow (720 px)' });
export const CLOCKS = Object.freeze(['auto', '12', '24']);
export const CLOCK_LABEL = Object.freeze({ auto: 'Use my language setting', 12: '12-hour (2:30 PM)', 24: '24-hour (14:30)' });
export const FONT_MIN = 90;
export const FONT_MAX = 130;
export const FONT_STEP = 5;

export const DEFAULT_APPEARANCE = Object.freeze({
  density: 'cozy',
  font: 100,
  reduceMotion: false,
  focusRings: false,
  chatWidth: 'full',
  clock: 'auto',
});
const FIELDS = Object.keys(DEFAULT_APPEARANCE);

/** Validate anything (stored JSON, the synced record) into a full settings object. */
export function cleanAppearance(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const f = Math.round(Number(r.font));
  return {
    density: DENSITIES.includes(r.density) ? r.density : 'cozy',
    font: f >= FONT_MIN && f <= FONT_MAX ? f : 100, // out of range = default, like the boot snippet
    reduceMotion: r.reduceMotion === true,
    focusRings: r.focusRings === true,
    chatWidth: WIDTHS.includes(r.chatWidth) ? r.chatWidth : 'full',
    clock: CLOCKS.includes(r.clock) ? r.clock : 'auto',
  };
}

/** True when two settings objects are the same (after cleaning). */
export function sameAppearance(a, b) {
  const x = cleanAppearance(a);
  const y = cleanAppearance(b);
  return FIELDS.every((k) => x[k] === y[k]);
}

/**
 * What to put on <html> for these settings: { classes: {name: on}, vars: {name: value|null},
 * attrs: {name: value|null} }. `systemReduce` = the device asks for reduced motion.
 */
export function appearanceAttrs(prefs, systemReduce = false) {
  const p = cleanAppearance(prefs);
  return {
    classes: {
      'ap-compact': p.density === 'compact',
      'ap-font': p.font !== 100,
      'ap-reduce-motion': p.reduceMotion || !!systemReduce,
      'ap-focus-rings': p.focusRings,
    },
    vars: { '--ap-font-scale': p.font !== 100 ? String(p.font / 100) : null },
    attrs: {
      'data-ap-width': p.chatWidth !== 'full' ? p.chatWidth : null,
      'data-ap-clock': p.clock !== 'auto' ? p.clock : null,
    },
  };
}

/** Apply settings to an element (document.documentElement in the app). */
export function applyAppearanceTo(root, prefs, systemReduce = false) {
  if (!root) return;
  const { classes, vars, attrs } = appearanceAttrs(prefs, systemReduce);
  for (const [c, on] of Object.entries(classes)) root.classList.toggle(c, on);
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null) root.removeAttribute(k);
    else root.setAttribute(k, v);
  }
}

/** Intl options for a clock time (hours + minutes) in the chosen format. */
export function clockOptions(clock) {
  const base = { hour: 'numeric', minute: '2-digit' };
  if (clock === '12') return { ...base, hourCycle: 'h12' };
  if (clock === '24') return { ...base, hourCycle: 'h23' };
  return base;
}

/** "2:30 PM" / "14:30" for a timestamp, honoring the chosen clock. */
export function formatClock(ts, clock = 'auto', locale = undefined) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString(locale, clockOptions(clock));
}

/**
 * Self-contained pre-render script, inlined verbatim in index.html's <head> right after the theme
 * script (no imports, safe when storage is blocked). Mirrors appearanceAttrs(); the unit test
 * tests/unit/personal.test.mjs checks both, and that index.html carries this exact string.
 */
export const APPEARANCE_BOOT_SNIPPET =
  "(function(){try{var a=null,d=document.documentElement,c=d.classList;try{a=JSON.parse(localStorage.getItem('codehub.appearance')||'{}');}catch(e){}" +
  "if(!a||typeof a!=='object')a={};var f=Math.round(+a.font);" +
  "if(a.density==='compact')c.add('ap-compact');" +
  "if(f>=90&&f<=130&&f!==100){c.add('ap-font');d.style.setProperty('--ap-font-scale',String(f/100));}" +
  "if(a.reduceMotion===true||matchMedia('(prefers-reduced-motion: reduce)').matches)c.add('ap-reduce-motion');" +
  "if(a.focusRings===true)c.add('ap-focus-rings');" +
  "if(a.chatWidth==='wide'||a.chatWidth==='medium'||a.chatWidth==='narrow')d.setAttribute('data-ap-width',a.chatWidth);" +
  "if(a.clock==='12'||a.clock==='24')d.setAttribute('data-ap-clock',a.clock);}catch(e){}})();";

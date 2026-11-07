// Add-on registry: the bundled, first-party catalog and the validators every catalog item goes through.
//
// Shop items are DATA ONLY. An item never carries a URL, CSS, HTML or JS. All behavior comes from the
// first-party modules named here by `builtinId` (editorThemes.js / editorExts.js); unknown builtinIds
// are ignored. An editor theme may instead carry eleven color tokens that the first-party generator in
// editorPalette.js turns into a CodeMirror theme. This file deliberately imports nothing from CodeMirror
// so it can live in the main bundle (Cosmetics, ShopView) while the editor implementations stay in the
// lazily loaded collab chunk.
//
// Community items (round 3): any signed-in user may create `theme`, `badge`, `nameColor` and token-based
// `editorTheme` items; they carry `by` (creator uid) and `createdAt`. Items without `by` are the official
// catalog, written only by app admins, and are the only ones that may name a bundled module (`builtinId`).
import { contrast } from './color.js';
import { cleanEditorTokens, editorTokensProblem } from './editorPalette.js';

export const KINDS = ['theme', 'editorTheme', 'editorExt', 'badge', 'nameColor'];

/** Kinds any signed-in user may create (editor themes only as color tokens; editorExt stays admin-only). */
export const CREATOR_KINDS = ['theme', 'editorTheme', 'badge', 'nameColor'];

export const KIND_LABELS = {
  theme: 'App theme',
  editorTheme: 'Editor theme',
  editorExt: 'Editor add-on',
  badge: 'Badge',
  nameColor: 'Name color',
};

export const KIND_PLURAL = {
  theme: 'App themes',
  editorTheme: 'Editor themes',
  editorExt: 'Editor add-ons',
  badge: 'Badges',
  nameColor: 'Name colors',
};

/** Single-choice equip slots (`equipped/{uid}/{slot}` = itemId). editorExt uses `equipped/{uid}/ext/{itemId}`. */
export const SLOTS = ['theme', 'editorTheme', 'badge', 'nameColor'];
export const slotForKind = (kind) => (SLOTS.includes(kind) ? kind : null);

/** App theme token keys -> CSS custom properties. Fixed; nothing else is ever written to the document. */
export const TOKEN_VARS = {
  bg0: '--bg-0',
  bg1: '--bg-1',
  bg2: '--bg-2',
  bg3: '--bg-3',
  bgHover: '--bg-hover',
  border: '--border',
  text: '--text',
  textDim: '--text-dim',
  textFaint: '--text-faint',
  accent: '--accent',
  accent2: '--accent-2',
  ok: '--ok',
  warn: '--warn',
  danger: '--danger',
};
export const TOKEN_KEYS = Object.keys(TOKEN_VARS);

export const TOKEN_LABELS = {
  bg0: 'Background (rail)',
  bg1: 'Background (sidebar)',
  bg2: 'Background (main)',
  bg3: 'Inputs & cards',
  bgHover: 'Hover',
  border: 'Border',
  text: 'Text',
  textDim: 'Text (dim)',
  textFaint: 'Text (faint)',
  accent: 'Accent',
  accent2: 'Accent 2',
  ok: 'Success',
  warn: 'Warning',
  danger: 'Danger',
};

/** Mirrors the defaults in src/styles.css (used as the starting point in the catalog editor). */
export const BASE_TOKENS = {
  bg0: '#0b0d12',
  bg1: '#11141b',
  bg2: '#161a23',
  bg3: '#1d2230',
  bgHover: '#232a3a',
  border: '#262d3d',
  text: '#e6e9f0',
  textDim: '#9aa3b5',
  textFaint: '#6b7487',
  accent: '#5b8cff',
  accent2: '#a66bff',
  ok: '#3ccf91',
  warn: '#f5c542',
  danger: '#ff5c7a',
};

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const UID_RE = /^[A-Za-z0-9]{1,128}$/; // Firebase Auth uids never contain '_' (earning keys rely on it)
export const BUILTIN_RE = /^[a-z0-9-]{1,32}$/;
export const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const NAME_MAX = 48;
export const DESC_MAX = 280;
export const GLYPH_MAX = 8;
export const PRICE_MAX = 10000;

// ---------------------------------------------------------------------------------------------
// Bundled editor modules (metadata only; the CodeMirror implementations live in editorThemes.js /
// editorExts.js under the same ids). `preview` colors drive the shop's static code preview.
// ---------------------------------------------------------------------------------------------

export const EDITOR_THEME_INFO = {
  'one-dark': {
    label: 'One Dark',
    dark: true,
    preview: { bg: '#282c34', fg: '#abb2bf', keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#7d8799', fn: '#61afef', type: '#e5c07b', gutter: '#7d8799' },
  },
  'codehub-midnight': {
    label: 'Codehub Midnight',
    dark: true,
    preview: { bg: '#0f1320', fg: '#d6deeb', keyword: '#a66bff', string: '#3ccf91', number: '#ff8f4d', comment: '#5b6478', fn: '#5b8cff', type: '#2bc4d9', gutter: '#4b5366' },
  },
  'solarized-dark': {
    label: 'Solarized Dark',
    dark: true,
    preview: { bg: '#002b36', fg: '#93a1a1', keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#586e75', fn: '#268bd2', type: '#b58900', gutter: '#586e75' },
  },
  'paper-light': {
    label: 'Paper Light',
    dark: false,
    preview: { bg: '#fbfaf6', fg: '#2b2f36', keyword: '#8a3ffc', string: '#1a7f37', number: '#b35900', comment: '#8b929c', fn: '#0550ae', type: '#953800', gutter: '#a0a7b1' },
  },
  'dracula-ish': {
    label: 'Dracula-ish',
    dark: true,
    preview: { bg: '#22212c', fg: '#f8f8f2', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', comment: '#7970a9', fn: '#50fa7b', type: '#8be9fd', gutter: '#6c6783' },
  },
};

export const EDITOR_EXT_INFO = {
  'line-wrap': { label: 'Line wrapping', glyph: '↩' },
  whitespace: { label: 'Show whitespace', glyph: '·' },
  'trailing-ws': { label: 'Highlight trailing whitespace', glyph: '␣' },
  'scroll-past-end': { label: 'Scroll past end', glyph: '⇣' },
  'active-line': { label: 'Bright active line', glyph: '▤' },
  'rainbow-brackets': { label: 'Rainbow brackets', glyph: '{}' },
  'indent-guides': { label: 'Indent guides', glyph: '┆' },
  'big-cursor': { label: 'Big cursor', glyph: '▍' },
};

export const isKnownEditorTheme = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(EDITOR_THEME_INFO, id);
export const isKnownEditorExt = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(EDITOR_EXT_INFO, id);

// ---------------------------------------------------------------------------------------------
// Default catalog (seeded by an app admin from the Admin panel). Ids are stable so re-seeding is
// idempotent and inventory/equipped references survive.
// ---------------------------------------------------------------------------------------------

const theme = (id, name, desc, price, tokens) => ({ id, name, desc, kind: 'theme', price, data: { tokens } });
const edTheme = (id, name, desc, price, builtinId) => ({ id, name, desc, kind: 'editorTheme', price, data: { builtinId } });
const edExt = (id, name, desc, price, builtinId) => ({ id, name, desc, kind: 'editorExt', price, data: { builtinId } });
const badge = (id, name, desc, price, glyph) => ({ id, name, desc, kind: 'badge', price, data: { glyph } });
const nameColor = (id, name, desc, price, color) => ({ id, name, desc, kind: 'nameColor', price, data: { color } });

export const DEFAULT_CATALOG = [
  // App themes
  theme('theme-aurora', 'Aurora', 'Deep teal surfaces with a mint accent and a violet secondary.', 400, {
    bg0: '#070f12', bg1: '#0c171b', bg2: '#102026', bg3: '#162a31', bgHover: '#1d3640', border: '#1f3a43',
    text: '#e3f2f1', textDim: '#93b3b4', textFaint: '#5f7f82', accent: '#2bd4b4', accent2: '#8b7bff',
    ok: '#3ccf91', warn: '#f5c542', danger: '#ff5c7a',
  }),
  theme('theme-ember', 'Ember', 'Warm charcoal with glowing orange highlights.', 400, {
    bg0: '#110b09', bg1: '#18110e', bg2: '#1f1612', bg3: '#2a1e18', bgHover: '#35261e', border: '#3a2a21',
    text: '#f3e9e3', textDim: '#b8a395', textFaint: '#826f63', accent: '#ff8f4d', accent2: '#ff5c7a',
    ok: '#7bd88f', warn: '#f5c542', danger: '#ff4d5e',
  }),
  theme('theme-forest', 'Forest', 'Mossy greens for long late-night sessions.', 300, {
    bg0: '#0a100c', bg1: '#0f1712', bg2: '#141e18', bg3: '#1b2820', bgHover: '#233328', border: '#24362b',
    text: '#e4efe7', textDim: '#9bb3a3', textFaint: '#688070', accent: '#4fcf7a', accent2: '#c9e265',
    ok: '#4fcf7a', warn: '#e8c547', danger: '#ff6b6b',
  }),
  theme('theme-grape', 'Grape Soda', 'Midnight purple with a pink kick.', 300, {
    bg0: '#0d0a14', bg1: '#130f1c', bg2: '#191424', bg3: '#221b30', bgHover: '#2b233d', border: '#2e2541',
    text: '#ece6f5', textDim: '#a99bbf', textFaint: '#75698a', accent: '#a66bff', accent2: '#ff6bd5',
    ok: '#3ccf91', warn: '#f5c542', danger: '#ff5c7a',
  }),

  // Editor themes
  edTheme('etheme-one-dark', 'One Dark', 'The classic default editor theme. Free, so you can always switch back.', 0, 'one-dark'),
  edTheme('etheme-midnight', 'Codehub Midnight', 'Blue-black editor tuned to match the Codehub palette.', 250, 'codehub-midnight'),
  edTheme('etheme-solarized', 'Solarized Dark', 'Ethan Schoonover\'s low-contrast classic.', 250, 'solarized-dark'),
  edTheme('etheme-paper', 'Paper Light', 'A calm light editor for daytime coding.', 250, 'paper-light'),
  edTheme('etheme-dracula', 'Dracula-ish', 'Vivid pinks, greens and purples on a dark canvas.', 300, 'dracula-ish'),

  // Editor add-ons
  edExt('ext-line-wrap', 'Line wrapping', 'Wrap long lines to the editor width instead of scrolling sideways.', 0, 'line-wrap'),
  edExt('ext-whitespace', 'Show whitespace', 'Render spaces and tabs as faint markers.', 50, 'whitespace'),
  edExt('ext-trailing-ws', 'Trailing whitespace', 'Highlight stray whitespace at the end of lines.', 50, 'trailing-ws'),
  edExt('ext-scroll-past-end', 'Scroll past end', 'Let the last line scroll up to the top of the editor.', 0, 'scroll-past-end'),
  edExt('ext-active-line', 'Bright active line', 'A stronger highlight for the line and gutter under the cursor.', 50, 'active-line'),
  edExt('ext-rainbow-brackets', 'Rainbow brackets', 'Color (), [] and {} by nesting depth.', 150, 'rainbow-brackets'),
  edExt('ext-indent-guides', 'Indent guides', 'Thin vertical guides for each indentation level.', 150, 'indent-guides'),
  edExt('ext-big-cursor', 'Big cursor', 'A thicker, easier-to-spot caret.', 75, 'big-cursor'),

  // Badges
  badge('badge-star', 'Star', 'A little shine next to your name.', 100, '⭐'),
  badge('badge-rocket', 'Rocket', 'Ship it.', 150, '🚀'),
  badge('badge-crab', 'Crab', 'For the Rustaceans.', 150, '🦀'),
  badge('badge-coffee', 'Coffee', 'Powered by caffeine.', 100, '☕'),
  badge('badge-bug', 'Bug hunter', 'You find them, you squash them.', 200, '🐛'),
  badge('badge-wave', 'Hello', 'A friendly wave. Free for everyone.', 0, '👋'),

  // Name colors
  nameColor('color-sunset', 'Sunset', 'A warm orange display name.', 200, '#ff8f4d'),
  nameColor('color-mint', 'Mint', 'A fresh green display name.', 200, '#3ccf91'),
  nameColor('color-violet', 'Violet', 'A royal purple display name.', 200, '#b48cff'),
  nameColor('color-gold', 'Gold', 'A golden display name.', 500, '#f5c542'),
];

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

// Items are plain text. Reject anything that looks like a link, markup or a script/style payload so
// an admin can't smuggle one in (the database rules bound shape/size; this is the content policy).
const FORBIDDEN_RE = /(https?:|ftp:|data:|javascript:|vbscript:|www\.|<|>|url\s*\(|@import|expression\s*\(|\{\s*[a-z-]+\s*:)/i;
const DOMAIN_RE = /\b[a-z0-9-]+\.(com|net|org|io|dev|app|gg|xyz|co|me|ly|sh|ai|ru|cn|tk|info|biz)\b/i;

/** Returns a human message when `text` carries a URL / markup / code-like payload, else null. */
export function findForbidden(text) {
  if (typeof text !== 'string' || !text) return null;
  if (FORBIDDEN_RE.test(text) || DOMAIN_RE.test(text)) return 'Links, HTML, CSS and code are not allowed in shop items';
  return null;
}

const isInt = (n) => typeof n === 'number' && Number.isFinite(n) && Math.floor(n) === n;
const glyphLength = (s) => s.length; // UTF-16 units, matching the database rule's `.length`

function cleanTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const out = {};
  for (const k of TOKEN_KEYS) {
    if (typeof tokens[k] === 'string' && HEX_RE.test(tokens[k])) out[k] = tokens[k].toLowerCase();
  }
  return Object.keys(out).length ? out : null;
}

// App themes are authored for the dark base (light mode derives a variant, see lightVariants.js): body text
// must stay readable on every surface it sits on. Missing tokens fall back to the stylesheet defaults.
const THEME_TEXT_ON = ['bg1', 'bg2', 'bg3'];

/** Human message when an app theme would make text hard to read, else null. */
export function themeTokensProblem(tokens) {
  const t = { ...BASE_TOKENS, ...(tokens || {}) };
  for (const bg of THEME_TEXT_ON) {
    if (contrast(t.text, t[bg]) < 4.5) return `Text needs more contrast with “${TOKEN_LABELS[bg]}”`;
  }
  if (contrast(t.textDim, t.bg2) < 3) return 'Text (dim) needs more contrast with the main background';
  if (contrast(t.accent, t.bg2) < 2) return 'Accent is almost invisible on the main background';
  return null;
}

function cleanData(kind, data) {
  const d = data && typeof data === 'object' ? data : {};
  switch (kind) {
    case 'theme': {
      const tokens = cleanTokens(d.tokens);
      return tokens ? { tokens } : null;
    }
    case 'editorTheme': {
      if (d.tokens !== undefined) {
        const tokens = cleanEditorTokens(d.tokens);
        return tokens ? { tokens } : null;
      }
      return typeof d.builtinId === 'string' && BUILTIN_RE.test(d.builtinId) ? { builtinId: d.builtinId } : null;
    }
    case 'editorExt':
      return typeof d.builtinId === 'string' && BUILTIN_RE.test(d.builtinId) ? { builtinId: d.builtinId } : null;
    case 'badge': {
      const g = typeof d.glyph === 'string' ? d.glyph.trim() : '';
      return g && glyphLength(g) <= GLYPH_MAX && !findForbidden(g) && !/[\u0000-\u001f]/.test(g) ? { glyph: g } : null;
    }
    case 'nameColor':
      return typeof d.color === 'string' && HEX_RE.test(d.color) ? { color: d.color.toLowerCase() } : null;
    default:
      return null;
  }
}

/** Is the item's behavior shipped in this build? (Unknown builtinIds are ignored, never executed.) */
export function isSupported(item) {
  if (!item) return false;
  if (item.kind === 'editorTheme') return item.data.tokens ? true : isKnownEditorTheme(item.data.builtinId);
  if (item.kind === 'editorExt') return isKnownEditorExt(item.data.builtinId);
  return true;
}

/** Problem with a cleaned item's colors (an unreadable app or editor theme), else null. */
export function colorProblem(kind, data) {
  if (kind === 'theme') return themeTokensProblem(data.tokens);
  if (kind === 'editorTheme' && data.tokens) return editorTokensProblem(data.tokens);
  return null;
}

/**
 * Normalize a raw `shop/items/{id}` value read from the database into a safe, typed item, or null
 * when it doesn't match any known shape. Only whitelisted fields survive. Community items (with `by`)
 * also go through the content policy again on every read: a name or description that carries a link or
 * markup, or a theme that would make text unreadable, hides the item (it never renders or applies).
 */
export function normalizeItem(id, raw) {
  if (!raw || typeof raw !== 'object' || typeof id !== 'string' || !ITEM_ID_RE.test(id)) return null;
  if (!KINDS.includes(raw.kind)) return null;
  const by = typeof raw.by === 'string' && UID_RE.test(raw.by) ? raw.by : null;
  if (raw.by !== undefined && !by) return null;
  // Bundled modules (builtinId) are official-only; the rules enforce it, the client never trusts it either.
  if (by && (raw.kind === 'editorExt' || (raw.kind === 'editorTheme' && raw.data?.tokens === undefined))) return null;
  const data = cleanData(raw.kind, raw.data);
  if (!data) return null;
  const price = isInt(raw.price) && raw.price >= 0 && raw.price <= PRICE_MAX ? raw.price : null;
  if (price === null) return null;
  const name = typeof raw.name === 'string' ? raw.name.slice(0, NAME_MAX) : '';
  if (!name.trim()) return null;
  const desc = typeof raw.desc === 'string' ? raw.desc.slice(0, DESC_MAX) : '';
  if (by && (findForbidden(name) || findForbidden(desc) || colorProblem(raw.kind, data))) return null;
  const item = {
    id,
    name,
    desc,
    kind: raw.kind,
    price,
    data,
    active: raw.active === true,
    by,
    official: !by,
    createdAt: isInt(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
  };
  item.supported = isSupported(item);
  // A community item an app admin switched off stays off: only an admin can switch it back on (rules).
  item.heldByAdmin = !!by && !item.active && !!item.updatedBy && item.updatedBy !== by;
  return item;
}

/**
 * Validate item input for saving. Returns the exact object to store (minus updatedAt/updatedBy and the
 * creator fields), or throws an Error with a human-readable message. `creator: true` applies the community
 * limits: CREATOR_KINDS only and editor themes as color tokens (no bundled modules).
 */
export function sanitizeItemInput(input, { creator = false } = {}) {
  const name = String(input?.name ?? '').trim();
  const desc = String(input?.desc ?? '').trim();
  const kind = input?.kind;
  const price = typeof input?.price === 'string' ? Number(input.price) : input?.price;
  if (!name) throw new Error('Name is required');
  if (name.length > NAME_MAX) throw new Error(`Name must be at most ${NAME_MAX} characters`);
  if (desc.length > DESC_MAX) throw new Error(`Description must be at most ${DESC_MAX} characters`);
  const bad = findForbidden(name) || findForbidden(desc);
  if (bad) throw new Error(bad);
  if (!KINDS.includes(kind)) throw new Error('Pick a kind');
  if (creator && !CREATOR_KINDS.includes(kind)) throw new Error('Editor add-ons can only be published by app admins');
  if (!isInt(price) || price < 0 || price > PRICE_MAX) throw new Error(`Price must be a whole number from 0 to ${PRICE_MAX}`);
  const data = cleanData(kind, input?.data);
  if (!data) {
    if (kind === 'theme') throw new Error('A theme needs at least one valid #rrggbb color');
    if (kind === 'badge') throw new Error(`The badge glyph must be 1–${GLYPH_MAX} characters of plain text (an emoji)`);
    if (kind === 'nameColor') throw new Error('Pick a #rrggbb color');
    if (kind === 'editorTheme' && input?.data?.tokens !== undefined) throw new Error('Every editor color must be a #rrggbb color');
    throw new Error('Pick a bundled module');
  }
  if (creator && data.builtinId !== undefined) throw new Error('Bundled editor themes can only be published by app admins');
  if (kind === 'editorTheme' && !data.tokens && !isKnownEditorTheme(data.builtinId)) throw new Error('Unknown editor theme');
  const colors = colorProblem(kind, data);
  if (colors) throw new Error(colors);
  if (kind === 'editorExt' && !isKnownEditorExt(data.builtinId)) throw new Error('Unknown editor add-on');
  return { name, desc, kind, price, data, active: input?.active !== false };
}

// ---------------------------------------------------------------------------------------------
// Resolving what is equipped (plain data; runtime.js turns it into CodeMirror extensions)
// ---------------------------------------------------------------------------------------------

/** Item of `kind` equipped in `slot`, or null (dangling / wrong-kind references are ignored). */
export function equippedItem(equipped, byId, slot) {
  const id = equipped?.[slot];
  if (typeof id !== 'string') return null;
  const item = byId?.[id];
  return item && item.kind === slot && item.supported ? item : null;
}

/**
 * -> { theme: builtinId|null, palette: {editor color tokens}|null, exts: [builtinId] (sorted, unique) }
 * for the editor. A token-based editor theme sets `palette` (and `theme` stays null).
 */
export function resolveEditorAddons(equipped, byId) {
  const t = equippedItem(equipped, byId, 'editorTheme');
  const exts = new Set();
  const ext = equipped?.ext && typeof equipped.ext === 'object' ? equipped.ext : {};
  for (const [id, on] of Object.entries(ext)) {
    if (on !== true) continue;
    const item = byId?.[id];
    if (item && item.kind === 'editorExt' && item.supported) exts.add(item.data.builtinId);
  }
  return { theme: t && !t.data.tokens ? t.data.builtinId : null, palette: t?.data.tokens || null, exts: [...exts].sort() };
}

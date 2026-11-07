// Data-only editor themes: eleven `#rrggbb` color tokens, turned into a full CodeMirror palette by this
// first-party generator. Pure (no CodeMirror import), so the shop preview, the validators and unit tests
// can use it; editorThemes.js feeds the result to the same theme builder the bundled themes use.
//
// Stored as `shop/items/{id}/data/tokens` of an `editorTheme` item (the rules accept exactly these keys).
import { contrast, isDark, isHex, mix, withAlpha } from './color.js';

export const EDITOR_TOKEN_KEYS = ['bg', 'fg', 'sel', 'caret', 'kw', 'str', 'cmt', 'num', 'fn', 'type', 'op'];

export const EDITOR_TOKEN_LABELS = {
  bg: 'Background',
  fg: 'Foreground',
  sel: 'Selection',
  caret: 'Cursor',
  kw: 'Keyword',
  str: 'String',
  cmt: 'Comment',
  num: 'Number',
  fn: 'Function',
  type: 'Type',
  op: 'Operator',
};

/** Starting point for the creator form (One Dark colors). */
export const BASE_EDITOR_TOKENS = {
  bg: '#282c34',
  fg: '#abb2bf',
  sel: '#3e4451',
  caret: '#528bff',
  kw: '#c678dd',
  str: '#98c379',
  cmt: '#7d8799',
  num: '#d19a66',
  fn: '#61afef',
  type: '#e5c07b',
  op: '#56b6c2',
};

/** All eleven tokens present and `#rrggbb` (lower-cased), else null. */
export function cleanEditorTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const out = {};
  for (const k of EDITOR_TOKEN_KEYS) {
    if (!isHex(tokens[k])) return null;
    out[k] = tokens[k].toLowerCase();
  }
  return out;
}

// Minimum contrast against the background: text must be comfortably readable, syntax colors, the cursor and
// selected text must at least stay visible (comments are often deliberately dim).
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_ACCENT_CONTRAST = 2;

/** Human message when a palette would make code hard to read, else null. Expects cleaned tokens. */
export function editorTokensProblem(t) {
  if (contrast(t.fg, t.bg) < MIN_TEXT_CONTRAST) return 'Foreground needs more contrast with the background';
  for (const k of ['kw', 'str', 'cmt', 'num', 'fn', 'type', 'op', 'caret']) {
    if (contrast(t[k], t.bg) < MIN_ACCENT_CONTRAST) return `${EDITOR_TOKEN_LABELS[k]} is almost invisible on the background`;
  }
  if (contrast(t.fg, t.sel) < MIN_ACCENT_CONTRAST) return 'Selected text would be unreadable: pick a different selection color';
  return null;
}

/** Full palette for the CodeMirror theme builder (same shape as the bundled palettes) + `dark`. */
export function editorPalette(t) {
  const dark = isDark(t.bg);
  return {
    dark,
    bg: t.bg,
    fg: t.fg,
    cursor: t.caret,
    selection: t.sel,
    match: withAlpha(t.caret, 0.22),
    gutterBg: t.bg,
    gutter: mix(t.fg, t.bg, 0.5),
    activeLine: withAlpha(t.fg, dark ? 0.06 : 0.05),
    panel: mix(t.bg, t.fg, 0.07),
    border: mix(t.bg, t.fg, 0.16),
    keyword: t.kw,
    variable: t.fg,
    property: mix(t.fg, t.fn, 0.5),
    fn: t.fn,
    number: t.num,
    type: t.type,
    operator: t.op,
    special: t.op,
    comment: t.cmt,
    string: t.str,
    tag: t.kw,
    invalid: dark ? '#ff5c7a' : '#cf222e',
  };
}

/** Colors for the shop's static code preview (same keys as EDITOR_THEME_INFO[*].preview). */
export function editorPreview(t) {
  return {
    bg: t.bg,
    fg: t.fg,
    keyword: t.kw,
    string: t.str,
    number: t.num,
    comment: t.cmt,
    fn: t.fn,
    type: t.type,
    op: t.op,
    sel: t.sel,
    caret: t.caret,
    gutter: mix(t.fg, t.bg, 0.5),
  };
}

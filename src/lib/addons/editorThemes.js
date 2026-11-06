// Bundled CodeMirror editor themes for the add-on shop (kind `editorTheme`, data `{builtinId}`).
// Built only from existing deps: EditorView.theme (@codemirror/view), HighlightStyle/syntaxHighlighting
// (@codemirror/language), `tags` (@lezer/highlight, installed with codemirror) and the existing one-dark.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { oneDark } from '@codemirror/theme-one-dark';
import { EDITOR_THEME_INFO } from './registry.js';
import { getResolvedTheme } from '../theme.js';

// Palette -> [editor chrome theme, syntax highlighting]. Selection uses !important so it wins over
// the collab editor's own chrome rule (which also uses !important).
function makeTheme(p, dark) {
  const chrome = EditorView.theme(
    {
      '&': { color: p.fg, backgroundColor: p.bg },
      '.cm-content': { caretColor: p.cursor },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.cursor },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: `${p.selection} !important` },
      '.cm-gutters': { backgroundColor: p.gutterBg, color: p.gutter, border: 'none' },
      '.cm-activeLine': { backgroundColor: p.activeLine },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: p.fg },
      '.cm-selectionMatch': { backgroundColor: p.match },
      '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: p.match, outline: 'none' },
      '.cm-searchMatch': { backgroundColor: p.match, outline: `1px solid ${p.keyword}` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: p.selection },
      '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: p.comment },
      '.cm-panels': { backgroundColor: p.panel, color: p.fg },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${p.border}` },
      '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${p.border}` },
      '.cm-tooltip': { backgroundColor: p.panel, color: p.fg, border: `1px solid ${p.border}` },
      '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
      '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: p.panel, borderBottomColor: p.panel },
      '.cm-tooltip-autocomplete': {
        '& > ul > li[aria-selected]': { backgroundColor: p.selection, color: p.fg },
      },
    },
    { dark },
  );

  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: p.keyword },
    { tag: [t.name, t.deleted, t.character, t.macroName], color: p.variable },
    { tag: [t.propertyName], color: p.property },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: p.fn },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: p.number },
    { tag: [t.definition(t.name), t.separator], color: p.fg },
    { tag: [t.typeName, t.className, t.namespace, t.changed, t.annotation, t.modifier, t.self], color: p.type },
    { tag: [t.number, t.bool, t.atom, t.special(t.variableName)], color: p.number },
    { tag: [t.operator, t.punctuation, t.bracket], color: p.operator },
    { tag: [t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: p.special },
    { tag: [t.meta, t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.processingInstruction, t.string, t.inserted, t.attributeValue], color: p.string },
    { tag: [t.tagName], color: p.tag },
    { tag: [t.attributeName], color: p.type },
    { tag: t.heading, fontWeight: 'bold', color: p.keyword },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, textDecoration: 'underline' },
    { tag: t.invalid, color: p.invalid },
  ]);

  return [chrome, syntaxHighlighting(highlight)];
}

const PALETTES = {
  'codehub-midnight': {
    bg: '#0f1320', fg: '#d6deeb', cursor: '#5b8cff', selection: 'rgba(91,140,255,.30)', match: 'rgba(91,140,255,.18)',
    gutterBg: '#0f1320', gutter: '#4b5366', activeLine: 'rgba(91,140,255,.07)', panel: '#151a2a', border: '#262d3d',
    keyword: '#a66bff', variable: '#e6e9f0', property: '#9fb8ff', fn: '#5b8cff', number: '#ff8f4d', type: '#2bc4d9',
    operator: '#9aa3b5', special: '#f5c542', comment: '#5b6478', string: '#3ccf91', tag: '#ff6b9a', invalid: '#ff5c7a',
  },
  'solarized-dark': {
    bg: '#002b36', fg: '#93a1a1', cursor: '#93a1a1', selection: 'rgba(147,161,161,.22)', match: 'rgba(181,137,0,.22)',
    gutterBg: '#073642', gutter: '#586e75', activeLine: 'rgba(7,54,66,.85)', panel: '#073642', border: '#0d4654',
    keyword: '#859900', variable: '#93a1a1', property: '#268bd2', fn: '#268bd2', number: '#d33682', type: '#b58900',
    operator: '#859900', special: '#cb4b16', comment: '#586e75', string: '#2aa198', tag: '#268bd2', invalid: '#dc322f',
  },
  'paper-light': {
    bg: '#fbfaf6', fg: '#2b2f36', cursor: '#0550ae', selection: 'rgba(5,80,174,.18)', match: 'rgba(138,63,252,.14)',
    gutterBg: '#f3f1ea', gutter: '#a0a7b1', activeLine: 'rgba(0,0,0,.04)', panel: '#f3f1ea', border: '#ddd9cc',
    keyword: '#8a3ffc', variable: '#24292f', property: '#0a5c8f', fn: '#0550ae', number: '#b35900', type: '#953800',
    operator: '#57606a', special: '#116329', comment: '#8b929c', string: '#1a7f37', tag: '#116329', invalid: '#cf222e',
  },
  'dracula-ish': {
    bg: '#22212c', fg: '#f8f8f2', cursor: '#f8f8f2', selection: 'rgba(98,114,164,.45)', match: 'rgba(189,147,249,.22)',
    gutterBg: '#22212c', gutter: '#6c6783', activeLine: 'rgba(68,71,90,.45)', panel: '#2c2a3a', border: '#3b3850',
    keyword: '#ff79c6', variable: '#f8f8f2', property: '#8be9fd', fn: '#50fa7b', number: '#bd93f9', type: '#8be9fd',
    operator: '#ff79c6', special: '#ffb86c', comment: '#7970a9', string: '#f1fa8c', tag: '#ff79c6', invalid: '#ff5555',
  },
};

const cache = new Map();

/** CodeMirror extension for a bundled editor theme id, or null for an unknown id (ignored). */
export function editorThemeExtension(builtinId) {
  // No equipped editor theme (null/undefined): follow the app theme. An equipped theme always wins.
  if (builtinId == null) builtinId = defaultEditorThemeId();
  if (!Object.prototype.hasOwnProperty.call(EDITOR_THEME_INFO, builtinId)) return null;
  if (cache.has(builtinId)) return cache.get(builtinId);
  const ext = builtinId === 'one-dark' ? oneDark : makeTheme(PALETTES[builtinId], EDITOR_THEME_INFO[builtinId].dark);
  cache.set(builtinId, ext);
  return ext;
}

export const DEFAULT_EDITOR_THEME = 'one-dark';
export const DEFAULT_LIGHT_EDITOR_THEME = 'paper-light';

/** Editor theme id used when none is equipped: paper-light in light mode, one-dark otherwise. */
export function defaultEditorThemeId() {
  return getResolvedTheme() === 'light' ? DEFAULT_LIGHT_EDITOR_THEME : DEFAULT_EDITOR_THEME;
}
export const EDITOR_THEME_IDS = Object.keys(EDITOR_THEME_INFO);

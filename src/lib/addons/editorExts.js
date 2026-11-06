// Bundled CodeMirror editor add-ons for the shop (kind `editorExt`, data `{builtinId}`).
// Only @codemirror/view, @codemirror/state and @codemirror/language (all installed with `codemirror`).
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightTrailingWhitespace,
  highlightWhitespace,
  scrollPastEnd,
} from '@codemirror/view';
import { getIndentUnit, syntaxTree } from '@codemirror/language';
import { EDITOR_EXT_INFO } from './registry.js';

// ---------- rainbow brackets ----------

const RAINBOW_COLORS = ['#ffd866', '#ff6b9a', '#5bc0ff', '#7ee787', '#c39bff', '#ff9f5a'];
const RAINBOW_MARKS = RAINBOW_COLORS.map((_, i) => Decoration.mark({ class: `cm-rb cm-rb-${i}` }));
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };
// Depth is computed from at most this many characters before the viewport, so huge files stay cheap.
const RAINBOW_LOOKBEHIND = 20000;
const SKIP_NODE = /String|Comment|Regexp|Template|Char/;

function inStringOrComment(tree, pos) {
  for (let node = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (SKIP_NODE.test(node.type.name)) return true;
    if (node.type.isTop) break;
  }
  return false;
}

function buildRainbow(view) {
  const builder = new RangeSetBuilder();
  const { state } = view;
  const tree = syntaxTree(state);
  const ranges = view.visibleRanges;
  if (!ranges.length) return builder.finish();
  const start = Math.max(0, ranges[0].from - RAINBOW_LOOKBEHIND);
  const end = ranges[ranges.length - 1].to;
  const visible = (pos) => ranges.some((r) => pos >= r.from && pos < r.to);
  const stack = [];
  const text = state.doc.sliceString(start, end);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isOpen = OPEN[ch] !== undefined;
    const isClose = CLOSE[ch] !== undefined;
    if (!isOpen && !isClose) continue;
    const pos = start + i;
    if (inStringOrComment(tree, pos)) continue;
    if (isOpen) {
      if (visible(pos)) builder.add(pos, pos + 1, RAINBOW_MARKS[stack.length % RAINBOW_MARKS.length]);
      stack.push(ch);
    } else {
      // Pop to the matching opener when there is one; an unmatched closer keeps the current depth.
      const idx = stack.lastIndexOf(CLOSE[ch]);
      if (idx >= 0) {
        stack.length = idx;
        if (visible(pos)) builder.add(pos, pos + 1, RAINBOW_MARKS[stack.length % RAINBOW_MARKS.length]);
      }
    }
  }
  return builder.finish();
}

const rainbowPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildRainbow(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildRainbow(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const rainbowTheme = EditorView.baseTheme(
  Object.fromEntries(RAINBOW_COLORS.map((c, i) => [`.cm-rb-${i}`, { color: `${c} !important` }])),
);

// ---------- indent guides ----------

const guideMarks = new Map(); // indent unit (columns) -> Decoration

function guideMark(unit) {
  if (!guideMarks.has(unit)) {
    guideMarks.set(
      unit,
      Decoration.mark({
        class: 'cm-indent-guides',
        attributes: { style: `background-size: ${unit}ch 100%` },
      }),
    );
  }
  return guideMarks.get(unit);
}

function buildGuides(view) {
  const builder = new RangeSetBuilder();
  const { state } = view;
  const unit = Math.max(1, Math.min(16, getIndentUnit(state) || 2));
  const mark = guideMark(unit);
  let lastLine = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.from <= lastLine) continue; // two visible ranges can share a line around a fold
      lastLine = line.from;
      const m = /^[ \t]+/.exec(line.text);
      // Only spans of leading whitespace that are at least one indent unit wide get guides.
      if (m && m[0].replace(/\t/g, ' '.repeat(state.tabSize)).length >= unit) {
        builder.add(line.from, line.from + m[0].length, mark);
      }
    }
  }
  return builder.finish();
}

const indentGuidesPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildGuides(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildGuides(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const indentGuidesTheme = EditorView.baseTheme({
  '.cm-indent-guides': {
    backgroundImage: 'linear-gradient(to right, rgba(128,140,170,.28) 1px, transparent 1px)',
    backgroundRepeat: 'repeat-x',
    backgroundPosition: '0 0',
  },
  '&light .cm-indent-guides': {
    backgroundImage: 'linear-gradient(to right, rgba(60,70,90,.22) 1px, transparent 1px)',
  },
});

// ---------- small themes ----------

const bigCursorTheme = EditorView.theme({
  '.cm-cursor, .cm-dropCursor': { borderLeftWidth: '3px' },
  '&.cm-focused .cm-cursor': { borderLeftWidth: '3px' },
});

const activeLineTheme = EditorView.theme({
  '.cm-activeLine': { backgroundColor: 'rgba(128,150,255,.12) !important', boxShadow: 'inset 2px 0 0 rgba(128,150,255,.55)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(128,150,255,.12) !important', color: 'inherit', fontWeight: '600' },
});

const whitespaceTheme = EditorView.baseTheme({
  '.cm-highlightSpace': { opacity: '.55' },
  '.cm-highlightTab': { opacity: '.55' },
});

const trailingTheme = EditorView.baseTheme({
  '.cm-trailingSpace': { backgroundColor: 'rgba(255,92,122,.28) !important', borderRadius: '2px' },
});

// ---------- registry ----------

const FACTORIES = {
  'line-wrap': () => EditorView.lineWrapping,
  whitespace: () => [highlightWhitespace(), whitespaceTheme],
  'trailing-ws': () => [highlightTrailingWhitespace(), trailingTheme],
  'scroll-past-end': () => scrollPastEnd(),
  'active-line': () => [highlightActiveLine(), highlightActiveLineGutter(), activeLineTheme],
  'rainbow-brackets': () => [rainbowPlugin, rainbowTheme],
  'indent-guides': () => [indentGuidesPlugin, indentGuidesTheme],
  'big-cursor': () => bigCursorTheme,
};

const cache = new Map();

/** CodeMirror extension for a bundled add-on id, or null for an unknown id (ignored). */
export function editorExtExtension(builtinId) {
  if (!Object.prototype.hasOwnProperty.call(EDITOR_EXT_INFO, builtinId) || !FACTORIES[builtinId]) return null;
  if (!cache.has(builtinId)) cache.set(builtinId, FACTORIES[builtinId]());
  return cache.get(builtinId);
}

export const EDITOR_EXT_IDS = Object.keys(EDITOR_EXT_INFO);

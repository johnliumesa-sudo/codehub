// CodeMirror 6 bound to a CollabProvider's Y.Text via y-codemirror.next.
// History is handled by Y.UndoManager (only local edits are undoable), not CM's history().
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { languageFor } from '../../lib/collab/languages.js';
import { MAX_INSERT_BYTES } from '../../lib/collab/codec.js';
import { useEditorAddons } from '../shop/AddonRuntime.jsx';

const utf8 = new TextEncoder();

// Reject a single edit too large to sync *before* it reaches Y.Text — once in the doc it could
// never be persisted, and the provider would have to stop the session.
function insertLimit(onReject) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    let chars = 0;
    tr.changes.iterChanges((_a, _b, _c, _d, inserted) => { chars += inserted.length; });
    if (chars * 3 <= MAX_INSERT_BYTES) return tr;
    let bytes = 0;
    tr.changes.iterChanges((_a, _b, _c, _d, inserted) => { bytes += utf8.encode(inserted.toString()).length; });
    if (bytes <= MAX_INSERT_BYTES) return tr;
    onReject?.(bytes);
    return [];
  });
}

const chrome = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--bg-2)', fontSize: '13.5px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
    '.cm-content': { padding: '12px 0 40vh' },
    '.cm-gutters': { backgroundColor: 'var(--bg-2)', border: 'none', color: '#4b5366' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
    '.cm-activeLine': { backgroundColor: 'rgba(91,140,255,.06)' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(91,140,255,.28) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-ySelectionInfo': {
      fontFamily: 'var(--font)',
      fontSize: '10.5px',
      fontWeight: '600',
      padding: '1px 5px',
      borderRadius: '4px 4px 4px 0',
      top: '-1.45em',
      opacity: '1',
      transitionDelay: '1.5s',
    },
    '.cm-ySelectionCaret:hover > .cm-ySelectionInfo': { opacity: '1', transitionDelay: '0s' },
    '.cm-panels': { backgroundColor: 'var(--bg-1)', color: 'var(--text)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-3)', border: '1px solid var(--border)', borderRadius: '8px' },
  },
  { dark: true },
);

export default function CollabEditor({ provider, path, readOnly = false, onCursor, onView, onRejectEdit }) {
  const hostRef = useRef(null);
  const langRef = useRef(new Compartment());
  const roRef = useRef(new Compartment());
  // Equipped editor theme + add-ons (WS3). [] until the add-on runtime chunk loads -> oneDark.
  const addonsRef = useRef(new Compartment());
  const addons = useEditorAddons();
  const addonsVal = addons.length ? addons : oneDark;
  const addonsValRef = useRef(addonsVal);
  addonsValRef.current = addonsVal;
  const viewRef = useRef(null);
  const cbRef = useRef({ onCursor, onView, onRejectEdit });
  cbRef.current = { onCursor, onView, onRejectEdit };

  useEffect(() => {
    if (!provider || !hostRef.current) return undefined;
    const undoManager = new Y.UndoManager(provider.ytext);
    const state = EditorState.create({
      doc: provider.ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...yUndoManagerKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        addonsRef.current.of(addonsValRef.current),
        chrome,
        langRef.current.of(languageFor(path).load()),
        roRef.current.of(EditorState.readOnly.of(readOnly)),
        insertLimit((bytes) => cbRef.current.onRejectEdit?.(bytes)),
        yCollab(provider.ytext, provider.awareness, { undoManager }),
        EditorView.updateListener.of((u) => {
          if (!u.selectionSet && !u.docChanged) return;
          const sel = u.state.selection.main;
          const line = u.state.doc.lineAt(sel.head);
          cbRef.current.onCursor?.({
            line: line.number,
            col: sel.head - line.from + 1,
            selected: Math.abs(sel.to - sel.from),
            lines: u.state.doc.lines,
          });
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    cbRef.current.onView?.(view);
    const l = view.state.doc.lineAt(view.state.selection.main.head);
    cbRef.current.onCursor?.({ line: l.number, col: 1, selected: 0, lines: view.state.doc.lines });
    requestAnimationFrame(() => view.focus());
    return () => {
      cbRef.current.onView?.(null);
      viewRef.current = null;
      view.destroy();
      undoManager.destroy();
    };
    // `path`/`readOnly` are applied via compartments below; recreate only for a new provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: langRef.current.reconfigure(languageFor(path).load()) });
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: addonsRef.current.reconfigure(addonsVal) });
  }, [addonsVal]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: roRef.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  return <div className="cx-editor-host" ref={hostRef} />;
}

// Plain (non-collaborative) CodeMirror 6 editor for add-on code (JavaScript that runs in a worker),
// the same base setup and theme as the collab editor. Loaded lazily (its own chunk).
import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';

const chrome = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: '#161a23' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: '#161a23', border: 'none' },
    '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  },
  { dark: true },
);

/** Props: value, onChange(text), label (accessible name), readOnly? */
export default function CodeEditor({ value, onChange, label = 'Add-on code', readOnly = false }) {
  const host = useRef(null);
  const view = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value || '',
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          javascript(),
          oneDark,
          chrome,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Outside changes (template picked, add-on loaded) replace the document.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if ((value || '') !== cur) v.dispatch({ changes: { from: 0, to: cur.length, insert: value || '' } });
  }, [value]);

  return <div ref={host} className="ad-editor" />;
}

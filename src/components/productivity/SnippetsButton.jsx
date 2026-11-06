// Snippet library entry point (F20).
//  - In CollabView extras:  <SnippetsButton ctx={ctx}/>  inserts at the cursor via ctx.insertText and
//    offers "Save selection as snippet" via ctx.getSelection().
//  - In the chat Composer:  <SnippetsButton me={me} onInsert={(code, lang) => …} className="composer-btn" iconOnly/>
import { useEffect, useRef, useState } from 'react';
import { langFromFilename } from '../../lib/markdown.js';
import { useToast } from '../layout/ui.jsx';
import SnippetLibraryModal from './SnippetLibraryModal.jsx';
import { PdIcon } from './icons.jsx';
import './productivity.css';

export default function SnippetsButton({ ctx, me: meProp, onInsert, className, iconOnly = false, disabled = false }) {
  const toast = useToast();
  const me = ctx?.me || meProp;
  const [modal, setModal] = useState(null); // null | { draft? }
  const [menu, setMenu] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => wrapRef.current && !wrapRef.current.contains(e.target) && setMenu(false);
    const onKey = (e) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!me?.uid) return null;

  // ---------- chat composer mode ----------
  if (!ctx) {
    return (
      <>
        <button
          type="button"
          className={className || 'btn sm ghost pd-tool-btn'}
          title="Insert from snippet library"
          aria-label="Insert from snippet library"
          onClick={() => setModal({})}
          disabled={disabled}
        >
          <PdIcon name="snippet" size={iconOnly ? 18 : 16} />
          {!iconOnly && <span className="pd-tool-label">Snippets</span>}
        </button>
        {modal && <SnippetLibraryModal me={me} onInsert={onInsert} onClose={() => setModal(null)} />}
      </>
    );
  }

  // ---------- collab mode ----------
  const canInsert = !ctx.readOnly && !!ctx.activeFid;
  const insertIntoEditor = canInsert
    ? (code) => {
        ctx.insertText(code);
      }
    : undefined;

  const saveSelection = () => {
    setMenu(false);
    const sel = String(ctx.getSelection?.() || '');
    if (!sel.trim()) {
      toast('Select some code in the editor first', 'error');
      return;
    }
    const file = ctx.activePath ? ctx.activePath.split('/').pop() : '';
    setModal({ draft: { code: sel, lang: langFromFilename(ctx.activePath || '') || 'plaintext', title: file ? `From ${file}` : '' } });
  };

  return (
    <div className="pd-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn sm ghost pd-tool-btn ${menu ? 'active' : ''}`}
        onClick={() => setMenu((m) => !m)}
        aria-haspopup="menu"
        aria-expanded={menu}
        title="Personal snippet library"
        disabled={disabled}
      >
        <PdIcon name="snippet" />
        {!iconOnly && <span className="pd-tool-label">Snippets</span>}
        <PdIcon name="chevron" size={12} />
      </button>
      {menu && (
        <div className="pd-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="pd-menu-item"
            onClick={() => {
              setMenu(false);
              setModal({});
            }}
          >
            <PdIcon name="insert" />
            <span>
              {canInsert ? 'Insert snippet…' : 'Browse snippets…'}
              <small>{canInsert ? 'At the cursor in the open file' : ctx.readOnly ? 'View-only access: copy instead' : 'Open a file to insert'}</small>
            </span>
          </button>
          <button type="button" role="menuitem" className="pd-menu-item" onClick={saveSelection} disabled={!ctx.activeFid}>
            <PdIcon name="save" />
            <span>
              Save selection as snippet
              <small>Encrypted with your personal vault key</small>
            </span>
          </button>
        </div>
      )}
      {modal && (
        <SnippetLibraryModal
          me={me}
          onInsert={insertIntoEditor}
          insertLabel="Insert at cursor"
          initialDraft={modal.draft}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

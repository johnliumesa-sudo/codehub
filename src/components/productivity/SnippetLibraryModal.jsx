// Personal, vault-encrypted snippet library (F20).
// Props: { me, onInsert?(code, lang), onClose, initialDraft?: { code, lang?, title? }, insertLabel? }
// Without onInsert the modal still lets you browse, copy, edit and delete.
import { useEffect, useMemo, useState } from 'react';
import { SNIPPET_LANGUAGES, highlightCode, languageLabel, sanitize } from '../../lib/markdown.js';
import {
  MAX_CODE,
  MAX_SNIPPETS,
  MAX_TAGS,
  MAX_TITLE,
  deleteSnippet,
  parseTags,
  saveSnippet,
  searchSnippets,
  useSnippets,
} from '../../lib/snippets.js';
import { ConfirmButton, Modal, copyText, useToast } from '../layout/ui.jsx';
import { PdIcon, errMsg, timeAgo } from './icons.jsx';
import './productivity.css';

const emptyDraft = { id: null, title: '', lang: 'plaintext', code: '', tags: '' };

function Editor({ draft, setDraft, onSave, onCancel, busy, error }) {
  const tags = parseTags(draft.tags);
  const over = draft.code.length > MAX_CODE;
  return (
    <form
      className="pd-sn-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="pd-sn-edit-row">
        <label className="field pd-grow">
          Title
          <input className="input" value={draft.title} maxLength={MAX_TITLE} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Debounce hook" />
        </label>
        <label className="field">
          Language
          <select className="input" value={draft.lang} onChange={(e) => setDraft({ ...draft, lang: e.target.value })}>
            {SNIPPET_LANGUAGES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Tags <span className="pd-hint">(comma or space separated, up to {MAX_TAGS})</span>
        <input className="input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="react, hooks" />
      </label>
      {tags.length > 0 && (
        <div className="pd-tags">
          {tags.map((t) => <span key={t} className="pd-tag">#{t}</span>)}
        </div>
      )}
      <label className="field pd-grow-v">
        Code
        <textarea
          className="input pd-sn-code-input"
          value={draft.code}
          onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          spellCheck={false}
          placeholder="Paste or write code…"
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: en } = el;
              const v = `${draft.code.slice(0, s)}  ${draft.code.slice(en)}`;
              setDraft({ ...draft, code: v });
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            }
          }}
        />
      </label>
      <div className={`pd-small ${over ? 'error-text' : 'muted'}`}>{draft.code.length.toLocaleString()} / {MAX_CODE.toLocaleString()} characters</div>
      {error && <p className="error-text">{error}</p>}
      <div className="pd-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || over || !draft.title.trim() || !draft.code.trim()}>
          {busy ? <span className="spinner pd-spin" /> : <PdIcon name="save" size={14} />} {draft.id ? 'Save changes' : 'Save snippet'}
        </button>
      </div>
    </form>
  );
}

export default function SnippetLibraryModal({ me, onInsert, onClose, initialDraft, insertLabel = 'Insert' }) {
  const toast = useToast();
  const uid = me?.uid;
  const { snippets, loading, error } = useSnippets(uid);
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState(null);
  const [draft, setDraft] = useState(() =>
    initialDraft
      ? { ...emptyDraft, title: initialDraft.title || '', lang: initialDraft.lang || 'plaintext', code: String(initialDraft.code || '').slice(0, MAX_CODE) }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState(null);

  const results = useMemo(() => searchSnippets(snippets, query), [snippets, query]);
  const sel = snippets.find((s) => s.id === selId) || null;
  useEffect(() => {
    if (!sel && !draft && results.length) setSelId(results[0].id);
  }, [sel, draft, results]);

  const html = useMemo(() => (sel && !sel.broken ? sanitize(highlightCode(sel.code, sel.lang)) : ''), [sel]);
  const full = snippets.length >= MAX_SNIPPETS;

  const startNew = () => {
    setSaveErr(null);
    setDraft({ ...emptyDraft });
  };
  const startEdit = (s) => {
    setSaveErr(null);
    setDraft({ id: s.id, title: s.title, lang: s.lang, code: s.code, tags: s.tags.join(', ') });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setSaveErr(null);
    try {
      const id = await saveSnippet(uid, draft.id, { ...draft, tags: parseTags(draft.tags) }, snippets.length);
      setDraft(null);
      setSelId(id);
      toast('Snippet saved', 'success');
    } catch (e) {
      setSaveErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s) => {
    try {
      await deleteSnippet(uid, s.id);
      setSelId(null);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const insert = (s) => {
    onInsert?.(s.code, s.lang);
    onClose();
  };

  return (
    <Modal title="Snippet library" onClose={onClose} wide className="pd-modal pd-sn-modal">
      <div className="pd-sn">
        <aside className="pd-sn-side">
          <div className="pd-search">
            <PdIcon name="search" size={14} />
            <input
              className="input"
              placeholder="Search title, #tag or code"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search snippets"
            />
          </div>
          <button type="button" className="btn sm" onClick={startNew} disabled={full} title={full ? `Limit of ${MAX_SNIPPETS} snippets reached` : ''}>
            <PdIcon name="plus" size={14} /> New snippet
          </button>
          <ul className="pd-sn-list">
            {loading && <li className="pd-pad"><span className="spinner pd-spin" /></li>}
            {error && <li className="error-text pd-pad">{error}</li>}
            {!loading && !snippets.length && <li className="muted pd-pad">No snippets yet. Save reusable code here; only you can read it.</li>}
            {!loading && snippets.length > 0 && !results.length && <li className="muted pd-pad">No matches.</li>}
            {results.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`pd-sn-item ${s.id === selId && !draft ? 'active' : ''} ${s.broken ? 'broken' : ''}`}
                  onClick={() => {
                    setDraft(null);
                    setSelId(s.id);
                  }}
                  onDoubleClick={() => onInsert && !s.broken && insert(s)}
                >
                  <span className="pd-sn-title">{s.title || 'Untitled'}</span>
                  <span className="pd-sn-sub muted">
                    {languageLabel(s.lang)}
                    {s.tags.length > 0 && ` · ${s.tags.map((t) => `#${t}`).join(' ')}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="pd-sn-foot muted">
            <span>{snippets.length} / {MAX_SNIPPETS}</span>
            <span className="badge-e2e"><PdIcon name="lock" size={11} /> private</span>
          </div>
        </aside>

        <section className="pd-sn-main">
          {draft ? (
            <Editor draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} busy={busy} error={saveErr} />
          ) : sel ? (
            <div className="pd-sn-view">
              <div className="pd-sn-view-head">
                <div className="pd-grow">
                  <h3>{sel.title}</h3>
                  <div className="muted pd-small">
                    {languageLabel(sel.lang)} · {sel.code.split('\n').length} lines · updated {timeAgo(sel.ts)}
                  </div>
                  {sel.tags.length > 0 && (
                    <div className="pd-tags">
                      {sel.tags.map((t) => (
                        <button type="button" key={t} className="pd-tag" onClick={() => setQuery(`#${t}`)}>#{t}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {sel.broken ? (
                <p className="error-text">This snippet could not be decrypted.</p>
              ) : (
                // Sanitized: highlight.js output passed through DOMPurify.
                <pre className="pd-code pd-sn-pre"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
              )}
              <div className="pd-actions">
                <ConfirmButton className="btn sm ghost pd-danger-ghost" confirmLabel="Delete?" onConfirm={() => remove(sel)}>
                  <PdIcon name="trash" size={14} /> Delete
                </ConfirmButton>
                <div className="pd-grow" />
                {!sel.broken && (
                  <>
                    <button type="button" className="btn sm" onClick={() => startEdit(sel)}>
                      <PdIcon name="edit" size={14} /> Edit
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={async () => toast((await copyText(sel.code)) ? 'Copied to clipboard' : 'Could not copy', 'success')}
                    >
                      <PdIcon name="copy" size={14} /> Copy
                    </button>
                    {onInsert && (
                      <button type="button" className="btn sm primary" onClick={() => insert(sel)}>
                        <PdIcon name="insert" size={14} /> {insertLabel}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="pd-empty muted">
              <PdIcon name="snippet" size={28} />
              <p>Select a snippet, or create a new one.</p>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

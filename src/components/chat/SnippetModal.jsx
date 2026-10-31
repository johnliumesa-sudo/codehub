import { useEffect, useMemo, useRef, useState } from 'react';
import { SNIPPET_LANGUAGES, highlightCode, langFromFilename, sanitize } from '../../lib/markdown.js';
import { MAX_BODY_BYTES, validateBody } from '../../lib/messages.js';

const enc = new TextEncoder();

// "Share code snippet" dialog. Calls onSubmit({ text, code: { lang, content, filename? } }) -> Promise<boolean>.
export default function SnippetModal({ onClose, onSubmit, initial }) {
  const [filename, setFilename] = useState(initial?.filename || '');
  const [lang, setLang] = useState(initial?.lang || 'plaintext');
  const [langTouched, setLangTouched] = useState(!!initial?.lang);
  const [content, setContent] = useState(initial?.content || '');
  const [caption, setCaption] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const codeRef = useRef(null);

  useEffect(() => { codeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    if (langTouched) return;
    const l = langFromFilename(filename);
    if (l) setLang(l);
  }, [filename, langTouched]);

  const body = useMemo(() => {
    const b = { text: caption.trim(), code: { lang, content } };
    if (filename.trim()) b.code.filename = filename.trim();
    return b;
  }, [caption, lang, content, filename]);

  const size = useMemo(() => enc.encode(JSON.stringify(body)).length, [body]);
  const previewHtml = useMemo(() => (preview ? sanitize(highlightCode(content, lang)) : ''), [preview, content, lang]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!content.trim()) { setError('Paste some code first.'); return; }
    const v = validateBody(body);
    if (v) { setError(v); return; }
    setBusy(true);
    setError(null);
    const ok = await onSubmit(body);
    if (!ok) setBusy(false);
  };

  const onTab = (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const s = el.selectionStart;
      const next = `${content.slice(0, s)}  ${content.slice(el.selectionEnd)}`;
      setContent(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="modal snippet-modal" onSubmit={submit}>
        <h2>Share a code snippet</h2>
        <p className="muted small" style={{ marginTop: -6 }}>Encrypted end-to-end like every message.</p>
        <div className="snippet-modal-row">
          <label className="field" style={{ flex: 2 }}>
            Filename (optional)
            <input className="input" value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="e.g. utils.js" maxLength={200} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Language
            <select className="input" value={lang} onChange={(e) => { setLang(e.target.value); setLangTouched(true); }}>
              {SNIPPET_LANGUAGES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="snippet-modal-codehead">
            Code
            <span className="snippet-modal-tabs">
              <button type="button" className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Edit</button>
              <button type="button" className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Preview</button>
            </span>
          </span>
          {preview ? (
            <pre className="snippet-modal-preview"><code className="hljs" dangerouslySetInnerHTML={{ __html: previewHtml || '&nbsp;' }} /></pre>
          ) : (
            <textarea
              ref={codeRef}
              className="input snippet-modal-code"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={onTab}
              placeholder="Paste or type code…"
              spellCheck={false}
            />
          )}
        </label>
        <label className="field">
          Message (optional)
          <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Add a comment about this snippet" />
        </label>
        <div className="snippet-modal-foot">
          <span className={`muted small${size > MAX_BODY_BYTES ? ' error-text' : ''}`}>
            {(size / 1024).toFixed(1)} / {Math.floor(MAX_BODY_BYTES / 1024)} KB
          </span>
          {error && <span className="error-text">{error}</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !content.trim() || size > MAX_BODY_BYTES}>
            {busy ? 'Sending…' : 'Share snippet'}
          </button>
        </div>
      </form>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { highlightCode, languageLabel, sanitize } from '../../lib/markdown.js';

const COLLAPSE_LINES = 22;

// Renders a shared code snippet (message body `code` field) with highlighting, copy and collapse.
export default function CodeSnippet({ code, onCopied }) {
  const content = code?.content || '';
  const lines = useMemo(() => content.split('\n').length, [content]);
  const [expanded, setExpanded] = useState(lines <= COLLAPSE_LINES);
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => sanitize(highlightCode(content, code?.lang)), [content, code?.lang]);
  const gutter = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join('\n'), [lines]);

  const copy = () => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };

  return (
    <div className={`snippet${expanded ? '' : ' collapsed'}`}>
      <div className="snippet-head">
        <span className="snippet-file">
          <FileIcon />
          {code.filename || 'snippet'}
        </span>
        <span className="snippet-lang">{languageLabel(code.lang)}</span>
        <span className="snippet-lines">{lines} line{lines === 1 ? '' : 's'}</span>
        <button type="button" className={`md-copy${copied ? ' done' : ''}`} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="snippet-body">
        <pre className="snippet-gutter" aria-hidden="true">{gutter}</pre>
        {/* Sanitized: highlight.js output passed through DOMPurify. */}
        <pre className="snippet-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
      </div>
      {lines > COLLAPSE_LINES && (
        <button type="button" className="snippet-toggle" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Collapse' : `Show all ${lines} lines`}
        </button>
      )}
    </div>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" />
    </svg>
  );
}

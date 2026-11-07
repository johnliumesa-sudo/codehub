// A proposed change as a line diff (src/lib/collab/diff.js), rendered as React text with the collab
// diff styles. New and deleted files show every line; renames show the old and new path.
import { useMemo } from 'react';
import { diffLines, splitLines } from '../../../../lib/collab/diff.js';

const MAX_LINES = 400;

function Lines({ lines }) {
  const shown = lines.slice(0, MAX_LINES);
  return (
    <>
      {shown.map((l, j) => (
        <div key={j} className={`cx-dl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}`}>
          <span className="cx-ln">{l.oldNo ?? ''}</span>
          <span className="cx-ln">{l.newNo ?? ''}</span>
          <span className="cx-sign">{l.type}</span>
          <span className="cx-code">{l.text || ' '}</span>
        </div>
      ))}
      {lines.length > MAX_LINES && <div className="ag-diff-more">… {lines.length - MAX_LINES} more lines</div>}
    </>
  );
}

export default function DiffView({ change }) {
  const body = useMemo(() => {
    if (change.kind === 'rename') return { kind: 'rename' };
    if (change.kind === 'create' || change.kind === 'delete') {
      const add = change.kind === 'create';
      const text = add ? change.after : change.before;
      const lines = text === '' ? [] : splitLines(text).map((t, i) => ({ type: add ? '+' : '-', text: t, [add ? 'newNo' : 'oldNo']: i + 1 }));
      return { kind: 'whole', lines };
    }
    return { kind: 'diff', d: diffLines(change.before, change.after) };
  }, [change]);

  if (body.kind === 'rename') {
    return (
      <p className="ag-rename">
        <code>{change.path}</code> <span aria-hidden="true">→</span><span className="asst-sr">renamed to</span> <code>{change.newPath}</code>
      </p>
    );
  }
  if (body.kind === 'whole') {
    if (!body.lines.length) return <p className="ag-muted">(empty file)</p>;
    return (
      <div className="cx-diff ag-diff" role="region" aria-label={`${change.kind === 'create' ? 'New file' : 'Deleted file'} ${change.path}`} tabIndex={0}>
        <div className="cx-hunk"><Lines lines={body.lines} /></div>
      </div>
    );
  }
  const { d } = body;
  if (d.tooLarge) return <p className="ag-muted">The change is too large to show line by line.</p>;
  if (!d.hunks.length) return <p className="ag-muted">Only whitespace at the end of the file changes.</p>;
  return (
    <div className="cx-diff ag-diff" role="region" aria-label={`Changes to ${change.path}`} tabIndex={0}>
      {d.hunks.map((h, i) => (
        <div key={i} className="cx-hunk">
          <div className="cx-hunk-head">@@ −{h.oldStart} +{h.newStart} @@</div>
          <Lines lines={h.lines} />
        </div>
      ))}
    </div>
  );
}

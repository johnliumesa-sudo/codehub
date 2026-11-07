// Chat export panel (chatPanels): Markdown or JSON, all history / a date range / only what's loaded,
// decrypted in this browser and saved as a download, with progress and cancel. The file is plain
// text: the panel says so before anything is exported.
import { useEffect, useId, useRef, useState } from 'react';
import { collectRecords, downloadText, renderExport } from '../lib/exporter.js';
import { exportFilename } from '../lib/exportFormat.js';
import { convTitle } from './ChatBridge.jsx';

const dayStart = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime() : NaN;
};
const dayEnd = (v) => {
  const t = dayStart(v);
  return Number.isFinite(t) ? t + 86_400_000 - 1 : NaN;
};
const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function ExportPanel({ ctx }) {
  const [format, setFormat] = useState('markdown');
  const [range, setRange] = useState('all'); // all | dates | loaded
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayInput);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const abort = useRef(null);
  const ids = { fmt: useId(), range: useId(), from: useId(), to: useId() };
  const title = convTitle(ctx.conv);

  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    setError('');
    setResult('');
    let lo;
    let hi;
    if (range === 'dates') {
      lo = from ? dayStart(from) : undefined;
      hi = to ? dayEnd(to) : undefined;
      if ((from && !Number.isFinite(lo)) || (to && !Number.isFinite(hi))) {
        setError('Enter valid dates.');
        return;
      }
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) {
        setError('The start date is after the end date.');
        return;
      }
    }
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setProgress({ fetched: 0, decrypted: 0, phase: 'fetch' });
    try {
      const records = await collectRecords(ctx.conv, {
        from: lo,
        to: hi,
        loaded: range === 'loaded' ? ctx.messages : undefined,
        profiles: ctx.profiles,
        signal: ac.signal,
        onProgress: (p) => !ac.signal.aborted && setProgress(p),
      });
      if (ac.signal.aborted) return;
      const exportedAt = Date.now();
      const out = renderExport(records, format, {
        title,
        kind: ctx.conv.kind,
        exportedAt,
        exportedBy: ctx.me?.name || '',
        range: { from: lo, to: hi },
      });
      downloadText(out.text, exportFilename(ctx.conv.name || title, out.ext, exportedAt), out.mime);
      setResult(`Exported ${records.length} message${records.length === 1 ? '' : 's'}.`);
    } catch (e) {
      if (e?.name === 'AbortError') setResult('Export cancelled.');
      else setError(e?.message || 'Export failed');
    } finally {
      if (abort.current === ac) abort.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  const pct = progress && progress.fetched ? Math.round((progress.decrypted / progress.fetched) * 100) : 0;
  return (
    <div className="mx-export">
      <p className="mx-export-warn" role="note">
        <strong>The exported file is not encrypted.</strong> Messages are decrypted in this browser and saved as plain text.
        Anyone who gets the file can read the conversation.
      </p>
      <fieldset className="mx-export-group" disabled={busy}>
        <legend>Format</legend>
        <label className="mx-export-opt"><input type="radio" name={ids.fmt} value="markdown" checked={format === 'markdown'} onChange={() => setFormat('markdown')} /> Markdown (.md)</label>
        <label className="mx-export-opt"><input type="radio" name={ids.fmt} value="json" checked={format === 'json'} onChange={() => setFormat('json')} /> JSON (.json)</label>
      </fieldset>
      <fieldset className="mx-export-group" disabled={busy}>
        <legend>Messages</legend>
        <label className="mx-export-opt"><input type="radio" name={ids.range} value="all" checked={range === 'all'} onChange={() => setRange('all')} /> Whole history</label>
        <label className="mx-export-opt"><input type="radio" name={ids.range} value="dates" checked={range === 'dates'} onChange={() => setRange('dates')} /> Date range</label>
        {range === 'dates' && (
          <div className="mx-export-dates">
            <label htmlFor={ids.from}>From</label>
            <input id={ids.from} className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <label htmlFor={ids.to}>To</label>
            <input id={ids.to} className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        <label className="mx-export-opt"><input type="radio" name={ids.range} value="loaded" checked={range === 'loaded'} onChange={() => setRange('loaded')} /> Only the {ctx.messages.length} loaded message{ctx.messages.length === 1 ? '' : 's'}</label>
      </fieldset>
      <div className="mx-export-actions">
        {busy ? (
          <button type="button" className="btn" onClick={() => abort.current?.abort()}>Cancel</button>
        ) : (
          <button type="button" className="btn primary" onClick={run}>Export unencrypted file</button>
        )}
      </div>
      {busy && progress && (
        <div className="mx-export-progress">
          <div className="mx-rec-progress" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.phase === 'fetch' ? undefined : pct}>
            <span style={{ width: progress.phase === 'fetch' ? '15%' : `${pct}%` }} className={progress.phase === 'fetch' ? 'indeterminate' : ''} />
          </div>
          <p className="muted small" role="status">
            {progress.phase === 'fetch' ? `Loading history… ${progress.fetched} messages` : `Decrypting ${progress.decrypted} of ${progress.fetched}…`}
          </p>
        </div>
      )}
      {result && <p className="mx-export-done" role="status">{result}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted small">Images and voice messages are listed but not included. Up to 20,000 messages per export.</p>
    </div>
  );
}
